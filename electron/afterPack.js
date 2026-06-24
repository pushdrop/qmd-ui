const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// After electron-builder packs the app, ensure better_sqlite3.node matches the
// target arch. electron-builder can replace our @electron/rebuild output with a
// downloaded prebuilt of the wrong arch when npmRebuild:false is set.
module.exports = async (context) => {
  const src = path.join(__dirname, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (!fs.existsSync(src)) return;

  const dest = path.join(
    context.appOutDir,
    'qmd-ui.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  );
  if (!fs.existsSync(dest)) return;

  const srcArch = execFileSync('file', [src]).toString().trim();
  const destArch = execFileSync('file', [dest]).toString().trim();
  console.log(`afterPack: src  better_sqlite3.node → ${srcArch.split(':')[1].trim()}`);
  console.log(`afterPack: dest better_sqlite3.node → ${destArch.split(':')[1].trim()}`);

  if (srcArch !== destArch) {
    console.log('afterPack: arch mismatch — overwriting dest with src');
    fs.copyFileSync(src, dest);
    console.log('afterPack: done');
  }
};
