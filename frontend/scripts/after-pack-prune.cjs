const { readdirSync, rmSync, existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const keepLocales = new Set(['zh-CN.pak', 'en-US.pak']);
  const localesDir = path.join(appOutDir, 'locales');

  if (existsSync(localesDir)) {
    for (const file of readdirSync(localesDir)) {
      if (file.endsWith('.pak') && !keepLocales.has(file)) {
        rmSync(path.join(localesDir, file), { force: true });
      }
    }
  }

  const unpackedNodeModules = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  if (existsSync(unpackedNodeModules)) {
    rmSync(unpackedNodeModules, { recursive: true, force: true });
  }

  const defaultApp = path.join(appOutDir, 'resources', 'default_app.asar');
  if (existsSync(defaultApp)) {
    rmSync(defaultApp, { force: true });
  }

  if (context.electronPlatformName === 'linux') {
    const electronVersion = context.packager.config.electronVersion;
    if (typeof electronVersion !== 'string' || electronVersion.length === 0) {
      throw new Error('Linux packaging requires an explicit electronVersion');
    }
    writeFileSync(path.join(appOutDir, 'electron-version'), `${electronVersion}\n`, 'utf-8');
  }
};
