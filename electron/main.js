'use strict';

const { app, BrowserWindow, Menu, nativeTheme, shell } = require('electron');
const { utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.resolve(__dirname, '..', 'server.mjs');
const PORT = Number(process.env.PORT) || 8765;
const SERVER_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let serverProcess = null;
let quitting = false;

// ── single instance ──────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── qmd binary path ──────────────────────────────────────────────────────────

function qmdBin() {
  if (app.isPackaged) {
    // Bundled binary copied in by CI — see electron-builder.yml extraResources
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const bin = path.join(process.resourcesPath, 'bin', `qmd-darwin-${arch}`);
    if (fs.existsSync(bin)) return bin;
    // Fall through to system qmd if somehow missing (should not happen in production)
  }
  return process.env.QMD_BIN || 'qmd';
}

// ── server process ───────────────────────────────────────────────────────────

async function isPortFree(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    return !r.ok; // if something answered, port is in use
  } catch {
    return true; // connection refused → port is free
  }
}

function startServer() {
  const env = {
    ...process.env,
    QMD_BIN: qmdBin(),
    PORT: String(PORT),
    // Ensure Homebrew paths are available even in a sandboxed Electron env
    PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  };

  serverProcess = utilityProcess.fork(SERVER_PATH, [], { env, stdio: 'pipe' });

  serverProcess.stdout?.on('data', chunk => process.stdout.write('[server] ' + chunk));
  serverProcess.stderr?.on('data', chunk => process.stderr.write('[server] ' + chunk));

  serverProcess.on('exit', code => {
    if (!quitting) {
      console.log(`[server] exited (code ${code}), restarting in 2 s…`);
      setTimeout(startServer, 2000);
    }
  });
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${SERVER_URL}/`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ── window ───────────────────────────────────────────────────────────────────

function loadingHTML() {
  const dark = nativeTheme.shouldUseDarkColors;
  const bg = dark ? '#141414' : '#f5f5f7';
  const fg = dark ? '#555'    : '#aaa';
  return `data:text/html,<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:${bg};color:${fg};font:14px system-ui,-apple-system;}</style></head>
    <body>Starting qmd-ui…</body></html>`;
}

function errorHTML(msg) {
  return `data:text/html,<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;background:#141414;color:#f87171;font:14px system-ui,-apple-system;gap:8px;}
    code{font-size:12px;color:#888;}</style></head>
    <body><div>${msg}</div><code>Check the logs for details.</code></body></html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    minHeight: 500,
    // Standard title bar for Phase 1 — custom hiddenInset comes with wizard in Phase 2
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(loadingHTML());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in the default browser, not in the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── menu ─────────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // Preferences enabled in Phase 4
        { label: 'Preferences…', accelerator: 'Cmd+,', enabled: false, click: () => {} },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── main ─────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  createWindow();

  // Don't compete with a server already on this port (e.g. dev LaunchAgent)
  if (await isPortFree(PORT)) {
    startServer();
  } else {
    console.log(`[main] port ${PORT} already in use, skipping server spawn`);
  }

  const ready = await waitForServer();

  if (mainWindow) {
    if (ready) {
      mainWindow.loadURL(SERVER_URL);
    } else {
      mainWindow.loadURL(errorHTML('Server failed to start after 60 s.'));
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
