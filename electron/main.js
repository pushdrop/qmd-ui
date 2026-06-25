'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, nativeTheme, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs/promises');
const os      = require('os');
const { execFile, spawn } = require('child_process');

// In packaged builds, server.mjs + index.html are in Resources/ (extraResources).
// In dev, they live in the parent directory of electron/.
const SERVER_PATH  = app.isPackaged
  ? path.join(process.resourcesPath, 'server.mjs')
  : path.resolve(__dirname, '..', 'server.mjs');

// preload.js is inside the asar in packaged builds; __dirname resolves correctly.
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const SETUP_PATH   = path.join(__dirname, 'setup.html');
const PREFS_PATH   = path.join(__dirname, 'prefs.html');
const PORT         = Number(process.env.PORT) || 8765;
const SERVER_URL   = `http://127.0.0.1:${PORT}`;
const CONFIG_PATH  = path.join(app.getPath('userData'), 'config.json');

let mainWindow    = null;
let wizardWindow  = null;
let prefsWindow   = null;
let serverProcess = null;
let tray          = null;
let statusTimer   = null;
let quitting      = false;

// ── single instance ──────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow || wizardWindow;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// ── qmd invocation ───────────────────────────────────────────────────────────
//
// When packaged, qmd is bundled in node_modules/@tobilu/qmd (asarUnpack).
// We run it via Electron's own Node runtime (process.execPath + ELECTRON_RUN_AS_NODE=1)
// so users don't need node/bun installed on their machine.
//
// When developing (not packaged), fall back to the system `qmd` binary.

function bundledQmdEntry() {
  // The asarUnpack path on disk — child processes can't read inside .asar
  return path.join(
    process.resourcesPath,
    'app.asar.unpacked', 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js'
  );
}

function qmdCmd(args) {
  if (app.isPackaged) {
    return {
      bin: process.execPath,
      cmdArgs: [bundledQmdEntry(), ...args],
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return {
    bin: process.env.QMD_BIN || 'qmd',
    cmdArgs: args,
    extraEnv: {},
  };
}

function extraNodePaths() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  try {
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    const def = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8').trim();
    const candidate = path.join(nvmDir, 'versions', 'node', def, 'bin');
    if (fs.existsSync(candidate)) extra.unshift(candidate);
  } catch {}
  const voltaBin = path.join(os.homedir(), '.volta', 'bin');
  if (fs.existsSync(voltaBin)) extra.unshift(voltaBin);
  return extra;
}

function qmdEnv(extraEnv = {}) {
  return {
    ...process.env,
    PATH: [process.env.PATH || '', ...extraNodePaths()].join(':'),
    ...extraEnv,
  };
}

async function checkQmdAvailable() {
  if (app.isPackaged) {
    return fs.existsSync(bundledQmdEntry());
  }
  return new Promise(resolve => {
    execFile(process.env.QMD_BIN || 'qmd', ['status'],
      { env: qmdEnv(), timeout: 8000 },
      (err) => resolve(!err || (err.code !== 'ENOENT' && err.code !== 127)));
  });
}

function runQmd(args) {
  const { bin, cmdArgs, extraEnv } = qmdCmd(args);
  return new Promise((resolve, reject) => {
    execFile(bin, cmdArgs, { env: qmdEnv(extraEnv), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; reject(err); }
        else resolve(stdout);
      });
  });
}

// ── server process ────────────────────────────────────────────────────────

async function isPortFree(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    return !r.ok;
  } catch {
    return true;
  }
}

