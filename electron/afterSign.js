const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Strip com.apple.cs.* extended attributes from every file in the app bundle.
// These per-file code-signing xattrs are written by codesign and get embedded in the
// DMG's HFS+ filesystem. On macOS 26 (Tahoe), the kernel enforces them at dyld startup
// when the app is installed to /Applications from DMG — if they exist, the app hangs
// at _dyld_start with only 32KB RSS. ZIP installs don't have this problem because zip
// does not preserve xattrs. Stripping here (after signing, before DMG creation) removes
// them from the DMG while leaving the _CodeSignature/CodeResources seal intact.
function stripCsXattrs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      stripCsXattrs(full);
    } else {
      const attrs = [
        'com.apple.cs.CodeDirectory',
        'com.apple.cs.CodeEntitlements',
        'com.apple.cs.CodeRequirements',
        'com.apple.cs.CodeRequirements-1',
        'com.apple.cs.CodeSignature',
      ];
      for (const attr of attrs) {
        try {
          execFileSync('xattr', ['-d', attr, full], { stdio: 'ignore' });
        } catch { /* key not present — fine */ }
      }
    }
  }
}

module.exports = async (context) => {
  const { appOutDir, packager } = context;
  if (packager.platform.name !== 'mac') return;

  const appDir = path.join(appOutDir, `${packager.appInfo.productName}.app`);
  if (!fs.existsSync(appDir)) return;

  console.log(`afterSign: stripping com.apple.cs.* xattrs from ${appDir}`);
  stripCsXattrs(appDir);
  console.log('afterSign: done');
};
