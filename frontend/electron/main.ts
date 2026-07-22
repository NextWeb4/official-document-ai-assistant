/*
 * This file is part of HaoXiang Document Assistant.
 * Modifications (c) 2026 HaoXiang Huang (https://nextweb4.github.io/)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
/**
 * Electron Main Process
 *
 * 负责：
 * - 启动 Python 后端
 * - 创建 BrowserWindow
 * - 管理应用生命周期（含系统托盘）
 * - 处理 IPC 通信
 */
import { app, BrowserWindow, shell, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as url from 'url';
import * as http from 'http';
import * as fs from 'fs';

const isDev = !app.isPackaged;
const configuredPort = Number(process.env.API_PORT);
const BACKEND_PORT = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
  ? configuredPort
  : 8765;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const BACKEND_APP_ID = 'official-document-ai-assistant';
const APP_NAME = 'HaoXiang Document Assistant';
const APP_USER_MODEL_ID = 'io.github.nextweb4.official-document-assistant';
const AUTHOR_WEBSITE_HOST = 'nextweb4.github.io';
const AUTHOR_EMAIL = 'rays688888@gmail.com';
type AppMode = 'online' | 'offline';
type BackendHealth = {
  running: boolean;
  portOccupied: boolean;
  appId?: string;
  version?: string;
  appMode?: AppMode;
};

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let backendStartedByUs = false;
let isQuitting = false;
let cachedAppMode: AppMode | null = null;

// ---------------------------------------------------------------------------
//  Single instance lock — 防止多开
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二个实例启动时，聚焦到已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
//  Logging
// ---------------------------------------------------------------------------

function getLogPath(): string {
  const logDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, 'electron.log');
}

function log(level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  console.log(line.trim());
  try { fs.appendFileSync(getLogPath(), line); } catch {}
}

// ---------------------------------------------------------------------------
//  Icon helper — 统一图标路径，Windows 使用 .ico
// ---------------------------------------------------------------------------

function getIconPath(): string {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'build', 'icon.png');
  }
  return path.join(process.resourcesPath, 'icon.png');
}

function getAppMode(): AppMode {
  if (cachedAppMode) return cachedAppMode;

  const envMode = (process.env.APP_MODE || '').toLowerCase();
  if (envMode === 'offline') {
    cachedAppMode = 'offline';
    return cachedAppMode;
  }

  if (!isDev) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf-8'),
      ) as { appMode?: string };
      cachedAppMode = packageJson.appMode === 'offline' ? 'offline' : 'online';
      return cachedAppMode;
    } catch (err) {
      log('WARN', `Failed to read appMode from package.json: ${err}`);
    }
  }

  cachedAppMode = 'offline';
  return cachedAppMode;
}

// ---------------------------------------------------------------------------
//  Backend lifecycle
// ---------------------------------------------------------------------------

function findPython(): string {
  // 1. 尝试常见路径
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'C:\\Python314\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${cmd} ${c}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split(/\r?\n/)[0];
      if (result && fs.existsSync(result)) return result;
    } catch {}
  }
  // 2. 直接检查常见安装路径
  const commonPaths = process.platform === 'win32'
    ? ['C:\\Python314\\python.exe', 'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
       `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python314\\python.exe`,
       `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`]
    : ['/usr/bin/python3', '/usr/local/bin/python3'];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function getBackendCommand(): { cmd: string; args: string[] } {
  if (isDev) {
    const pythonCmd = findPython();
    const script = path.join(__dirname, '..', '..', '..', 'backend', 'main.py');
    return { cmd: pythonCmd, args: [script, '--force'] };
  }
  // 生产模式：直接启动 PyInstaller 打包的二进制，--force 自动释放残留端口
  const ext = process.platform === 'win32' ? '.exe' : '';
  const backendExe = path.join(process.resourcesPath, 'backend_server', `backend_server${ext}`);
  return { cmd: backendExe, args: ['--force'] };
}