function startServer() {
  // Pass QMD_BIN + QMD_NODE so server.mjs knows how to invoke qmd.
  // Packaged: QMD_NODE=process.execPath, QMD_BIN=path to dist/cli/qmd.js
  // Dev:      QMD_BIN=system `qmd` (QMD_NODE unset)
  const serverEnv = app.isPackaged
    ? qmdEnv({
        QMD_NODE: process.execPath,
        QMD_BIN:  bundledQmdEntry(),
        ELECTRON_RUN_AS_NODE: '1',
      })
    : qmdEnv({ QMD_BIN: process.env.QMD_BIN || 'qmd', ELECTRON_RUN_AS_NODE: '1' });
  // utilityProcess.fork() fails on some macOS versions (bad option: --type=utility).
  // Use spawn with ELECTRON_RUN_AS_NODE=1 instead — equivalent but more compatible.
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: serverEnv,
    stdio: 'pipe',
  });
  serverProcess.stdout?.on('data', c => process.stdout.write('[server] ' + c));
  serverProcess.stderr?.on('data', c => process.stderr.write('[server] ' + c));
  serverProcess.on('exit', code => {
    if (!quitting) {
      console.log(`[server] exited (${code}), restarting in 2 s`);
      setTimeout(startServer, 2000);
    }
  });
}

