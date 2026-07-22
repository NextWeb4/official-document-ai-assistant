import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const root = path.resolve(import.meta.dirname, '..', '..');
const frontend = path.join(root, 'frontend');
const release = path.join(frontend, 'release');
const DEBIAN_ELECTRON_VERSION = '18.3.15';
const DEBIAN_GLIBC_CEILING = '2.28';
const DEBIAN10_UNAVAILABLE_SONAMES = [
  'libcrypto.so.3',
  'libffi.so.8',
  'libssl.so.3',
];
const version = JSON.parse(
  readFileSync(path.join(frontend, 'package.json'), 'utf-8'),
).version;

function requireFile(file) {
  if (!existsSync(file)) {
    throw new Error(`Missing artifact: ${file}`);
  }
  return statSync(file).size;
}

function listFujianYaml(dir) {
  return readdirSync(dir).filter((name) => /^fujian.*\.yaml$/.test(name)).sort();
}

export function verifyAppMetadata(pkg, file, expectedMode) {
  const expectedAuthor = {
    name: 'HaoXiang Huang',
    email: 'Rays688888@Gmail.com',
    url: 'https://nextweb4.github.io/',
  };
  if (pkg.name !== 'official-document-ai-assistant') {
    throw new Error(`${file} has unexpected package name: ${pkg.name}`);
  }
  for (const [field, expected] of Object.entries(expectedAuthor)) {
    if (pkg.author?.[field] !== expected) {
      throw new Error(`${file} has unexpected author ${field}: ${pkg.author?.[field]}`);
    }
  }
  if (pkg.homepage !== expectedAuthor.url) {
    throw new Error(`${file} has unexpected homepage: ${pkg.homepage}`);
  }
  if (pkg.appMode !== expectedMode) {
    throw new Error(`${file} has appMode=${pkg.appMode}, expected ${expectedMode}`);
  }
}

function verifyWindows(mode) {
  const base = path.join(release, `${mode}-windows`);
  const exe = path.join(base, `official-document-ai-assistant-${mode}-${version}-x64.exe`);
  const msi = path.join(base, `official-document-ai-assistant-${mode}-${version}-x64.msi`);
  const unpacked = path.join(base, 'win-unpacked');
  const resources = path.join(unpacked, 'resources');
  const appAsar = path.join(resources, 'app.asar');

  const exeSize = requireFile(exe);
  const msiSize = requireFile(msi);
  requireFile(appAsar);
  if (existsSync(path.join(resources, 'default_app.asar'))) {
    throw new Error(`${mode} package still contains Electron default_app.asar`);
  }

  const pkg = JSON.parse(asar.extractFile(appAsar, 'package.json').toString('utf-8'));
  verifyAppMetadata(pkg, `${mode} app.asar`, mode);

  const bundledFonts = readdirSync(unpacked, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /\.(ttf|otf|ttc)$/i.test(entry));
  if (bundledFonts.length > 0) {
    throw new Error(`${mode} package contains bundled font files: ${bundledFonts.join(',')}`);
  }

  const rules = listFujianYaml(path.join(resources, 'rules', 'official'));
  const templates = listFujianYaml(path.join(resources, 'templates', 'official'));
  if (rules.join(',') !== 'fujian_province.yaml') {
    throw new Error(`${mode} package has unexpected Fujian rules: ${rules.join(',')}`);
  }
  if (templates.join(',') !== 'fujian_province.yaml') {
    throw new Error(`${mode} package has unexpected Fujian templates: ${templates.join(',')}`);
  }

  const locales = readdirSync(path.join(unpacked, 'locales')).sort();
  if (locales.join(',') !== 'en-US.pak,zh-CN.pak') {
    throw new Error(`${mode} package has unexpected locales: ${locales.join(',')}`);
  }

  console.log(`windows ${mode}: exe=${exeSize} msi=${msiSize} appMode=${pkg.appMode}`);
}