function startBackend(): void {
  const { cmd, args } = getBackendCommand();

  log('INFO', `Starting backend: ${cmd} ${args.join(' ')}`);

  if (!fs.existsSync(cmd)) {
    log('ERROR', `Backend executable not found: ${cmd}`);
    dialog.showErrorBox('启动错误', `找不到后端程序：\n${cmd}`);
    return;
  }

  const spawnOptions: Record<string, unknown> = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };

  // 所有模式都需要 UTF-8 和无缓冲输出
  spawnOptions.env = {
    ...process.env,
    APP_MODE: getAppMode(),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };

  if (isDev) {
    // 开发模式：cwd 设为 backend 目录
    spawnOptions.cwd = path.dirname(args[0]);
  } else {
    // 生产模式：传递 APP_DATA_DIR 给后端，使运行时数据写入用户目录
    // 而非 Program Files 安装目录
    (spawnOptions.env as Record<string, string>)['APP_DATA_DIR'] = app.getPath('userData');
  }

  const child = spawn(cmd, args, spawnOptions);
  backendProcess = child;

  backendStartedByUs = true;

  child.stdout?.on('data', (data: Buffer) => {
    log('BACKEND', data.toString().trim());
  });

  child.stderr?.on('data', (data: Buffer) => {
    log('BACKEND-ERR', data.toString().trim());
  });

  child.on('exit', (code: number | null) => {
    log('INFO', `Backend exited with code ${code}`);
    if (backendProcess === child) {
      backendProcess = null;
    }
    if (code !== 0 && code !== null && !isQuitting) {
      dialog.showErrorBox(
        '后端服务异常',
        `后端服务已退出（错误码 ${code}）。\n日志：${getLogPath()}`
      );
    }
  });

  child.on('error', (err: Error) => {
    log('ERROR', `Failed to start backend: ${err.message}`);
    if (backendProcess === child) {
      backendProcess = null;
    }
  });
}

/**
 * 强制终止后端进程树（Windows 下 kill 子进程）
 */
function stopBackend(): void {
  if (!backendProcess) return;

  const processToStop = backendProcess;
  backendProcess = null;
  const pid = processToStop.pid;
  log('INFO', `Stopping backend (pid=${pid})...`);

  // 先尝试优雅关闭
  processToStop.kill('SIGTERM');

  // Windows：3秒后用 taskkill 强制终止整个进程树
  setTimeout(() => {
    if (processToStop.exitCode === null && processToStop.signalCode === null) {
      log('WARN', `Force killing backend process tree (pid=${pid})`);
      try {
        if (process.platform === 'win32' && pid) {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
          processToStop.kill('SIGKILL');
        }
      } catch (e) {
        log('ERROR', `Failed to kill backend: ${e}`);
      }
    }
  }, 3000);
}

async function isBackendRunning(): Promise<boolean> {
  return isCompatibleBackendHealth(await getBackendHealth());
}

function waitForBackend(maxWaitMs: number = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const expectedMode = getAppMode();
    const expectedVersion = app.getVersion();
    const check = async () => {
      const health = await getBackendHealth();
      if (isCompatibleBackendHealth(health, expectedMode, expectedVersion)) {
        log('INFO', `Backend ${expectedVersion} is ready in ${expectedMode} mode`);
        resolve(true);
      } else if (health.portOccupied) {
        log('ERROR', `Backend identity mismatch while waiting: ${describeBackendHealth(health)}`);
        resolve(false);
      } else {
        retry();
      }
    };
    const retry = () => {
      if (Date.now() - startTime > maxWaitMs) {
        log('ERROR', `Backend did not start within ${maxWaitMs}ms`);
        resolve(false);
      } else {
        setTimeout(check, 500);
      }
    };
    void check();
  });
}

// ---------------------------------------------------------------------------
//  Frontend URL
// ---------------------------------------------------------------------------

function getFrontendUrl(): string {
  if (isDev) {
    return 'http://localhost:5173';
  }
  const appPath = app.getAppPath();
  const indexPath = path.join(appPath, 'dist', 'index.html');

  log('INFO', `appPath: ${appPath}`);
  log('INFO', `indexPath: ${indexPath} exists=${fs.existsSync(indexPath)}`);

  return url.format({
    pathname: indexPath,
    protocol: 'file:',
    slashes: true,
  });
}

async function getBackendHealth(): Promise<BackendHealth> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (health: BackendHealth) => {
      if (settled) return;
      settled = true;
      resolve(health);
    };
    const req = http.get(`${BACKEND_URL}/api/health`, (res) => {
      connected = true;
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish({ running: false, portOccupied: true });
          return;
        }
        try {
          const parsed = JSON.parse(body) as {
            status?: string;
            app_id?: string;
            version?: string;
            app_mode?: string;
          };
          const appMode = parsed.app_mode === 'offline' || parsed.app_mode === 'online'
            ? parsed.app_mode
            : undefined;
          const appId = typeof parsed.app_id === 'string' ? parsed.app_id : undefined;
          const version = typeof parsed.version === 'string' ? parsed.version : undefined;
          const running = parsed.status === 'ok'
            && appId === BACKEND_APP_ID
            && version !== undefined
            && appMode !== undefined;
          finish({ running, portOccupied: true, appId, version, appMode });
        } catch {
          finish({ running: false, portOccupied: true });
        }
      });
    });
    req.on('socket', (socket) => {
      socket.once('connect', () => { connected = true; });
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        running: false,
        portOccupied: connected || error.code !== 'ECONNREFUSED',
      });
    });
    req.setTimeout(2000, () => {
      finish({ running: false, portOccupied: true });
      req.destroy(new Error('Backend health check timed out'));
    });
    req.end();
  });
}

