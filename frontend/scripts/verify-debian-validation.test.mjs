import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  decodeDebianTarMember,
  findUniqueTarPath,
  normalizeTarEntryName,
  parseControlFields,
  selectDebianTarMemberName,
  verifyAppMetadata,
  verifyBackendLauncher,
  verifyDebian10NativeBinary,
  verifyGlibcCeiling,
  verifyLibreOfficeDependencyPolicy,
  verifyNoFontArchiveEntries,
  verifyPosixLauncher,
} from './verify-packages.mjs';

test('Debian tar member handling supports standard gzip and xz package layouts', () => {
  const members = new Map([
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.xz', Buffer.from('control')],
    ['data.tar.gz', Buffer.from('data')],
  ]);
  assert.equal(selectDebianTarMemberName(members, 'control', 'fixture.deb'), 'control.tar.xz');
  assert.equal(selectDebianTarMemberName(members, 'data', 'fixture.deb'), 'data.tar.gz');

  const tar = Buffer.from('uncompressed tar fixture');
  assert.deepEqual(decodeDebianTarMember('data.tar.gz', gzipSync(tar)), tar);
  assert.deepEqual(decodeDebianTarMember('data.tar', tar), tar);
  assert.equal(normalizeTarEntryName('opt/app/bin'), './opt/app/bin');
  assert.equal(normalizeTarEntryName('./opt/app/bin'), './opt/app/bin');
  assert.equal(
    findUniqueTarPath(new Set(['./opt/Product/app']), (name) => name.endsWith('/app'), 'app'),
    './opt/Product/app',
  );
  assert.throws(
    () => selectDebianTarMemberName(
      new Map([['control.tar.gz', tar], ['control.tar.xz', tar]]),
      'control',
      'fixture.deb',
    ),
    /exactly one control\.tar member/,
  );
});

test('application metadata verifier requires the public author identity', () => {
  const valid = {
    name: 'official-document-ai-assistant',
    license: 'MIT',
    author: {
      name: 'HaoXiang Huang',
      email: 'Rays688888@Gmail.com',
      url: 'https://nextweb4.github.io/',
    },
    homepage: 'https://nextweb4.github.io/',
    appMode: 'offline',
  };
  assert.doesNotThrow(() => verifyAppMetadata(valid, 'fixture', 'offline'));
  assert.throws(
    () => verifyAppMetadata({ ...valid, author: { ...valid.author, email: 'old@example.com' } }, 'fixture', 'offline'),
    /unexpected author email/,
  );
  assert.throws(
    () => verifyAppMetadata({ ...valid, license: 'unknown' }, 'fixture', 'offline'),
    /unexpected license/,
  );
});

test('package verifier rejects bundled third-party font files', () => {
  assert.equal(
    verifyNoFontArchiveEntries(['./resources/rules/official/common.yaml'], 'fixture'),
    true,
  );
  assert.throws(
    () => verifyNoFontArchiveEntries(['./resources/TTF/example.ttf'], 'fixture'),
    /contains bundled font files/,
  );
});

function launcherEntry(text, type = '0', linkName = '') {
  return { body: Buffer.from(text, 'utf-8'), type, linkName };
}

function elfFixture({ elfClass = 2, machine = 62, strings = [] } = {}) {
  const buffer = Buffer.alloc(64 + strings.join('\0').length + 2);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1]);
  buffer.writeUInt16LE(machine, 18);
  buffer.write(`\0${strings.join('\0')}\0`, 64, 'latin1');
  return buffer;
}

test('Debian control parser unfolds fields and keeps LibreOffice fully separate', () => {
  const control = [
    'Package: official-document-ai-assistant-offline',
    'License: MIT',
    'Depends: libc6,',
    ' libgtk-3-0',
    '',
  ].join('\n');

  assert.deepEqual(parseControlFields(control), {
    package: 'official-document-ai-assistant-offline',
    license: 'MIT',
    depends: 'libc6, libgtk-3-0',
  });
  assert.deepEqual(verifyLibreOfficeDependencyPolicy(control), {
    'pre-depends': '',
    depends: 'libc6, libgtk-3-0',
    recommends: '',
    suggests: '',
    enhances: '',
  });
});

test('Debian control verifier rejects LibreOffice in every package relationship', () => {
  const fields = ['Pre-Depends', 'Depends', 'Recommends', 'Suggests', 'Enhances'];
  const dependencies = ['libreoffice', 'libreoffice-common', 'libreoffice-core', 'libreoffice-writer'];
  for (const field of fields) {
    for (const dependency of dependencies) {
      assert.throws(
        () => verifyLibreOfficeDependencyPolicy(`${field}: ${dependency}\n`, 'fixture.deb'),
        /LibreOffice must be fully separate.*fixture\.deb/,
      );
    }
  }
});