function readArMembers(file) {
  const data = readFileSync(file);
  if (data.subarray(0, 8).toString('ascii') !== '!<arch>\n') {
    throw new Error(`Not an ar archive: ${file}`);
  }
  const members = new Map();
  let offset = 8;
  while (offset < data.length) {
    const header = data.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
    const size = Number.parseInt(header.subarray(48, 58).toString('ascii').trim(), 10);
    offset += 60;
    members.set(name, data.subarray(offset, offset + size));
    offset += size + (size % 2);
  }
  return members;
}

function listTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const names = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeOctal || '0', 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const entryName = longName ?? (prefix ? `${prefix}/${name}` : name);
    if (name === '././@LongLink') {
      longName = tar.subarray(bodyStart, bodyEnd).toString('utf-8').replace(/\0.*$/, '');
    } else {
      names.push(entryName);
      longName = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function findTarGzEntriesInfo(buffer, wantedNames) {
  const tar = gunzipSync(buffer);
  const wanted = new Set(wantedNames);
  const found = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeOctal || '0', 8);
    const modeOctal = header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim();
    const mode = Number.parseInt(modeOctal || '0', 8);
    const type = header.subarray(156, 157).toString('ascii').replace('\0', '') || '0';
    const linkName = header.subarray(157, 257).toString('utf-8').replace(/\0.*$/, '');
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const entryName = longName ?? (prefix ? `${prefix}/${name}` : name);
    if (name === '././@LongLink') {
      longName = tar.subarray(bodyStart, bodyEnd).toString('utf-8').replace(/\0.*$/, '');
    } else {
      if (wanted.has(entryName)) {
        found.set(entryName, { body: tar.subarray(bodyStart, bodyEnd), mode, type, linkName });
        if (found.size === wanted.size) return found;
      }
      longName = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const missing = [...wanted].filter((name) => !found.has(name));
  throw new Error(`Missing ${missing.join(', ')}`);
}

function findTarGzEntryInfo(buffer, wantedName) {
  return findTarGzEntriesInfo(buffer, [wantedName]).get(wantedName);
}

function findTarGzEntry(buffer, wantedName) {
  return findTarGzEntryInfo(buffer, wantedName).body;
}

function basename(file) {
  return file.split('/').pop();
}

function inspectAppAsar(buffer, file, expectedMode) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'official-document-ai-assistant-app-asar-'));
  const archive = path.join(tempDir, 'app.asar');
  try {
    writeFileSync(archive, buffer);
    const archivePath = (value) => path.join(...value.split('/'));
    const pkg = JSON.parse(asar.extractFile(archive, archivePath('package.json')).toString('utf-8'));
    verifyAppMetadata(pkg, file, expectedMode);
    if (pkg.main !== 'electron/dist/main.js') {
      throw new Error(`Unexpected Electron main entry in ${file}: ${pkg.main}`);
    }
    for (const requiredPath of ['dist/index.html', 'electron/dist/main.js', 'electron/dist/preload.js']) {
      if (asar.extractFile(archive, archivePath(requiredPath)).length === 0) {
        throw new Error(`Empty ${requiredPath} in ${file}`);
      }
    }
    const electronMain = asar.extractFile(
      archive,
      archivePath('electron/dist/main.js'),
    ).toString('utf-8');
    for (const marker of [
      'Backend health check timed out',
      ' is ready in ',
      'System tray unavailable; continuing without it',
      'Window shown',
    ]) {
      if (!electronMain.includes(marker)) {
        throw new Error(`Debian app.asar is missing startup fix marker in ${file}: ${marker}`);
      }
    }
    return pkg;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function verifyNoFontArchiveEntries(entries, file) {
  const bundledFonts = entries.filter((entry) => /\.(ttf|otf|ttc)$/i.test(entry));
  if (bundledFonts.length > 0) {
    throw new Error(`${file} contains bundled font files: ${bundledFonts.join(',')}`);
  }
  return true;
}

export function verifyPosixLauncher(entry, file, expectedTarget) {
  let targets;
  if (entry.type === '2') {
    targets = [entry.linkName];
  } else {
    const launcher = entry.body.toString('utf-8');
    targets = launcher
      .split(/\r?\n/)
      .filter((line) => /^\s*exec\s+/.test(line))
      .map((line) => line.match(/^\s*exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/))
      .map((match) => match?.[1] ?? match?.[2] ?? match?.[3])
      .filter(Boolean);
  }

  if (targets.length === 0) {
    throw new Error(`Launcher has no executable target in ${file}`);
  }
  for (const target of targets) {
    if (target.includes('\\')) {
      throw new Error(`Launcher target contains a backslash in ${file}: ${target}`);
    }
    if (!target.startsWith('/opt/')) {
      throw new Error(`Launcher must use an absolute /opt POSIX path in ${file}`);
    }
    if (target !== expectedTarget) {
      throw new Error(`Unexpected launcher target in ${file}: ${target}`);
    }
  }
  return expectedTarget;
}

function verifyElfMachine(buffer, file, expectedClass, expectedMachine) {
  if (buffer.length < 20 || buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
    throw new Error(`Not an ELF binary: ${file}`);
  }
  const elfClass = buffer[4];
  const endian = buffer[5];
  if (endian !== 1) {
    throw new Error(`Unsupported ELF endian in ${file}`);
  }
  const machine = buffer.readUInt16LE(18);
  if (elfClass !== expectedClass || machine !== expectedMachine) {
    throw new Error(`Unexpected ELF machine in ${file}: class=${elfClass} machine=${machine}`);
  }
}

function isElf(buffer) {
  return buffer.length >= 20
    && buffer[0] === 0x7f
    && buffer[1] === 0x45
    && buffer[2] === 0x4c
    && buffer[3] === 0x46;
}

function compareVersionParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function verifyGlibcCeiling(buffer, file, ceiling = '2.28') {
  const highest = highestGlibcRequirement(buffer);
  if (!highest) {
    throw new Error(`No GLIBC symbol versions found in ${file}`);
  }

  const ceilingParts = ceiling.split('.').map(Number);
  const highestText = highest.join('.');
  if (compareVersionParts(highest, ceilingParts) > 0) {
    throw new Error(`${file} requires GLIBC_${highestText}, above Debian 10 ceiling GLIBC_${ceiling}`);
  }
  return highestText;
}

function highestGlibcRequirement(buffer) {
  const versions = new Map();
  const pattern = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g;
  for (const match of buffer.toString('latin1').matchAll(pattern)) {
    const parts = match.slice(1).filter((part) => part !== undefined).map(Number);
    versions.set(parts.join('.'), parts);
  }
  return versions.size === 0
    ? null
    : [...versions.values()].sort(compareVersionParts).at(-1);
}

function requiredUnavailableSonames(buffer, bundledSonames) {
  const binary = buffer.toString('latin1');
  return DEBIAN10_UNAVAILABLE_SONAMES.filter((soname) => (
    !bundledSonames.has(soname) && binary.includes(`\0${soname}\0`)
  ));
}

export function verifyDebian10NativeBinary(
  buffer,
  file,
  expectedClass,
  expectedMachine,
  bundledSonames = new Set(),
) {
  const violations = [];
  try {
    verifyElfMachine(buffer, file, expectedClass, expectedMachine);
  } catch (error) {
    violations.push(error.message);
  }
  const highest = highestGlibcRequirement(buffer);
  if (highest && compareVersionParts(highest, DEBIAN_GLIBC_CEILING.split('.').map(Number)) > 0) {
    violations.push(
      `${file} requires GLIBC_${highest.join('.')}, above Debian 10 ceiling GLIBC_${DEBIAN_GLIBC_CEILING}`,
    );
  }
  const unavailable = requiredUnavailableSonames(buffer, bundledSonames);
  if (unavailable.length > 0) {
    violations.push(
      `${file} requires unavailable Debian 10 libraries: ${unavailable.join(', ')}`,
    );
  }
  if (violations.length > 0) {
    throw new Error(violations.join('; '));
  }
  return highest ? highest.join('.') : null;
}

export function verifyBackendLauncher(info, file, expectedElf) {
  const mode = info.mode & 0o777;
  if (mode !== 0o755) {
    throw new Error(`Backend launcher is not executable in ${file}`);
  }

  if (isElf(info.body)) {
    return {
      kind: 'native',
      glibc: verifyDebian10NativeBinary(
        info.body,
        file,
        expectedElf.class,
        expectedElf.machine,
      ),
    };
  }

  const launcher = info.body.toString('utf-8');
  if (!launcher.startsWith('#!')) {
    throw new Error(`Portable backend launcher has no shebang in ${file}`);
  }
  if (!launcher.includes('PYTHONDONTWRITEBYTECODE=1')) {
    throw new Error(`Portable backend launcher does not disable bytecode writes in ${file}`);
  }
  return { kind: 'portable', glibc: null };
}

function verifyNativeRuntimeSet(dataTar, dataNames, expectedElf, file) {
  const entries = findTarGzEntriesInfo(dataTar, [...dataNames]);
  const bundledSonames = new Set(
    [...entries]
      .filter(([, info]) => isElf(info.body))
      .map(([runtimePath]) => basename(runtimePath)),
  );
  const errors = [];
  const glibcVersions = [];
  let nativeFiles = 0;

  for (const [runtimePath, info] of entries) {
    if (!isElf(info.body)) continue;
    nativeFiles += 1;
    try {
      const glibc = verifyDebian10NativeBinary(
        info.body,
        runtimePath,
        expectedElf.class,
        expectedElf.machine,
        bundledSonames,
      );
      if (glibc) glibcVersions.push(glibc);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (nativeFiles === 0) {
    errors.push('package contains no recognized ELF runtime files');
  }
  if (errors.length > 0) {
    throw new Error(
      `Debian 10 native runtime verification failed in ${file}:\n  - ${errors.join('\n  - ')}`,
    );
  }

  const highest = glibcVersions
    .sort((left, right) => compareVersionParts(left.split('.').map(Number), right.split('.').map(Number)))
    .at(-1) ?? 'none';
  return { nativeFiles, highest };
}

export function parseControlFields(control) {
  const fields = {};
  let currentKey = null;
  for (const line of control.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentKey) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
      continue;
    }
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/);
    if (match) {
      currentKey = match[1].toLowerCase();
      fields[currentKey] = match[2].trim();
    } else {
      currentKey = null;
    }
  }
  return fields;
}