function isCompatibleBackendHealth(
  health: BackendHealth,
  expectedMode: AppMode = getAppMode(),
  expectedVersion: string = app.getVersion(),
): boolean {
  return health.running
    && health.appId === BACKEND_APP_ID
    && health.version === expectedVersion
    && health.appMode === expectedMode;
}

function describeBackendHealth(health: BackendHealth): string {
  return [
    `app_id=${health.appId || 'unknown'}`,
    `version=${health.version || 'unknown'}`,
    `app_mode=${health.appMode || 'unknown'}`,
  ].join(', ');
}

function isAllowedExternalUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (getAppMode() === 'offline') {
      return (parsed.protocol === 'https:' && parsed.hostname === AUTHOR_WEBSITE_HOST)
        || (parsed.protocol === 'mailto:' && parsed.pathname.toLowerCase() === AUTHOR_EMAIL);
    }
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isTrustedRendererUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (isDev) {
      return parsed.protocol === 'http:'
        && parsed.hostname === 'localhost'
        && parsed.port === '5173';
    }

    if (parsed.protocol !== 'file:') return false;
    const expectedPath = path.resolve(app.getAppPath(), 'dist', 'index.html');
    const actualPath = path.resolve(url.fileURLToPath(parsed));
    return process.platform === 'win32'
      ? actualPath.toLowerCase() === expectedPath.toLowerCase()
      : actualPath === expectedPath;
  } catch {
    return false;
  }
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  const trustedWindow = mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === event.sender.mainFrame;
  if (!trustedWindow || !isTrustedRendererUrl(senderUrl)) {
    log('WARN', `Blocked IPC from untrusted renderer: ${senderUrl || 'unknown'}`);
    throw new Error('Untrusted IPC sender');
  }
}

// ---------------------------------------------------------------------------
//  System Tray
// ---------------------------------------------------------------------------

function createTray(): void {
  try {
    const iconPath = getIconPath();
    let trayIcon: Electron.NativeImage;

    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
      const iconSize = 16;
      const canvas = Buffer.alloc(iconSize * iconSize * 4);
      for (let i = 0; i < iconSize * iconSize; i++) {
        canvas[i * 4] = 0;
        canvas[i * 4 + 1] = 120;
        canvas[i * 4 + 2] = 215;
        canvas[i * 4 + 3] = 255;
      }
      trayIcon = nativeImage.createFromBuffer(canvas, { width: iconSize, height: iconSize });
    }

    tray = new Tray(trayIcon);
    tray.setToolTip(APP_NAME);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitApp();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    tray = null;
    log('WARN', `System tray unavailable; continuing without it: ${err}`);
  }
}

// ---------------------------------------------------------------------------
//  完全退出程序
// ---------------------------------------------------------------------------

function quitApp(): void {
  isQuitting = true;
  log('INFO', 'User requested quit');
  stopBackend();
  app.quit();
}

// ---------------------------------------------------------------------------
//  Window
// ---------------------------------------------------------------------------