test('launcher verifier requires the exact absolute POSIX /opt target', () => {
  const expected = '/opt/official-document-ai-assistant-offline/official-document-ai-assistant-offline';
  const script = [
    '#!/usr/bin/env bash',
    "printf '\\n[%s] launching\\n' \"$(date -Iseconds)\"",
    `exec "${expected}" --no-sandbox "$@" >>"$log_file" 2>&1`,
    `exec "${expected}" --no-sandbox "$@"`,
    '',
  ].join('\n');
  assert.equal(verifyPosixLauncher(launcherEntry(script), 'launcher', expected), expected);
  assert.equal(
    verifyPosixLauncher(launcherEntry('', '2', expected), 'launcher-link', expected),
    expected,
  );
  assert.throws(
    () => verifyPosixLauncher(
      launcherEntry('#!/usr/bin/env bash\nexec "\\opt\\official-document-ai-assistant-offline"\n'),
      'windows-launcher',
      expected,
    ),
    /contains a backslash/,
  );
  assert.throws(
    () => verifyPosixLauncher(
      launcherEntry('#!/usr/bin/env bash\nexec "opt/app"\n'),
      'relative-launcher',
      expected,
    ),
    /absolute \/opt POSIX path/,
  );
});

test('GLIBC verifier accepts 2.28 and rejects newer symbol requirements', () => {
  const compatible = Buffer.from('ELF\0GLIBC_2.2.5\0GLIBC_2.9\0GLIBC_2.28\0', 'latin1');
  assert.equal(verifyGlibcCeiling(compatible, 'electron'), '2.28');
  assert.throws(
    () => verifyGlibcCeiling(Buffer.from('GLIBC_2.29\0'), 'libffmpeg.so'),
    /requires GLIBC_2\.29.*above Debian 10 ceiling GLIBC_2\.28/,
  );
  assert.throws(
    () => verifyGlibcCeiling(Buffer.from('no symbol versions'), 'electron'),
    /No GLIBC symbol versions found/,
  );
});

test('native ELF verifier rejects mixed architectures, newer glibc, and unavailable libraries', () => {
  assert.equal(
    verifyDebian10NativeBinary(
      elfFixture({ strings: ['GLIBC_2.17', 'libc.so.6'] }),
      'compatible.so',
      2,
      62,
    ),
    '2.17',
  );
  assert.throws(
    () => verifyDebian10NativeBinary(
      elfFixture({ elfClass: 1, machine: 40, strings: ['GLIBC_2.17'] }),
      'arm.so',
      2,
      62,
    ),
    /Unexpected ELF machine/,
  );
  assert.throws(
    () => verifyDebian10NativeBinary(
      elfFixture({ strings: ['GLIBC_2.34'] }),
      'new-glibc.so',
      2,
      62,
    ),
    /requires GLIBC_2\.34/,
  );
  assert.throws(
    () => verifyDebian10NativeBinary(
      elfFixture({ strings: ['GLIBC_2.17', 'libssl.so.3'] }),
      'openssl3.so',
      2,
      62,
    ),
    /unavailable Debian 10 libraries: libssl\.so\.3/,
  );
  assert.equal(
    verifyDebian10NativeBinary(
      elfFixture({ strings: ['GLIBC_2.17', 'libssl.so.3'] }),
      'bundled-openssl3.so',
      2,
      62,
      new Set(['libssl.so.3']),
    ),
    '2.17',
  );
});

test('backend verifier accepts native PyInstaller and validates portable launchers separately', () => {
  const native = verifyBackendLauncher(
    { body: elfFixture({ strings: ['GLIBC_2.17'] }), mode: 0o755 },
    'backend_server',
    { class: 2, machine: 62 },
  );
  assert.deepEqual(native, { kind: 'native', glibc: '2.17' });

  const portable = verifyBackendLauncher(
    { ...launcherEntry('#!/usr/bin/env bash\nexport PYTHONDONTWRITEBYTECODE=1\n'), mode: 0o755 },
    'backend-launcher',
    { class: 2, machine: 62 },
  );
  assert.deepEqual(portable, { kind: 'portable', glibc: null });
  assert.throws(
    () => verifyBackendLauncher(
      { ...launcherEntry('#!/usr/bin/env bash\nexec python3 backend.py\n'), mode: 0o755 },
      'unsafe-portable-launcher',
      { class: 2, machine: 62 },
    ),
    /does not disable bytecode writes/,
  );
});