function dependencyPackageNames(field) {
  return field
    .split(',')
    .flatMap((group) => group.split('|'))
    .map((dependency) => dependency.trim().match(/^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9-]+)?(?:\s|\(|$)/i)?.[1]?.toLowerCase())
    .filter(Boolean);
}

export function verifyLibreOfficeDependencyPolicy(control, file = 'Debian control') {
  const fields = parseControlFields(control);
  const relationshipFields = ['pre-depends', 'depends', 'recommends', 'suggests', 'enhances'];
  for (const field of relationshipFields) {
    const value = fields[field] ?? '';
    const packages = dependencyPackageNames(value);
    if (packages.some((name) => name === 'libreoffice' || name.startsWith('libreoffice-'))) {
      throw new Error(`LibreOffice must be fully separate from ${field} in ${file}: ${value}`);
    }
  }
  return Object.fromEntries(relationshipFields.map((field) => [field, fields[field] ?? '']));
}

function readControl(buffer) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const bodyStart = offset + 512;
    if (name === './control' || name === 'control') {
      return tar.subarray(bodyStart, bodyStart + size).toString('utf-8');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('control file not found');
}

function verifyDebian(mode, arch, required) {
  const file = path.join(release, `${mode}-debian`, `official-document-ai-assistant-${mode}-${version}-${arch}.deb`);
  if (!existsSync(file)) {
    const message = `missing debian ${mode} ${arch}: ${file}`;
    if (required) throw new Error(message);
    console.log(message);
    return;
  }

  const size = statSync(file).size;
  const dpkg = spawnSync('dpkg-deb', ['-I', file], { encoding: 'utf-8' });
  if (dpkg.status === 0) {
    if (!dpkg.stdout.includes(`Package: official-document-ai-assistant-${mode}`)) {
      throw new Error(`Unexpected Debian package name in ${file}`);
    }
  }

  const members = readArMembers(file);
  for (const requiredMember of ['debian-binary', 'control.tar.gz', 'data.tar.gz']) {
    if (!members.has(requiredMember)) {
      throw new Error(`Missing ${requiredMember} in ${file}`);
    }
  }
  const control = readControl(members.get('control.tar.gz'));
  const controlFields = parseControlFields(control);
  if (controlFields.package !== `official-document-ai-assistant-${mode}`) {
    throw new Error(`Unexpected Debian package name in ${file}`);
  }
  const expectedDebArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : 'armhf';
  if (controlFields.architecture !== expectedDebArch) {
    throw new Error(`Unexpected Debian architecture in ${file}`);
  }
  verifyLibreOfficeDependencyPolicy(control, file);
  const expectedElf = arch === 'x64'
    ? { class: 2, machine: 62 }
    : arch === 'arm64'
      ? { class: 2, machine: 183 }
      : { class: 1, machine: 40 };
  const electronPath = `./opt/official-document-ai-assistant-${mode}/official-document-ai-assistant-${mode}`;
  const electronInfo = findTarGzEntryInfo(members.get('data.tar.gz'), electronPath);
  const electron = electronInfo.body;
  if ((electronInfo.mode & 0o777) !== 0o755) {
    throw new Error(`Electron executable mode is not 755 in ${file}`);
  }
  verifyElfMachine(electron, electronPath, expectedElf.class, expectedElf.machine);
  const electronGlibc = verifyGlibcCeiling(electron, electronPath);
  const ffmpegPath = `./opt/official-document-ai-assistant-${mode}/libffmpeg.so`;
  const ffmpeg = findTarGzEntry(members.get('data.tar.gz'), ffmpegPath);
  verifyElfMachine(ffmpeg, ffmpegPath, expectedElf.class, expectedElf.machine);
  const ffmpegGlibc = verifyGlibcCeiling(ffmpeg, ffmpegPath);
  const electronVersionPath = `./opt/official-document-ai-assistant-${mode}/version`;
  const electronVersion = findTarGzEntry(
    members.get('data.tar.gz'),
    electronVersionPath,
  ).toString('utf-8').trim();
  if (electronVersion !== DEBIAN_ELECTRON_VERSION) {
    throw new Error(`Unexpected Electron version in ${file}: ${electronVersion}`);
  }
  const dataNames = new Set(listTarGz(members.get('data.tar.gz')));
  verifyNoFontArchiveEntries([...dataNames], file);
  const nativeRuntimeSummary = verifyNativeRuntimeSet(
    members.get('data.tar.gz'),
    dataNames,
    expectedElf,
    file,
  );
  const appAsarPath = `./opt/official-document-ai-assistant-${mode}/resources/app.asar`;
  const appPackage = inspectAppAsar(
    findTarGzEntry(members.get('data.tar.gz'), appAsarPath),
    file,
    mode,
  );
  if (appPackage.appMode !== mode) {
    throw new Error(`Debian ${mode} app.asar has appMode=${appPackage.appMode} in ${file}`);
  }
  if (appPackage.version !== version) {
    throw new Error(`Debian app.asar has version=${appPackage.version} in ${file}`);
  }
  const launcherPath = `./usr/bin/official-document-ai-assistant-${mode}`;
  const desktopPath = `./usr/share/applications/official-document-ai-assistant-${mode}.desktop`;
  for (const requiredPath of [launcherPath, desktopPath]) {
    if (!dataNames.has(requiredPath)) {
      throw new Error(`Missing ${requiredPath} in ${file}`);
    }
  }
  const launcherInfo = findTarGzEntryInfo(members.get('data.tar.gz'), launcherPath);
  if ((launcherInfo.mode & 0o777) !== 0o755) {
    throw new Error(`Installed launcher is not executable in ${file}`);
  }
  verifyPosixLauncher(
    launcherInfo,
    launcherPath,
    `/opt/official-document-ai-assistant-${mode}/official-document-ai-assistant-${mode}`,
  );
  const desktop = findTarGzEntry(members.get('data.tar.gz'), desktopPath).toString('utf-8');
  for (const expected of [
    `TryExec=/usr/bin/official-document-ai-assistant-${mode}`,
    `Exec=/usr/bin/official-document-ai-assistant-${mode}`,
    `Icon=official-document-ai-assistant-${mode}`,
    'Type=Application',
    'Terminal=false',
  ]) {
    if (!desktop.includes(expected)) {
      throw new Error(`Desktop entry is missing ${expected} in ${file}`);
    }
  }
  if (/libreoffice/i.test(desktop)) {
    throw new Error(`Desktop entry incorrectly references LibreOffice in ${file}`);
  }
  if (![...dataNames].some((name) => name.endsWith('/resources/backend_server/backend_server'))) {
    throw new Error(`Missing backend launcher in ${file}`);
  }
  const backendLauncherPath = [...dataNames].find((name) => name.endsWith('/resources/backend_server/backend_server'));
  const backendLauncherInfo = findTarGzEntryInfo(members.get('data.tar.gz'), backendLauncherPath);
  const backendRuntime = verifyBackendLauncher(backendLauncherInfo, backendLauncherPath, expectedElf);
  const backendGlibc = backendRuntime.glibc ? [backendRuntime.glibc] : [];
  if (backendRuntime.kind === 'portable') {
    if (![...dataNames].some((name) => name.endsWith('/resources/python/bin/python3'))) {
      throw new Error(`Missing bundled Python in ${file}`);
    }
    const pythonPath = [...dataNames].find((name) => name.endsWith('/resources/python/bin/python3'));
    const pythonLinkInfo = findTarGzEntryInfo(members.get('data.tar.gz'), pythonPath);
    let pythonElfPath = pythonPath;
    if (pythonLinkInfo.type === '2') {
      if (!pythonLinkInfo.linkName || path.posix.isAbsolute(pythonLinkInfo.linkName)) {
        throw new Error(`Invalid bundled Python symlink in ${file}: ${pythonLinkInfo.linkName}`);
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(pythonPath), pythonLinkInfo.linkName));
      pythonElfPath = resolved.startsWith('./') ? resolved : `./${resolved}`;
      if (!dataNames.has(pythonElfPath)) {
        throw new Error(`Bundled Python symlink target is missing in ${file}: ${pythonElfPath}`);
      }
    }
    const nativeRuntimePaths = [
      pythonElfPath,
      [...dataNames].find((name) => name.endsWith('/site-packages/cryptography/hazmat/bindings/_rust.abi3.so')),
      [...dataNames].find((name) => /\/site-packages\/lxml\/etree\.[^/]+\.so$/.test(name)),
      [...dataNames].find((name) => /\/site-packages\/pydantic_core\/_pydantic_core\.[^/]+\.so$/.test(name)),
    ];
    if (nativeRuntimePaths.some((name) => !name)) {
      throw new Error(`Missing a required Python native runtime component in ${file}`);
    }
    const nativeRuntimeEntries = findTarGzEntriesInfo(members.get('data.tar.gz'), nativeRuntimePaths);
    const pythonInfo = nativeRuntimeEntries.get(pythonElfPath);
    const pythonMode = pythonInfo.mode & 0o777;
    if (pythonMode !== 0o755) {
      throw new Error(`Bundled Python is not executable in ${file}: mode=${pythonMode.toString(8)}`);
    }
    for (const runtimePath of nativeRuntimePaths) {
      const runtime = nativeRuntimeEntries.get(runtimePath).body;
      verifyElfMachine(runtime, runtimePath, expectedElf.class, expectedElf.machine);
      backendGlibc.push(verifyGlibcCeiling(runtime, runtimePath));
    }
    const expectedPythonLib = arch === 'armv7l' ? 'python3.11' : 'python3.12';
    if (![...dataNames].some((name) => (
      name.endsWith(`/resources/python/lib/${expectedPythonLib}`)
      || name.endsWith(`/resources/python/lib/${expectedPythonLib}/`)
    ))) {
      throw new Error(`Missing ${expectedPythonLib} runtime in ${file}`);
    }
    if (![...dataNames].some((name) => name.endsWith('/resources/python/lib/' + expectedPythonLib + '/site-packages/lxml-5.3.0.dist-info/METADATA'))) {
      throw new Error(`Missing Debian 10 compatible lxml 5.3.0 wheel metadata in ${file}`);
    }
    const unexpectedLxml = [...dataNames].filter((name) => /\/site-packages\/lxml-(?!5\.3\.0)[^/]+\.dist-info\/METADATA$/.test(name));
    if (unexpectedLxml.length > 0) {
      throw new Error(`Unexpected lxml wheel in ${file}: ${unexpectedLxml.join(',')}`);
    }
  }
  const rules = [...dataNames]
    .filter((name) => /\/resources\/rules\/official\/fujian.*\.yaml$/.test(name))
    .map(basename)
    .sort();
  const templates = [...dataNames]
    .filter((name) => /\/resources\/templates\/official\/fujian.*\.yaml$/.test(name))
    .map(basename)
    .sort();
  if (rules.join(',') !== 'fujian_province.yaml') {
    throw new Error(`Debian ${mode} ${arch} has unexpected Fujian rules: ${rules.join(',')}`);
  }
  if (templates.join(',') !== 'fujian_province.yaml') {
    throw new Error(`Debian ${mode} ${arch} has unexpected Fujian templates: ${templates.join(',')}`);
  }
  console.log(
    `debian ${mode} ${arch}: ${size} bytes `
    + `(Electron ${electronVersion}, electron GLIBC_${electronGlibc}, `
    + `libffmpeg GLIBC_${ffmpegGlibc}, all ${nativeRuntimeSummary.nativeFiles} ELF files max `
    + `GLIBC_${nativeRuntimeSummary.highest}, ${backendRuntime.kind} backend subset max `
    + `GLIBC_${backendGlibc.sort((a, b) => compareVersionParts(a.split('.').map(Number), b.split('.').map(Number))).at(-1) ?? 'none'})`,
  );
}

export function runVerifier(args = process.argv.slice(2)) {
  const requireDebian = args.includes('--require-debian');
  const skipWindows = args.includes('--skip-windows');
  const skipDebian = args.includes('--skip-debian');
  const archArg = args.find((arg) => arg.startsWith('--debian-arch='));
  const modeArg = args.find((arg) => arg.startsWith('--debian-modes='));
  const debianArchs = archArg
    ? archArg.slice('--debian-arch='.length).split(',').filter(Boolean)
    : ['x64', 'arm64'];
  const debianModes = modeArg
    ? modeArg.slice('--debian-modes='.length).split(',').filter(Boolean)
    : ['offline', 'online'];
  for (const mode of debianModes) {
    if (!['offline', 'online'].includes(mode)) {
      throw new Error(`Unsupported Debian mode: ${mode}`);
    }
  }
  if (!skipWindows) {
    for (const mode of ['offline', 'online']) {
      verifyWindows(mode);
    }
  }
  if (!skipDebian) {
    for (const mode of debianModes) {
      for (const arch of debianArchs) {
        verifyDebian(mode, arch, requireDebian);
      }
    }
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) {
  runVerifier();
}
