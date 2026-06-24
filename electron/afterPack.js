const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

module.exports = async (context) => {
  const appDir = path.join(context.appOutDir, 'qmd-ui.app');

  // Fix better_sqlite3.node arch: electron-builder may download a prebuilt of the wrong
  // arch even with npmRebuild:false, so verify and overwrite from our @electron/rebuild.
  const src = path.join(__dirname, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (fs.existsSync(src)) {
    const dest = path.join(
      appDir,
      'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    );
    if (fs.existsSync(dest)) {
      const srcArch  = execFileSync('file', [src]).toString().trim();
      const destArch = execFileSync('file', [dest]).toString().trim();
      console.log(`afterPack: src  better_sqlite3.node → ${srcArch.split(':')[1].trim()}`);
      console.log(`afterPack: dest better_sqlite3.node → ${destArch.split(':')[1].trim()}`);
      if (srcArch !== destArch) {
        console.log('afterPack: arch mismatch — overwriting dest with src');
        fs.copyFileSync(src, dest);
      }
    }
  }

  // Fix ElectronAsarIntegrity hash in Info.plist.
  // electron-builder computes the hash before afterPack runs, but afterPack may modify
  // the asar (or electron-builder may re-pack it afterward), leaving a stale hash.
  // A wrong hash makes Electron reject ELECTRON_RUN_AS_NODE child processes at runtime.
  const infoPlistPath = path.join(appDir, 'Contents/Info.plist');
  const asarPath      = path.join(appDir, 'Contents/Resources/app.asar');
  if (fs.existsSync(infoPlistPath) && fs.existsSync(asarPath)) {
    const asarHash = crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
    let plist = fs.readFileSync(infoPlistPath, 'utf8');
    const updated = plist.replace(
      /(<key>ElectronAsarIntegrity<\/key>[\s\S]*?<key>hash<\/key>\s*<string>)[^<]*/,
      `$1${asarHash}`
    );
    if (updated !== plist) {
      fs.writeFileSync(infoPlistPath, updated, 'utf8');
      console.log(`afterPack: updated ElectronAsarIntegrity hash → ${asarHash}`);
    }
  }
};