test('package verifier scans every data archive entry for ELF payloads', () => {
  const verifier = readFileSync(new URL('./verify-packages.mjs', import.meta.url), 'utf-8');

  assert.match(verifier, /findTarEntriesInfo\(dataTar, \[\.\.\.dataNames\]\)/);
  assert.doesNotMatch(verifier, /nativeCandidatePath/);
});

test('runtime verifier requires GUI and attributes backend startup to Electron', () => {
  const runtime = readFileSync(new URL('./verify-debian-runtime.sh', import.meta.url), 'utf-8');

  assert.ok(runtime.startsWith('#!/usr/bin/env bash\n'));
  assert.equal(runtime.includes('\r'), false);
  assert.ok(runtime.indexOf('[[ -n "${DISPLAY:-}" ]]') < runtime.indexOf('command -v xvfb-run'));
  assert.match(runtime, /Electron GUI verification requires DISPLAY or xvfb-run/);
  assert.match(runtime, /ALLOW_NON_RELEASE_NO_GUI=1/);
  assert.match(runtime, /ALLOW_NON_RELEASE_OS="\$\{ALLOW_NON_RELEASE_OS:-0\}"/);
  assert.match(runtime, /ALLOW_NON_RELEASE_OS must be 0 or 1/);
  assert.match(
    runtime,
    /if \[\[ "\$OS_ID" != "debian"[\s\S]*ALLOW_NON_RELEASE_OS[\s\S]*requires Debian 10\.x[\s\S]*exit 1/,
  );
  assert.match(runtime, /NON-RELEASE OVERRIDE: expected Debian 10\.x/);
  assert.doesNotMatch(runtime, /WARNING: expected Debian 10\.x/);
  assert.doesNotMatch(runtime, /skipped GUI launcher smoke test/i);
  assert.doesNotMatch(runtime, /"\$BACKEND" --force\s*&/);
  assert.match(runtime, /backend health endpoint was already active before Electron launch/);
  assert.match(runtime, /find_electron_pid "\$APP_PID"/);
  assert.match(runtime, /find_renderer_pid "\$ELECTRON_PID"/);
  assert.match(runtime, /find_backend_pid "\$ELECTRON_PID"/);
  assert.match(runtime, /is_descendant_or_self "\$BACKEND_PID" "\$ELECTRON_PID"/);
  assert.match(runtime, /grep -q 'Window shown' "\$LAUNCHER_LOG"/);
  assert.match(runtime, /XDG_STATE_HOME="\$XDG_STATE_HOME"/);
  assert.match(runtime, /expected app_mode=\{expected\}/);
  assert.match(runtime, /document assistant package is not installed after dpkg\/apt completed/);
  assert.match(runtime, /apt-get install -f -y --no-install-recommends/);
  assert.match(runtime, /find \/opt -mindepth 2 -maxdepth 2 -type f -name "\$PACKAGE" -perm \/111/);
  assert.match(runtime, /ELECTRON="\$\{ELECTRON_CANDIDATES\[0\]\}"/);
  assert.match(runtime, /APP_DIR="\$\(dirname "\$ELECTRON"\)"/);
  assert.match(runtime, /verify_dynamic_links/);
  assert.match(runtime, /ldd "\$candidate"/);
  assert.match(runtime, /unresolved shared library/);
});

test('Debian release workflow runs GUI validation for x64 and arm64 on Debian 10', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/verify-debian-release.yml', import.meta.url),
    'utf-8',
  );

  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.run_id \}\}/);
  assert.match(workflow, /arch: x64[\s\S]*platform: linux\/amd64/);
  assert.match(workflow, /arch: arm64[\s\S]*platform: linux\/arm64/);
  assert.match(workflow, /debian:10\.10-slim/);
  assert.match(workflow, /xauth xvfb/);
  assert.match(workflow, /verify-debian-runtime\.sh/);
  assert.doesNotMatch(workflow, /ALLOW_NON_RELEASE_(?:OS|NO_GUI)/);
});

