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
  if (pkg.license !== 'MIT') {
    throw new Error(`${file} has unexpected license: ${pkg.license}`);
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

export function selectDebianTarMemberName(members, kind, file = 'Debian package') {
  const names = [...members.keys()].filter((name) => (
    name === `${kind}.tar`
    || name === `${kind}.tar.gz`
    || name === `${kind}.tar.xz`
    || name === `${kind}.tar.zst`
  ));
  if (names.length !== 1) {
    throw new Error(
      `Expected exactly one ${kind}.tar member in ${file}; found ${names.join(', ') || 'none'}`,
    );
  }
  return names[0];
}

function decodeExternalTar(memberName, buffer, command, args) {
  const result = spawnSync(command, args, {
    input: buffer,
    encoding: null,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} is required to decode ${memberName}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf-8').trim() || `exit code ${result.status}`;
    throw new Error(`Unable to decode ${memberName} with ${command}: ${detail}`);
  }
  return result.stdout;
}

export function decodeDebianTarMember(memberName, buffer) {
  if (memberName.endsWith('.tar.gz')) return gunzipSync(buffer);
  if (memberName.endsWith('.tar.xz')) return decodeExternalTar(memberName, buffer, 'xz', ['-dc']);
  if (memberName.endsWith('.tar.zst')) return decodeExternalTar(memberName, buffer, 'zstd', ['-dcq']);
  if (memberName.endsWith('.tar')) return buffer;
  throw new Error(`Unsupported Debian tar member compression: ${memberName}`);
}

export function normalizeTarEntryName(name) {
  if (name.startsWith('./') || name.startsWith('/')) return name;
  return `./${name}`;
}

export function findUniqueTarPath(entries, predicate, label, file = 'tar archive') {
  const matches = [...entries].filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${file}; found ${matches.join(', ') || 'none'}`);
  }
  return matches[0];
}

function listTar(tar) {
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
    const entryName = normalizeTarEntryName(longName ?? (prefix ? `${prefix}/${name}` : name));
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

function findTarEntriesInfo(tar, wantedNames) {
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
    const entryName = normalizeTarEntryName(longName ?? (prefix ? `${prefix}/${name}` : name));
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

function findTarEntryInfo(tar, wantedName) {
  return findTarEntriesInfo(tar, [wantedName]).get(wantedName);
}

function findTarEntry(tar, wantedName) {
  return findTarEntryInfo(tar, wantedName).body;
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
  const entries = findTarEntriesInfo(dataTar, [...dataNames]);
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

function readControl(tar) {
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
  if (!members.has('debian-binary')) {
    throw new Error(`Missing debian-binary in ${file}`);
  }
  const controlMember = selectDebianTarMemberName(members, 'control', file);
  const dataMember = selectDebianTarMemberName(members, 'data', file);
  const controlTar = decodeDebianTarMember(controlMember, members.get(controlMember));
  const dataTar = decodeDebianTarMember(dataMember, members.get(dataMember));
  const control = readControl(controlTar);
  const controlFields = parseControlFields(control);
  if (controlFields.package !== `official-document-ai-assistant-${mode}`) {
    throw new Error(`Unexpected Debian package name in ${file}`);
  }
  if (controlFields.license !== 'MIT') {
    throw new Error(`Unexpected Debian license in ${file}: ${controlFields.license ?? ''}`);
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
  const dataNames = new Set(listTar(dataTar));
  const executableName = `official-document-ai-assistant-${mode}`;
  const electronPath = findUniqueTarPath(
    dataNames,
    (name) => name.startsWith('./opt/') && name.endsWith(`/${executableName}`),
    'Electron executable',
    file,
  );
  const installDir = electronPath.slice(0, -(executableName.length + 1));
  const expectedInstallDir = `./opt/${executableName}`;
  if (installDir !== expectedInstallDir) {
    throw new Error(`Unexpected Debian install directory in ${file}: ${installDir}`);
  }
  const electronTarget = electronPath.slice(1);
  const electronInfo = findTarEntryInfo(dataTar, electronPath);
  const electron = electronInfo.body;
  if ((electronInfo.mode & 0o777) !== 0o755) {
    throw new Error(`Electron executable mode is not 755 in ${file}`);
  }
  verifyElfMachine(electron, electronPath, expectedElf.class, expectedElf.machine);
  const electronGlibc = verifyGlibcCeiling(electron, electronPath);
  const ffmpegPath = `${installDir}/libffmpeg.so`;
  const ffmpeg = findTarEntry(dataTar, ffmpegPath);
  verifyElfMachine(ffmpeg, ffmpegPath, expectedElf.class, expectedElf.machine);
  const ffmpegGlibc = verifyGlibcCeiling(ffmpeg, ffmpegPath);
  const electronVersionPath = [`${installDir}/electron-version`, `${installDir}/version`]
    .find((name) => dataNames.has(name));
  let electronVersion = electronVersionPath
    ? findTarEntry(dataTar, electronVersionPath).toString('utf-8').trim()
    : null;
  verifyNoFontArchiveEntries([...dataNames], file);
  const nativeRuntimeSummary = verifyNativeRuntimeSet(
    dataTar,
    dataNames,
    expectedElf,
    file,
  );
  const appAsarPath = `${installDir}/resources/app.asar`;
  const appPackage = inspectAppAsar(
    findTarEntry(dataTar, appAsarPath),
    file,
    mode,
  );
  if (appPackage.appMode !== mode) {
    throw new Error(`Debian ${mode} app.asar has appMode=${appPackage.appMode} in ${file}`);
  }
  if (appPackage.version !== version) {
    throw new Error(`Debian app.asar has version=${appPackage.version} in ${file}`);
  }
  electronVersion ??= appPackage.build?.electronVersion ?? null;
  if (electronVersion !== DEBIAN_ELECTRON_VERSION) {
    throw new Error(`Unexpected Electron version in ${file}: ${electronVersion ?? 'missing'}`);
  }
  const launcherPath = `./usr/bin/${executableName}`;
  const desktopPath = `./usr/share/applications/${executableName}.desktop`;
  if (!dataNames.has(desktopPath)) {
    throw new Error(`Missing ${desktopPath} in ${file}`);
  }
  const packagedLauncher = dataNames.has(launcherPath);
  if (packagedLauncher) {
    const launcherInfo = findTarEntryInfo(dataTar, launcherPath);
    if ((launcherInfo.mode & 0o777) !== 0o755) {
      throw new Error(`Installed launcher is not executable in ${file}`);
    }
    verifyPosixLauncher(launcherInfo, launcherPath, electronTarget);
  } else {
    const controlNames = new Set(listTar(controlTar));
    if (!controlNames.has('./postinst')) {
      throw new Error(`Missing postinst link setup in ${file}`);
    }
    const postinstInfo = findTarEntryInfo(controlTar, './postinst');
    if ((postinstInfo.mode & 0o111) === 0) {
      throw new Error(`postinst is not executable in ${file}`);
    }
    const postinst = postinstInfo.body.toString('utf-8');
    for (const expected of [`/usr/bin/${executableName}`, electronTarget]) {
      if (!postinst.includes(expected)) {
        throw new Error(`postinst is missing ${expected} in ${file}`);
      }
    }
  }
  const desktop = findTarEntry(dataTar, desktopPath).toString('utf-8');
  const displayName = `HaoXiang Document Assistant ${mode === 'online' ? 'Online' : 'Offline'}`;
  const expectedDesktopExec = packagedLauncher
    ? `Exec=/usr/bin/${executableName}`
    : `Exec=${electronTarget} %U`;
  for (const expected of [
    ...(packagedLauncher ? [`TryExec=/usr/bin/${executableName}`] : []),
    expectedDesktopExec,
    `Name=${displayName}`,
    `Icon=${executableName}`,
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
  const backendLauncherInfo = findTarEntryInfo(dataTar, backendLauncherPath);
  const backendRuntime = verifyBackendLauncher(backendLauncherInfo, backendLauncherPath, expectedElf);
  const backendGlibc = backendRuntime.glibc ? [backendRuntime.glibc] : [];
  if (backendRuntime.kind === 'portable') {
    if (![...dataNames].some((name) => name.endsWith('/resources/python/bin/python3'))) {
      throw new Error(`Missing bundled Python in ${file}`);
    }
    const pythonPath = [...dataNames].find((name) => name.endsWith('/resources/python/bin/python3'));
    const pythonLinkInfo = findTarEntryInfo(dataTar, pythonPath);
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
    const nativeRuntimeEntries = findTarEntriesInfo(dataTar, nativeRuntimePaths);
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
