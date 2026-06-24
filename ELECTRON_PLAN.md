# qmd-ui Electron Packaging Plan

**Goal:** A self-contained Mac app that anyone can download and use without knowing what a terminal is. They download it, open it, follow a short wizard, and have a working semantic notes search engine — no manual steps.

---

## User persona

The target user is a heavy markdown note-taker (Obsidian, Bear exports, plain files, Notion exports) who is not an engineer. They:

- Are comfortable downloading and opening a `.dmg`
- Have never used a terminal
- Don't know what Homebrew is
- Have notes scattered across 2–4 folders
- Will not tolerate an install that takes more than 5 minutes or asks confusing questions

Everything in the design flows from this person.

---

## Architecture: thin Electron shell

The existing `server.mjs` + `index.html` are untouched — they already work well and are the full product. Electron's only jobs are:

1. Bundle and manage the `qmd` binary
2. Start and monitor `server.mjs` as a child process
3. Show a first-run setup wizard
4. Open a `BrowserWindow` pointed at `localhost:8765`
5. Provide a native app presence (dock icon, menu bar)
6. Handle updates

```
qmd-ui.app
  └─ Electron main process (main.js)
       ├─ spawns: node server.mjs  ──→  existing server, unchanged
       │                └─ spawns: qmd mcp daemon (already in server.mjs)
       └─ opens: BrowserWindow → http://127.0.0.1:8765
```

No rewrite of the UI. The web layer stays as-is.

---

## Component 1: qmd binary strategy

### The problem

qmd has no pre-built binaries on GitHub releases — only empty tags. Distribution options ranked by user-friendliness:

| Option | Setup friction | Maintenance | Notes |
|---|---|---|---|
| **A. Bundle binary in .app** | None — zero clicks | App update = qmd update | Requires signing; binary at build time via CI |
| **B. Auto-install via Homebrew** | 2–5 min install if no Brew | qmd updates independently | Brew itself needs to be installed first |
| **C. Prompt user to install** | High — requires terminal | None | Fails the non-engineer test |

**Recommendation: Option A — bundle the binary.**

Rationale: The non-engineer persona cannot install Homebrew, and showing them a terminal during setup immediately breaks the "just works" experience. A bundled binary means the app is a single download with no dependencies.

### How bundling works

qmd is a Go binary. At CI build time (GitHub Actions):

```yaml
# .github/workflows/build.yml
- name: Install qmd (ARM)
  run: brew install tobi/tap/qmd
- name: Copy binary
  run: |
    cp $(which qmd) electron/resources/bin/qmd-darwin-arm64
    chmod +x electron/resources/bin/qmd-darwin-arm64
```

A separate job on an Intel runner does the same for `qmd-darwin-x64`. The app ships with both; at runtime, main.js picks the right one:

```js
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const QMD_BIN = path.join(process.resourcesPath, 'bin', `qmd-darwin-${arch}`);
```

The Electron app must be **code-signed and notarized** (Apple Developer account required) for macOS Gatekeeper to allow running a bundled binary without quarantine warnings. Without this, users would see "cannot be opened because the developer cannot be verified." This is a hard requirement for Option A.

### If signing is not available yet

Fall back to **Option B with Homebrew**: during first run, detect if `brew` is on PATH. If yes, run `brew install tobi/tap/qmd` in a visible progress step. If no Brew, show a friendly one-click Homebrew installer that guides them through it (the Homebrew install is a one-liner, and the Electron app can show it in a terminal pane with explanation). This is slower and more complex but avoids the signing requirement for early development.

**Decision needed:** Do you have an Apple Developer account for signing? That determines which path to take.

---

## Component 2: Electron shell (main.js)

### Responsibilities

1. **Single instance lock** — if the app is already running, focus the existing window
2. **First-run detection** — check if qmd has any collections configured
3. **Child process management** — spawn and monitor `server.mjs`
4. **IPC handlers** — respond to renderer requests for setup operations (add collection, scan folders, run update)
5. **Window management** — main window + optional separate wizard window
6. **Menu bar / tray** — persistent presence while app is open
7. **Auto-update** — check on launch, install in background

### Startup sequence

```
App opens
  │
  ├─ acquire single-instance lock
  │    └─ if already running → focus existing window, quit this instance
  │
  ├─ set QMD_BIN to bundled binary path
  │
  ├─ spawn server.mjs as child process
  │    └─ wait for HTTP ready (poll /api/status with timeout)
  │
  ├─ check first-run flag (stored in userData/config.json)
  │    ├─ first run? → open wizard window
  │    └─ not first run? → open main window
  │
  └─ register IPC handlers, menu, tray
```