test('WSL builder provisions pinned runtimes and builds only on Linux ext4', () => {
  const builder = readFileSync(new URL('./build-debian-wsl.ps1', import.meta.url), 'utf-8');

  assert.equal(builder.includes('\r'), false);
  assert.match(builder, /\$NodeVersion = "20\.19\.5"/);
  assert.match(builder, /\$PythonVersion = "3\.12\.7"/);
  assert.match(builder, /\$PythonSourceSha256 = "[0-9a-f]{64}"/);
  assert.match(builder, /archive\.debian\.org/);
  assert.match(builder, /nodejs\.org\/dist\/v\$\{node_version\}\/SHASUMS256\.txt/);
  assert.match(builder, /sha256sum -c -/);
  assert.match(builder, /python\.org\/ftp\/python\/\$\{python_version\}/);
  assert.match(builder, /"\$python_sha256" "\$work_dir\/\$archive" \| sha256sum -c -/);
  assert.match(builder, /\.\/configure --prefix="\$python_root" --enable-shared/);
  assert.match(builder, /process\.versions\.node\.split/);
  assert.match(builder, /sys\.version_info\[:2\] != \(3, 12\)/);
  assert.match(builder, /BuildRoot = "\/var\/tmp\/official-document-ai-assistant-wsl-\$PID"/);
  assert.match(builder, /case \$quotedBuildRoot in \/mnt\/\*/);
  assert.match(builder, /--exclude='\/frontend\/node_modules\/'/);
  assert.match(builder, /--exclude='\/frontend\/release\/'/);
  assert.match(builder, /Copy source into WSL ext4 build directory/);
  assert.match(builder, /Copy Debian artifacts back to the Windows workspace/);
  assert.match(builder, /cannot cross-compile the PyInstaller backend/);
  assert.doesNotMatch(builder, /cd '\$frontendWsl'/);
});