async function waitForServer(ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${SERVER_URL}/`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ── first-run detection ───────────────────────────────────────────────────

async function isFirstRun() {
  try {
    const cfg = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
    return !cfg.setupDone;
  } catch {
    return true;
  }
}

async function markSetupDone() {
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify({ setupDone: true }), 'utf8');
}

async function hasQmdCollections() {
  try {
    const out = await runQmd(['collection', 'list']);
    return /^[a-zA-Z0-9_-]+\s+\(qmd:\/\//m.test(out);
  } catch {
    return false;
  }
}

// ── folder scanning ───────────────────────────────────────────────────────

const HIGH_CONFIDENCE = [
  'notes', 'obsidian', 'writing', 'journal', 'blog', 'wiki',
  'knowledge', 'vault', 'pkm', 'zettelkasten', 'logseq', 'roam',
  'bear', 'craft', 'drafts', 'dendron', 'foam', 'second brain',
];
const SKIP_TOP = new Set([
  'library', 'applications', 'movies', 'music', 'pictures',
  'public', 'developer', 'sites',
]);

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'notes';
}

async function countMdFiles(dir, maxDepth) {
  let count = 0;
  async function walk(d, depth) {
    if (depth > maxDepth || count > 200) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory() && depth < maxDepth) await walk(path.join(d, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) count++;
      if (count > 200) return;
    }
  }
  await walk(dir, 0);
  return count;
}

async function scanForNoteFolders() {
  const home = os.homedir();
  const candidates = [];
  const seen = new Set();

  function add(dir, label, checked) {
    const real = path.resolve(dir);
    if (seen.has(real)) return;
    seen.add(real);
    candidates.push({ dir: real, name: slugify(label), label, checked, count: 0 });
  }

  // iCloud Obsidian (highest priority — very specific path)
  const iCloudObs = path.join(home, 'Library/Mobile Documents/iCloud~md~obsidian');
  if (fs.existsSync(iCloudObs)) add(iCloudObs, 'Obsidian (iCloud)', true);

  let topDirs = [];
  try { topDirs = await fsp.readdir(home, { withFileTypes: true }); } catch {}

  for (const entry of topDirs) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (SKIP_TOP.has(entry.name.toLowerCase())) continue;

    const full = path.join(home, entry.name);
    const lower = entry.name.toLowerCase();

    if (entry.name === 'Documents') {
      // Scan Documents subdirs — don't add Documents itself (too broad)
      let docDirs = [];
      try { docDirs = await fsp.readdir(full, { withFileTypes: true }); } catch {}
      for (const de of docDirs) {
        if (!de.isDirectory() || de.name.startsWith('.')) continue;
        const deFull = path.join(full, de.name);
        const deLower = de.name.toLowerCase();
        const isKnown = HIGH_CONFIDENCE.some(n => deLower.includes(n));
        if (isKnown) {
          add(deFull, `${de.name}`, true);
        } else {
          const n = await countMdFiles(deFull, 2);
          if (n >= 5) add(deFull, `Documents/${de.name}`, n >= 20);
        }
      }
    } else if (entry.name === 'Dropbox') {
      // Scan Dropbox subdirs
      let dropDirs = [];
      try { dropDirs = await fsp.readdir(full, { withFileTypes: true }); } catch {}
      for (const de of dropDirs) {
        if (!de.isDirectory() || de.name.startsWith('.')) continue;
        const deFull = path.join(full, de.name);
        const deLower = de.name.toLowerCase();
        const isKnown = HIGH_CONFIDENCE.some(n => deLower.includes(n));
        const n = isKnown ? 10 : await countMdFiles(deFull, 2);
        if (isKnown || n >= 10) add(deFull, `Dropbox/${de.name}`, n >= 5 || isKnown);
      }
    } else if (HIGH_CONFIDENCE.some(n => lower.includes(n))) {
      add(full, entry.name, true);
    } else {
      const n = await countMdFiles(full, 2);
      if (n >= 10) add(full, entry.name, n >= 50);
    }
  }

  // Populate md file counts for all candidates
  await Promise.all(candidates.map(async c => {
    if (c.count === 0) c.count = await countMdFiles(c.dir, 3);
  }));

  // Don't auto-check folders with no markdown files
  for (const c of candidates) {
    if (c.count === 0) c.checked = false;
  }

  return candidates;
}

// ── window creation ───────────────────────────────────────────────────────

function loadingHTML() {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark ? '#141414' : '#f5f5f7';
  const fg = dark ? '#555'    : '#aaa';
  return `data:text/html,<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:${bg};color:${fg};font:14px system-ui,-apple-system;}</style></head>
    <body>Starting qmd-ui…</body></html>`;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 700, minHeight: 500,
    titleBarStyle: 'default',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow.loadURL(loadingHTML());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost'))
      return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return mainWindow;
}

function createWizardWindow() {
  wizardWindow = new BrowserWindow({
    width: 620, height: 540, resizable: false,
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,          // preload needs require('electron')
      preload: PRELOAD_PATH,
    },
  });
  wizardWindow.loadFile(SETUP_PATH);
  wizardWindow.on('closed', () => {
    wizardWindow = null;
    if (!mainWindow) app.quit();  // quit if wizard closed without finishing
  });
}

function createPrefsWindow() {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return;
  }
  prefsWindow = new BrowserWindow({
    width: 520, height: 500, resizable: true, maxHeight: 800,
    title: 'Preferences',
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: PRELOAD_PATH,
    },
  });
  prefsWindow.loadFile(PREFS_PATH);
  prefsWindow.on('closed', () => { prefsWindow = null; });
}

// ── tray ─────────────────────────────────────────────────────────────────

function trayIcon(status) {
  // status: 'ok' | 'busy' | 'error'
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(true); // auto-adapts to dark/light menu bar
  return img;
}

function buildTrayMenu(status) {
  const statusLabel =
    status === 'ok'    ? '● Running'   :
    status === 'busy'  ? '◌ Starting…' : '○ Not running';

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open qmd-ui',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else launchMainApp();
      },
    },
    {
      label: 'Reindex now',
      click: () => {
        if (mainWindow) mainWindow.webContents.executeJavaScript("runCommand('update')").catch(() => {});
        else fetch(`${SERVER_URL}/api/update`, { method: 'POST' }).catch(() => {});
      },
    },
    { type: 'separator' },
    { label: 'Preferences…', click: () => createPrefsWindow() },
    { type: 'separator' },
    { label: 'Quit qmd-ui', role: 'quit' },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon('busy'));
  tray.setToolTip('qmd-ui');
  tray.setContextMenu(buildTrayMenu('busy'));

  // Single-click on tray icon → show/focus main window
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else launchMainApp();
  });

  startStatusPolling();
}

async function checkServerStatus() {
  try {
    const r = await fetch(`${SERVER_URL}/`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

function startStatusPolling() {
  async function poll() {
    const status = await checkServerStatus();
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(buildTrayMenu(status));
      // Could update icon here too if we had distinct icons per state
    }
  }
  poll();
  statusTimer = setInterval(poll, 30_000);
}

// ── app menu ─────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: () => createPrefsWindow() },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
            else dialog.showMessageBox({ message: 'Auto-update only runs in the packaged app.' });
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ]},
    { label: 'Window', submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── auto-update ───────────────────────────────────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', info => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `qmd-ui ${info.version} is ready to install.`,
      detail: 'The update will be applied the next time you quit qmd-ui.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', err => {
    console.error('[updater]', err.message);
  });

  // Delay first check so startup isn't blocked
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }, 10_000);
}

// ── IPC handlers (used by wizard) ─────────────────────────────────────────

ipcMain.handle('scan-folders', async () => {
  return scanForNoteFolders();
});

ipcMain.handle('add-collection', async (_, { dir }) => {
  return runQmd(['collection', 'add', dir]);
});

ipcMain.handle('open-folder-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Choose a folder to index',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = result.filePaths[0];
  return { dir, name: slugify(path.basename(dir)), label: path.basename(dir), checked: true, count: 0 };
});

ipcMain.handle('run-update', async () => {
  return new Promise((resolve, reject) => {
    const { bin, cmdArgs, extraEnv } = qmdCmd(['update']);
    const proc = spawn(bin, cmdArgs, { env: qmdEnv(extraEnv) });
    proc.stdout.on('data', chunk => {
      const line = chunk.toString().trim();
      if (line && wizardWindow) wizardWindow.webContents.send('update-progress', line);
    });
    proc.stderr.on('data', chunk => {
      const line = chunk.toString().trim();
      if (line && wizardWindow) wizardWindow.webContents.send('update-progress', line);
    });
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`qmd update exited with code ${code}`));
    });
    proc.on('error', reject);
  });
});

ipcMain.handle('run-embed', async () => {
  const { bin, cmdArgs, extraEnv } = qmdCmd(['embed']);
  const proc = spawn(bin, cmdArgs, { env: qmdEnv(extraEnv), stdio: 'ignore' });
  proc.unref();
  return 'started';
});

ipcMain.handle('get-status', async () => {
  return runQmd(['status']);
});

ipcMain.handle('finish-setup', async () => {
  await markSetupDone();
  enableLoginItem();

  // Create main window FIRST so its existence prevents app.quit() in wizard's closed handler
  createMainWindow();

  if (wizardWindow) { wizardWindow.destroy(); wizardWindow = null; }

  if (await isPortFree(PORT)) startServer();

  const ready = await waitForServer();
  if (mainWindow) {
    mainWindow.loadURL(ready ? SERVER_URL :
      `data:text/html,<!doctype html><html><body style="background:#141414;color:#f87171;font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">Server failed to start.</body></html>`);
  }
});

// ── main ──────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  createTray();
  if (app.isPackaged) setupAutoUpdater();

  // Verify qmd is installed before continuing
  const qmdFound = await checkQmdAvailable();
  if (!qmdFound) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'qmd not found',
      message: 'qmd must be installed to use qmd-ui.',
      detail: 'Install it with Node.js:\n\n    npm install -g @tobilu/qmd\n\nOr with Bun:\n\n    bun add -g @tobilu/qmd\n\nThen restart qmd-ui.',
      buttons: ['Quit', 'Open qmd on npm'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) shell.openExternal('https://www.npmjs.com/package/@tobilu/qmd');
    app.quit();
    return;
  }

  const firstRun  = await isFirstRun();
  const forceSetup = process.env.FORCE_SETUP === '1';

  if (firstRun || forceSetup) {
    const alreadyConfigured = !forceSetup && await hasQmdCollections();
    if (alreadyConfigured) {
      await markSetupDone();
      enableLoginItem();
      launchMainApp();
    } else {
      createWizardWindow();
    }
  } else {
    launchMainApp();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      isFirstRun().then(first => {
        if (first) createWizardWindow(); else launchMainApp();
      });
    }
  });
});

function enableLoginItem() {
  app.setLoginItemSettings({ openAtLogin: true });
}

async function launchMainApp() {
  createMainWindow();
  if (await isPortFree(PORT)) startServer();
  const ready = await waitForServer();
  if (mainWindow) mainWindow.loadURL(ready ? SERVER_URL : loadingHTML());
}

app.on('before-quit', () => {
  quitting = true;
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (tray) { tray.destroy(); tray = null; }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