### Child process management

```js
// Spawn server, capture logs, restart on crash
function startServer() {
  const server = child_process.spawn(process.execPath, [serverPath], {
    env: { ...process.env, QMD_BIN, PORT: '8765', QMD_DAEMON_URL: 'http://127.0.0.1:8181' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', d => log(d));
  server.stderr.on('data', d => log(d));
  server.on('exit', (code) => {
    if (!appQuitting) setTimeout(startServer, 2000); // restart on crash
  });

  return server;
}
```

When the app quits, kill server (which lets the qmd daemon die on its own since it's already detached).

### IPC handlers (for wizard)

The wizard renderer communicates with main via `ipcMain`:

| Channel | Direction | Purpose |
|---|---|---|
| `scan-folders` | renderer → main | Detect candidate folders on disk |
| `add-collection` | renderer → main | Run `qmd collection add <name> <path>` |
| `remove-collection` | renderer → main | Run `qmd collection remove <name>` |
| `run-update` | renderer → main | Run `qmd update`, stream progress |
| `run-embed` | renderer → main | Run `qmd embed` (background) |
| `list-collections` | renderer → main | Run `qmd collection list` |
| `update-progress` | main → renderer | Stream stdout lines back to wizard |

These same operations (add/remove collection) are also exposed as new server.mjs API endpoints once the app is running, for the Preferences window.

---

## Component 3: first-run wizard

The wizard is a separate HTML page (`setup.html`) loaded in a smaller `BrowserWindow` (640×520). It guides users through 4 steps with a progress indicator at the top.

### Step 1 — Welcome

```
┌───────────────────────────────────────────┐
│                                           │
│   🔍  qmd-ui                             │
│                                           │
│   Instant search for all your notes.     │
│                                           │
│   We'll help you get set up in about     │
│   2 minutes.                             │
│                                           │
│   Everything stays on your Mac.          │
│   Nothing is sent to the cloud.          │
│                                           │
│                    [Get started →]        │
└───────────────────────────────────────────┘
```

### Step 2 — Choose folders

The app scans the home directory for likely note folders. Detection heuristics:

**Auto-check (high confidence):**
- Any folder named: `Notes`, `Obsidian`, `Writing`, `Journal`, `Blog`, `Wiki`, `Knowledge`, `Vault`, `PKM`, `Zettelkasten`, `Roam`, `Logseq`
- Any folder in `~/Documents` that contains ≥10 `.md` files within 2 levels
- `~/Library/Mobile Documents/iCloud~md~obsidian` (iCloud Obsidian)
- Any Dropbox/Google Drive subfolder containing `.md` files

**Show but don't auto-check:**
- `~/Documents` (too broad — might contain lots of non-notes)
- `~/Desktop`
- `~/Downloads`

**Never show:**
- `~/Library`, `~/.Trash`, hidden dirs, `node_modules` parents, `Applications`

```
┌───────────────────────────────────────────┐
│  ●●○○  Choose your note folders          │
│                                           │
│  We found these folders with markdown     │
│  files. Check the ones you want to        │
│  search.                                  │
│                                           │
│  ✓ ~/Documents/Notes      (47 files)     │
│  ✓ ~/Obsidian/My Vault    (312 files)    │
│  □ ~/Documents             (2,841 files) │
│  □ ~/Downloads             (noise)       │
│                                           │
│  [+ Add a folder…]                       │
│                                           │
│  ─────────────────────────────────────── │
│  Skipping hidden folders, node_modules,  │
│  and system files automatically.         │
│                                           │
│  [Back]          [Index these folders →]  │
└───────────────────────────────────────────┘
```

Clicking `+ Add a folder…` opens a native `dialog.showOpenDialog` folder picker.

### Step 3 — Indexing

```
┌───────────────────────────────────────────┐
│  ●●●○  Building your search index        │
│                                           │
│  ✓  ~/Documents/Notes       47 files     │
│  ↺  ~/Obsidian/My Vault     indexing…    │
│     ████████████░░░░░░░░░░  64%          │
│                                           │
│  This usually takes under a minute.      │
│                                           │
│  Also enabling deep semantic search.     │
│  This runs in the background and makes   │
│  your first ↩ search smarter.            │
│                                           │
│  (This is the only step that takes a    │
│   few minutes — only happens once.)      │
└───────────────────────────────────────────┘
```

What actually runs here:
1. For each checked folder: `qmd collection add <name> <path>` (skips if already exists)
2. `qmd update` — BM25 index, 5–30 seconds depending on file count
3. `qmd embed` — vector embeddings, runs **in background** without blocking. The spinner in this step completes after `qmd update`; embed is fire-and-forget with a note that "deep search improves over the next few minutes."

Progress comes from streaming stdout of `qmd update` back via IPC.

### Step 4 — Done

```
┌───────────────────────────────────────────┐
│  ●●●●  You're ready                      │
│                                           │
│  Found 1,204 notes across 2 folders.     │
│                                           │
│  ┌─ Tips ─────────────────────────────┐  │
│  │ • Type to search instantly         │  │
│  │ • Press ↩ for deeper results       │  │
│  │ • ⌘E to edit a file in the app    │  │
│  └────────────────────────────────────┘  │
│                                           │
│  qmd-ui will run in your menu bar so     │
│  it's always one click away.             │
│                                           │
│                  [Open qmd-ui →]          │
└───────────────────────────────────────────┘
```

On click: close wizard window, open main BrowserWindow to `http://127.0.0.1:8765`, write `{ setupDone: true }` to `userData/config.json`.

---

## Component 4: Preferences window

A separate window (accessible from menu bar → Preferences, or ⌘,) for managing collections after setup:

```
┌───────────────────────────────────────────┐
│  Preferences                              │
│                                           │
│  Indexed folders                         │
│  ─────────────────────────────────────── │
│  notes          ~/Documents/Notes        │
│  vault          ~/Obsidian/My Vault  [×] │
│                                           │
│  [+ Add folder]                          │
│                                           │
│  ─────────────────────────────────────── │
│  [Reindex now]    Last indexed: 2h ago   │
│                                           │
│  Deep search      [● enabled]            │
│  (runs qmd embed after each reindex)     │
│                                           │
│  Start at login   [● enabled]            │
└───────────────────────────────────────────┘
```

New server endpoints needed for this:
- `POST /api/collections/add { name, path }` → runs `qmd collection add`
- `DELETE /api/collections/:name` → runs `qmd collection remove`

These wrap the same IPC handlers used in the wizard; the wizard just calls them directly via IPC before the server is ready.

---

## Component 5: menu bar / tray

A small persistent presence while the app is open:

```
Menu bar icon (magnifying glass or qmd logo)
  │
  └─ Click → show/hide main window
     Right-click or dropdown:
       Open qmd-ui          (focus main window)
       ─────────────────
       Reindex now
       Index status…
       Preferences…
       ─────────────────
       Check for updates
       ─────────────────
       Quit qmd-ui
```

Status dot on the icon:
- **Green** — server running, index fresh
- **Yellow** — indexing in progress
- **Red** — server not responding

Open at login: handled by `app.setLoginItemSettings({ openAtLogin: true })` — no LaunchAgent needed.

---

## Component 6: auto-update

Use `electron-updater` pointing at GitHub releases. The release pipeline (below) publishes a `latest-mac.yml` alongside the `.dmg` and `.zip`.

On launch: check for update in the background (silent). If found, download silently. When ready, show a notification: "A new version is ready — restart to update." User clicks → `autoUpdater.quitAndInstall()`.

No forced updates; user is in control.

---

## Build and distribution pipeline

### Repository structure

```
qmd-ui/
  server.mjs          ← unchanged
  index.html          ← unchanged
  install.sh          ← keep for headless/CLI install
  SPEC.md, README.md  ← update to mention Electron app

  electron/
    main.js           ← Electron main process
    preload.js        ← context bridge (IPC exposure to renderer)
    setup.html        ← first-run wizard
    setup.js          ← wizard JS
    prefs.html        ← preferences window
    package.json      ← Electron dependencies
    electron-builder.yml
    resources/
      bin/
        qmd-darwin-arm64   ← copied in by CI
        qmd-darwin-x64     ← copied in by CI
        .gitignore         ← ignore the binaries (they're big)
    scripts/
      fetch-qmd.sh    ← CI script: brew install + copy binary
```

### Build matrix (GitHub Actions)

```
build-mac-arm64   runs-on: macos-14  (Apple Silicon)
  steps:
    brew install tobi/tap/qmd
    cp $(which qmd) electron/resources/bin/qmd-darwin-arm64
    npm run dist:mac-arm64

build-mac-x64     runs-on: macos-13  (Intel)
  steps:
    brew install tobi/tap/qmd
    cp $(which qmd) electron/resources/bin/qmd-darwin-x64
    npm run dist:mac-x64

release:
  needs: [build-mac-arm64, build-mac-x64]
  steps:
    merge artifacts
    create GitHub release with:
      qmd-ui-darwin-arm64.dmg
      qmd-ui-darwin-x64.dmg
      qmd-ui-darwin-universal.dmg  (lipo merge, if feasible)
      latest-mac.yml               (for electron-updater)
```

### electron-builder.yml (key settings)

```yaml
appId: com.qmd-ui.app
productName: qmd-ui
copyright: ...

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
    - target: zip        # zip required for electron-updater delta updates
  hardenedRuntime: true  # required for notarization
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist

extraResources:
  - from: resources/bin/
    to: bin/
    filter: ["qmd-darwin-*"]

nsis:                    # Windows (future)
  oneClick: false

publish:
  provider: github
  owner: pushdrop
  repo: qmd-ui
```

### entitlements.mac.plist

The bundled `qmd` binary needs to spawn child processes and write to disk. Required entitlements:

```xml
com.apple.security.cs.allow-unsigned-executable-memory  false
com.apple.security.cs.disable-library-validation       true
com.apple.security.automation.apple-events             true
com.apple.security.files.user-selected.read-write      true
```

Code signing + notarization requires: Apple Developer account (free tier won't work), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets in GitHub Actions.

---

## New server endpoints needed

Two new endpoints in `server.mjs` to support Preferences (add/remove collections after setup):

```
POST /api/collections/add    { name: string, path: string }
  → qmd collection add <name> <path>
  → rebuild collectionRoots cache
  → cacheFolders() (no await)
  → 200 OK

DELETE /api/collections/:name
  → qmd collection remove <name>
  → remove from collectionRoots
  → cacheFolders() (no await)
  → 200 OK
```

No other server changes needed. The wizard uses IPC (before server is needed), the Preferences window uses these endpoints (after server is running).

---

## What stays the same

- `server.mjs` is unchanged except two new endpoints
- `index.html` is unchanged — the main UI is the existing web UI
- `install.sh` stays for CLI/headless users who don't want the Electron app
- All keyboard shortcuts, search tiers, editor, folder scope picker — all unchanged

---

## Implementation phases

### Phase 1 — skeleton (get a window open)

- `electron/package.json`, `electron/main.js`
- Start server.mjs as child, open `BrowserWindow` to localhost:8765
- Menu bar with Quit
- Confirm everything works with existing server + UI

Deliverable: `npm start` in `electron/` opens the app in a window.

### Phase 2 — wizard

- `setup.html` with all 4 steps
- IPC handlers: `scan-folders`, `add-collection`, `run-update`, `run-embed`
- Folder detection algorithm
- First-run detection and routing

Deliverable: fresh install experience works end-to-end.

### Phase 3 — process management

- Server crash detection and restart
- Menu bar status dot
- `app.setLoginItemSettings` (launch at login)
- Graceful shutdown

Deliverable: the app is stable over days of use.

### Phase 4 — preferences

- `prefs.html` window
- New `/api/collections/add` and `/api/collections/remove` endpoints
- ⌘, opens Preferences

Deliverable: users can add/remove folders after first run.

### Phase 5 — build pipeline

- `electron-builder.yml`
- GitHub Actions workflow
- Code signing + notarization setup
- Auto-updater

Deliverable: `.dmg` download on GitHub releases, auto-update on launch.

---

## Open questions / decisions needed

1. **Apple Developer account?** Required for Option A (bundled binary). Without it, Phase 5 isn't possible — would need to fall back to Option B (Homebrew install during wizard).

2. **Universal binary vs. two downloads?** A universal `.app` (ARM + Intel, merged with `lipo`) is a single download but ~2× the size. Two separate `.dmg` files are smaller but require the user to pick the right one. Recommendation: universal binary — non-engineers shouldn't have to know their chip type.

3. **Windows/Linux?** The current server.mjs uses `open` (macOS command) for Finder reveal. Linux could use `xdg-open`. Windows needs more work. Recommendation: macOS only for now, keep the code clean so Linux is a later PR.

4. **qmd version pinning?** The bundled binary is a fixed version. If qmd releases a breaking change, the app needs an update. Options: check `qmd --version` on launch and warn if too old; or offer an in-app "Update qmd" flow for power users. Recommendation: warn only, keep it simple for now.

5. **What to name the collections during wizard?** `qmd collection add` needs a name. Options: derive from folder name (slugified), let the user name it, auto-name `notes`, `vault`, etc. Recommendation: auto-name from last path component, let them edit inline.