async function createWindow(): Promise<void> {
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  // 外部链接用默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const guardTopLevelNavigation = (event: Electron.Event, navigationUrl: string) => {
    if (isTrustedRendererUrl(navigationUrl)) return;
    event.preventDefault();
    log('WARN', `Blocked top-level navigation to ${navigationUrl}`);
    if (isAllowedExternalUrl(navigationUrl)) {
      void shell.openExternal(navigationUrl);
    }
  };
  mainWindow.webContents.on('will-navigate', guardTopLevelNavigation);
  mainWindow.webContents.on('will-redirect', guardTopLevelNavigation);

  let windowShown = false;
  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || windowShown) return;
    windowShown = true;
    mainWindow.show();
    mainWindow.focus();
    log('INFO', 'Window shown');
  };

  // Register visibility handlers before loading. ready-to-show can fire before
  // loadURL resolves, especially on older Chromium builds used by Debian 10.
  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.webContents.once('did-finish-load', showMainWindow);
  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    log('ERROR', `Frontend load failed (${code}): ${description}; url=${validatedUrl}`);
  });

  // 加载前端
  const frontendUrl = getFrontendUrl();
  log('INFO', `Loading frontend: ${frontendUrl}`);
  try {
    await mainWindow.loadURL(frontendUrl);
  } catch (err) {
    log('ERROR', `Failed to load frontend: ${err}`);
    dialog.showErrorBox('界面加载失败', `无法加载公文校准界面。\n日志：${getLogPath()}`);
    mainWindow.destroy();
    mainWindow = null;
    throw err;
  }
  showMainWindow();

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // 关闭时询问：最小化到托盘 or 退出程序
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (!tray) {
        log('INFO', 'System tray unavailable; closing application instead of hiding window');
        quitApp();
        return;
      }
      const choice = dialog.showMessageBoxSync(mainWindow!, {
        type: 'question',
        buttons: ['最小化到托盘', '退出程序'],
        defaultId: 0,
        cancelId: 0,
        title: '关闭确认',
        message: '请选择操作',
      });
      if (choice === 1) {
        quitApp();
      } else {
        mainWindow?.hide();
        log('INFO', 'Window minimized to tray');
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
//  IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('get-app-info', (event) => {
  assertTrustedIpcSender(event);
  return {
    version: app.getVersion(),
    platform: process.platform,
    isDev,
    appMode: getAppMode(),
    backendPort: BACKEND_PORT,
    backendUrl: BACKEND_URL,
    logPath: getLogPath(),
  };
});

ipcMain.handle('get-backend-status', async (event) => {
  assertTrustedIpcSender(event);
  const running = await isBackendRunning();
  return {
    status: running ? 'running' : 'stopped',
    startedByUs: backendStartedByUs,
    url: BACKEND_URL,
  };
});

ipcMain.handle('get-api-base-url', (event) => {
  assertTrustedIpcSender(event);
  return BACKEND_URL;
});

// ---------------------------------------------------------------------------
//  App lifecycle
// ---------------------------------------------------------------------------

app.on('ready', async () => {
  try {
    log('INFO', `App ready. isDev=${isDev}, appMode=${getAppMode()}, platform=${process.platform}, resourcesPath=${process.resourcesPath}`);
    log('INFO', `Icon path: ${getIconPath()} exists=${fs.existsSync(getIconPath())}`);

    // 移除默认英文菜单栏（File/Edit/View/Window/Help）
    Menu.setApplicationMenu(null);

    // 系统托盘在部分 Debian 桌面环境不可用，不应阻断主窗口。
    createTray();

    // 检查后端是否已在运行，并确保离线/联网模式匹配当前包
    const backendHealth = await getBackendHealth();
    const alreadyRunning = isCompatibleBackendHealth(backendHealth);

    if (alreadyRunning) {
      log('INFO', `Compatible backend already running: ${describeBackendHealth(backendHealth)}`);
    } else if (backendHealth.portOccupied) {
      const actualIdentity = describeBackendHealth(backendHealth);
      const expectedIdentity = `app_id=${BACKEND_APP_ID}, version=${app.getVersion()}, app_mode=${getAppMode()}`;
      log('ERROR', `Refusing to replace unverified or incompatible port owner: ${actualIdentity}`);
      dialog.showErrorBox(
        '端口冲突',
        `端口 ${BACKEND_PORT} 已被其他或不兼容的服务占用。\n`
        + `检测到：${actualIdentity}\n期望：${expectedIdentity}\n\n`
        + '为避免终止其他进程，应用已停止启动。请先关闭占用该端口的程序。',
      );
      app.quit();
      return;
    } else {
      startBackend();
      const ready = await waitForBackend();
      if (!ready) {
        log('ERROR', 'Backend failed to start');
        const choice = dialog.showMessageBoxSync({
          type: 'error',
          title: '启动失败',
          message: 'Python 后端服务启动超时。',
          detail: `日志：${getLogPath()}\n\n可能原因：\n1. 后端文件缺失或不可执行\n2. 端口 8765 被占用\n3. 系统运行库缺失`,
          buttons: ['重试', '退出'],
          defaultId: 0,
        });
        if (choice === 0) {
          startBackend();
          const ready2 = await waitForBackend();
          if (!ready2) {
            app.quit();
            return;
          }
        } else {
          app.quit();
          return;
        }
      }
    }

    await createWindow();
  } catch (err) {
    log('ERROR', `Application startup failed: ${err}`);
    dialog.showErrorBox('应用启动失败', `公文校准软件未能启动。\n日志：${getLogPath()}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // 所有窗口关闭时直接退出
  log('INFO', 'All windows closed, quitting');
  quitApp();
});

app.on('activate', async () => {
  if (mainWindow === null) {
    await createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});
