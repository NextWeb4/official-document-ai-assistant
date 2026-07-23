import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(FRONTEND_DIR, '..');
const PACKAGE_PATH = path.join(FRONTEND_DIR, 'package.json');
const DEBIAN_ELECTRON_VERSION = '18.3.15';
const DEBIAN_RUNTIME_DEPENDS = [
  'libc6',
  'libgcc1 | libgcc-s1',
  'libglib2.0-0',
  'libnspr4',
  'libnss3',
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libcups2',
  'libdbus-1-3',
  'libdrm2',
  'libgtk-3-0',
  'libpango-1.0-0',
  'libcairo2',
  'libx11-6',
  'libx11-xcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxrandr2',
  'libxshmfence1',
  'libgbm1',
  'libexpat1',
  'libxcb1',
  'libxkbcommon0',
  'libasound2',
  'libudev1',
  'libnotify4',
  'libxss1',
  'libxtst6',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
  'xdg-utils',
];

function parseListArg(name, fallback) {
  const prefix = `--${name}`;
  const argv = process.argv.slice(2);
  const inline = argv.findLast((item) => item.startsWith(`${prefix}=`));
  if (inline) return inline.slice(prefix.length + 1).split(',').filter(Boolean);
  const index = argv.lastIndexOf(prefix);
  if (index >= 0 && argv[index + 1]) return argv[index + 1].split(',').filter(Boolean);
  return fallback;
}

function run(cmd, args, options = {}) {
  console.log(`>>> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || FRONTEND_DIR,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(' ')}`);
  }
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function nativeArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'arm') return 'armv7l';
  return process.arch;
}

function modeLabel(mode) {
  return mode === 'online' ? 'Online' : 'Offline';
}

function updatePackage(basePackage, mode, platform, arch = 'x64') {
  const pkg = structuredClone(basePackage);
  const label = modeLabel(mode);
  const displayName = `${basePackage.build.productName} ${label}`;
  pkg.appMode = mode;
  pkg.build = structuredClone(basePackage.build);
  if (platform === 'linux') {
    pkg.build.electronVersion = DEBIAN_ELECTRON_VERSION;
  } else {
    delete pkg.build.electronVersion;
    pkg.build.electronDist = path.join(FRONTEND_DIR, 'node_modules', 'electron', 'dist');
  }
  pkg.build.appId = `${basePackage.build.appId}.${mode}`;
  pkg.build.productName = platform === 'linux'
    ? `official-document-ai-assistant-${mode}`
    : displayName;
  pkg.build.directories = {
    ...pkg.build.directories,
    output: platform === 'win' ? `release/${mode}-windows` : `release/${mode}-debian`,
  };

  pkg.build.win = {
    ...pkg.build.win,
    target: ['nsis', 'msi'],
    executableName: `official-document-ai-assistant-${mode}`,
    artifactName: `official-document-ai-assistant-${mode}-${pkg.version}-${arch}.\${ext}`,
  };
  pkg.build.nsis = {
    ...pkg.build.nsis,
    shortcutName: `HaoXiang Document Assistant ${label}`,
    artifactName: `official-document-ai-assistant-${mode}-${pkg.version}-${arch}.\${ext}`,
  };
  pkg.build.msi = {
    artifactName: `official-document-ai-assistant-${mode}-${pkg.version}-${arch}.\${ext}`,
  };
  pkg.build.linux = {
    ...pkg.build.linux,
    target: ['deb'],
    executableName: `official-document-ai-assistant-${mode}`,
    artifactName: `official-document-ai-assistant-${mode}-${pkg.version}-${arch}.\${ext}`,
    desktop: {
      ...pkg.build.linux?.desktop,
      entry: {
        ...pkg.build.linux?.desktop?.entry,
        Name: displayName,
      },
    },
  };
  pkg.build.deb = {
    ...pkg.build.deb,
    packageName: `official-document-ai-assistant-${mode}`,
    depends: [...DEBIAN_RUNTIME_DEPENDS],
  };
  delete pkg.build.deb.fpm;
  return pkg;
}

function buildFrontend() {
  run(command('npm'), ['run', 'build']);
  run(command('npm'), ['run', 'electron:compile']);
}

function buildBackendFor(platform, arch) {
  if (platform === 'win') {
    if (process.platform !== 'win32') {
      throw new Error('Windows installers must be built on Windows so PyInstaller emits backend_server.exe.');
    }
    run('python', ['build_backend.py'], { cwd: PROJECT_ROOT });
    return;
  }

  if (platform === 'linux') {
    if (process.platform !== 'linux') {
      throw new Error('Debian .deb packages must be built on Linux so PyInstaller emits a Linux backend binary.');
    }
    if (arch !== nativeArch()) {
      throw new Error(`Debian ${arch} package must be built on matching ${arch} Linux hardware or an equivalent native builder.`);
    }
    run('python3', ['build_backend.py'], { cwd: PROJECT_ROOT });
  }
}

function buildElectron(mode, platform, arch) {
  const env = { APP_MODE: mode };
  if (platform === 'win') {
    run(command('npx'), ['electron-builder', '--win', `--${arch}`, '--publish=never'], { env });
    return;
  }
  if (platform === 'linux') {
    run(command('npx'), ['electron-builder', '--linux', `--${arch}`, '--publish=never'], { env });
  }
}

function cleanPackageOutput(mode, platform) {
  const suffix = platform === 'win' ? 'windows' : 'debian';
  rmSync(path.join(FRONTEND_DIR, 'release', `${mode}-${suffix}`), {
    recursive: true,
    force: true,
  });
}

const modes = parseListArg('modes', ['offline', 'online']);
const platforms = parseListArg('platform', ['win']);
const archs = parseListArg(
  'arch',
  platforms.includes('linux') ? [nativeArch()] : ['x64'],
);
const basePackage = JSON.parse(readFileSync(PACKAGE_PATH, 'utf-8'));

try {
  buildFrontend();

  for (const platformName of platforms) {
    for (const mode of modes) {
      cleanPackageOutput(mode, platformName);
      const targetArchs = platformName === 'linux' ? archs : ['x64'];
      for (const arch of targetArchs) {
        console.log(`\n=== Building ${mode} ${platformName} ${arch} ===`);
        const updated = updatePackage(basePackage, mode, platformName, arch);
        writeFileSync(PACKAGE_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
        buildBackendFor(platformName, arch);
        buildElectron(mode, platformName, arch);
      }
    }
  }
} finally {
  writeFileSync(PACKAGE_PATH, `${JSON.stringify(basePackage, null, 2)}\n`, 'utf-8');
}