test('Debian package builders run structural verification without requiring Windows artifacts', () => {
  const verifier = readFileSync(new URL('./verify-packages.mjs', import.meta.url), 'utf-8');
  const builder = readFileSync(new URL('./build-debian-packages.sh', import.meta.url), 'utf-8');
  const workflow = readFileSync(new URL('../../.github/workflows/package-debian.yml', import.meta.url), 'utf-8');

  assert.match(verifier, /const skipWindows = args\.includes\('--skip-windows'\)/);
  assert.match(verifier, /if \(!skipWindows\) \{/);
  assert.match(verifier, /const skipDebian = args\.includes\('--skip-debian'\)/);
  assert.match(verifier, /if \(!skipDebian\) \{/);
  for (const marker of [
    'Backend health check timed out',
    ' is ready in ',
    'System tray unavailable; continuing without it',
    'Window shown',
  ]) {
    assert.ok(verifier.includes(marker));
  }
  assert.match(builder, /node scripts\/verify-packages\.mjs[\s\S]*--skip-windows[\s\S]*--require-debian/);
  assert.match(builder, /awk '\$NF ~ \/\\\/backend_server\\\/backend_server\$\//);
  assert.doesNotMatch(builder, /dpkg-deb -c "\$artifact" \| grep -q/);
  assert.match(workflow, /npm run verify:packages -- --skip-windows --require-debian/);
  assert.match(workflow, /npm ci --ignore-scripts --legacy-peer-deps/);
  assert.match(workflow, /default: "x64,arm64"/);
  assert.doesNotMatch(workflow, /default: "x64,arm64,armv7l"/);
  assert.match(verifier, /: \['x64', 'arm64'\];/);
});

test('Docker builders leave the image workdir before replacing the staging tree', () => {
  const shellBuilder = readFileSync(new URL('./build-debian-docker.sh', import.meta.url), 'utf-8');
  const powershellBuilder = readFileSync(new URL('./build-debian-docker.ps1', import.meta.url), 'utf-8');

  assert.ok(shellBuilder.includes('export PATH="/opt/node/bin:/opt/python/bin:\\$PATH"'));
  assert.ok(shellBuilder.includes('export LD_LIBRARY_PATH="/opt/python/lib:\\${LD_LIBRARY_PATH:-}"'));
  assert.ok(powershellBuilder.includes('export PATH="/opt/node/bin:/opt/python/bin:`$PATH"'));
  assert.ok(powershellBuilder.includes('export LD_LIBRARY_PATH="/opt/python/lib:`${LD_LIBRARY_PATH:-}"'));

  for (const builder of [shellBuilder, powershellBuilder]) {
    const normalized = builder.replaceAll('\r\n', '\n');
    const leaveWorkdir = normalized.indexOf('\ncd /\n');
    const removeWorkdir = normalized.indexOf('\nrm -rf /build/work\n');
    assert.ok(leaveWorkdir > normalized.indexOf('export LD_LIBRARY_PATH='));
    assert.ok(removeWorkdir > leaveWorkdir);
  }
});

test('CI type-checks both renderer and Electron processes', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf-8');

  assert.match(workflow, /npx tsc --noEmit/);
  assert.match(workflow, /npx tsc -p tsconfig\.electron\.json --noEmit/);
});

test('package builder forces UTF-8 for Python subprocess output', () => {
  const source = readFileSync(new URL('./build-packages.mjs', import.meta.url), 'utf-8');
  assert.match(source, /PYTHONIOENCODING:\s*'utf-8'/);
  assert.match(source, /PYTHONUTF8:\s*'1'/);
});

test('Linux afterPack writes a pinned Electron version marker', () => {
  const source = readFileSync(new URL('./after-pack-prune.cjs', import.meta.url), 'utf-8');
  assert.match(source, /electronPlatformName === 'linux'/);
  assert.match(source, /config\.electronVersion/);
  assert.match(source, /'electron-version'/);
});

test('portable builder defaults to release-compatible architectures and validates every wheel ELF', () => {
  const builder = readFileSync(new URL('./build-portable-debian.py', import.meta.url), 'utf-8');

  assert.match(builder, /PORTABLE_ARCHES = \("x64", "arm64"\)/);
  assert.match(builder, /def verify_wheel_set\(arch: str, wheel_dir: Path\) -> str:/);
  assert.match(builder, /requires GLIBC_\{version_text\}, above Debian 10 GLIBC_2\.28/);
  assert.match(builder, /DEBIAN10_UNAVAILABLE_SONAMES/);
  assert.match(builder, /Portable Debian packaging is unavailable/);
});

test('Electron startup treats tray as optional and registers window visibility before loading', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf-8');

  assert.match(main, /function createTray\(\): void[\s\S]*try \{/);
  assert.match(main, /System tray unavailable/);
  assert.match(main, /System tray unavailable; closing application instead of hiding window/);
  assert.match(main, /Number\(process\.env\.API_PORT\)/);
  assert.ok(main.indexOf("mainWindow.once('ready-to-show'") < main.indexOf('await mainWindow.loadURL'));
  assert.ok(main.indexOf("mainWindow.webContents.once('did-finish-load'") < main.indexOf('await mainWindow.loadURL'));
  assert.match(main, /Failed to load frontend/);
  assert.equal(main.match(/req\.setTimeout\(2000, \(\) =>/g)?.length, 1);
  assert.match(main, /isCompatibleBackendHealth\(health, expectedMode, expectedVersion\)/);
  assert.match(main, /parsed\.app_mode === 'offline' \|\| parsed\.app_mode === 'online'/);
  assert.match(main, /if \(backendProcess === child\)/);
  assert.match(main, /const processToStop = backendProcess/);
});

test('Electron validates backend identity and rejects untrusted renderer navigation and IPC', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf-8');

  assert.match(main, /health\.appId === BACKEND_APP_ID/);
  assert.match(main, /health\.version === expectedVersion/);
  assert.match(main, /health\.appMode === expectedMode/);
  assert.match(main, /else if \(backendHealth\.portOccupied\)[\s\S]*Refusing to replace unverified or incompatible port owner/);
  assert.ok(
    main.indexOf('else if (backendHealth.portOccupied)')
      < main.indexOf('startBackend();', main.indexOf("app.on('ready'")),
  );
  assert.match(main, /guardTopLevelNavigation[\s\S]*event\.preventDefault\(\)/);
  assert.match(main, /webContents\.on\('will-navigate', guardTopLevelNavigation\)/);
  assert.match(main, /webContents\.on\('will-redirect', guardTopLevelNavigation\)/);
  assert.match(main, /function assertTrustedIpcSender[\s\S]*event\.sender === mainWindow\.webContents/);
  assert.match(main, /event\.senderFrame === event\.sender\.mainFrame/);
  assert.equal(main.match(/assertTrustedIpcSender\(event\);/g)?.length, 3);
});

test('frontend contains Chromium 100 CSS fallbacks without :has selectors', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf-8');
  const table = readFileSync(new URL('../src/components/ui/table.tsx', import.meta.url), 'utf-8');

  assert.match(css, /@supports not \(color: color-mix\(in srgb, black, white\)\)/);
  assert.match(css, /\.bg-black\\\/40 \{ background-color: rgba\(0, 0, 0, 0\.4\); \}/);
  assert.match(css, /\.bg-white\\\/60 \{ background-color: rgba\(var\(--rgb-card\), 0\.62\) !important; \}/);
  assert.doesNotMatch(table, /:has\(/);
});
