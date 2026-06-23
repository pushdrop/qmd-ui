# qmd-ui — design notes

**Goal:** type a query, see ranked results from a local qmd index, read and edit the doc, jump to the file. Feels instant, looks native, zero maintenance.

## Decision: browser-based, not Swift

A single-file local web server + one HTML page beats a Swift app here:

- qmd is a CLI/daemon; any UI is a thin shell around it. A SwiftUI app adds Xcode, signing, and a build pipeline for what is fundamentally "textbox → JSON → list".
- macOS gives web pages an app-like presence for free: open the page in Safari → **File → Add to Dock**. You get a dock icon, its own window, no browser chrome.
- Iterating on ranking display, snippets, and keyboard shortcuts is minutes in HTML vs. rebuild cycles in Swift.

Runtime: **Node** (`/opt/homebrew/bin/node`, already installed), **zero npm dependencies** — only `node:http`, `node:child_process`, and `node:fs/promises`.

## Measured performance (2026-06-12)

| Path | Latency | Use |
|---|---|---|
| `qmd search --json` (BM25, CLI spawn) | ~0.1 s | as-you-type results |
| `query` tool via warm HTTP daemon (hybrid lex+vec+rerank) | ~4 s | deep search on Enter |
| Same, cold daemon (model load) | ~12 s | first deep search only |

This forces the core UX decision: **two search tiers**.

1. **Instant tier** — every keystroke (debounced 150 ms) runs BM25 via `qmd search --json -n 20`. Results update live.
2. **Deep tier** — pressing **Enter** runs a hybrid semantic query through the MCP HTTP daemon. A "deep search…" spinner shows while it runs; if the daemon is cold, shows "warming models (~10 s, first search only)".

## Architecture

```
~/qmd-ui/
  server.mjs    # Node HTTP server, endpoints, MCP session, path resolution
  index.html    # Single-file UI — inline CSS/JS, no build step
  install.sh    # Generates and loads the LaunchAgent plist
  SPEC.md       # this file
```

```
Browser (localhost:8765)
   │  same-origin fetch
   ▼
server.mjs ──execFile──▶ qmd search --json   (instant BM25)
           ──execFile──▶ qmd update           (reindex)
           ──execFile──▶ qmd collection show  (path resolution at startup)
           ──execFile──▶ find *.md            (folder list, cached at startup)
           ──execFile──▶ open / open -R       (open file / reveal in Finder)
           ──fs.readFile──▶ disk              (raw file content for preview/edit)
           ──fs.writeFile──▶ disk             (save edits)
           ──HTTP──▶ qmd mcp daemon :8181     (deep hybrid search)
```

The server binds **127.0.0.1 only**. Nothing is reachable from the network.

## server.mjs

### Startup sequence

1. `GET http://127.0.0.1:8181/health`; if unreachable, spawn `qmd mcp --http --daemon` and poll.
2. `cacheRoots()` — parse `qmd collection list` + `qmd collection show <name>` to build a `Map<name, absolutePath>` used to resolve `qmd://home/foo.md → /Users/you/foo.md`.
3. `cacheFolders()` — `find <root> -maxdepth 8 -name '*.md'`, collect unique parent directories. Backing store for the folder scope picker. Also re-run after every `/api/update`.
4. Listen on `127.0.0.1:8765`.

### Path normalization

qmd normalizes underscores to dashes in its index (`RECON_SEED_PROMPT.md` → `RECON-SEED-PROMPT.md`). `resolveRealPath(p)` tries the given path, then `basename` with `-↔_` swapped, returning whichever exists on disk.

All search results run through `toAbsolutePath()` (strips `qmd://`, maps collection name to root) then `resolveRealPath()`. Results whose file doesn't exist on disk are filtered out before returning to the client — stale index entries are silently dropped.

### Endpoints

All shell-outs use `execFile` (argument array, never string interpolation into a shell).

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Serve `index.html` (read from disk on every request — UI changes take effect on next refresh) |
| `/api/search?q=` | GET | `qmd search --json -n 20 q` → resolve paths → filter missing → return JSON |
| `/api/query` `{q}` | POST | MCP `tools/call` on daemon (lex+vec+rerank, limit 20) → resolve → filter |
| `/api/raw?file=` | GET | `fs.readFile` the resolved path; returns `X-File-Mtime` header; 404 if not found |
| `/api/save` `{file, content}` | POST | `fs.writeFile` → `qmd update` |
| `/api/open` `{file, reveal}` | POST | Validate path is inside a collection root, then `open` or `open -R` |
| `/api/update` | POST | `qmd update`, then refresh folder cache |
| `/api/status` | GET | `qmd status` |
| `/api/folders` | GET | Return cached folder list (built from `find *.md`, populated at startup) |

### MCP session

The daemon speaks MCP Streamable HTTP at `POST /mcp`. The server keeps **one session for its lifetime**: `initialize` → capture `Mcp-Session-Id` → `notifications/initialized` → `tools/call` per deep search. On any error, drop session, re-handshake, retry once.

## index.html

Single page, inline `<style>` and `<script>`, no framework. Markdown rendered via `marked` (CDN); falls back to `<pre>` if offline.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [ search box ]  deep…  ↩ deep ↑↓ nav esc clear  📁 ↺ ℹ ▐ │
├──────────────────────────┬──────────────────────────────────┤
│ [scope chip]  N results  │ ~/path/to/file.md  Jun 23  □ … │
│ ─────────────────────    │ ─────────────────────────────── │
│ Title             93%    │ rendered markdown               │
│ ~/docs/file.md           │                                 │
│ snippet…                 │ [Edit ⌘E] [Open ⌘O] [Reveal ⌘⇧F]│
│ ▸ Title           54%    │                                 │
└──────────────────────────┴──────────────────────────────────┘
```

**Landing state** — on load with no query, `#main` is hidden and the header floats centered as a search card. First keystroke or URL `?q=` exits landing.

**Folder scope** — folder icon button opens a dropdown with a type-to-filter input over all directories containing `.md` files (word-based match: "msmd docs" narrows to paths containing both). Recent selections stored in localStorage. Active scope shown as a dismissable chip in the results status bar; count shows "4 of 17 results".

**Live editor** — ⌘E opens CodeMirror 6 (lazy-loaded from esm.sh CDN, cached after first load). ⌘S saves to disk and runs `qmd update`. Cancel restores the preview. Preview always reads from disk (`/api/raw`) so it reflects actual file content.

**Preview header** — shows friendly path (`~/…`), last-modified time (relative: "2h ago", "Jun 12"), copy-path button, and Edit/Open/Reveal buttons.

**Sidebar** — drag the resizer to resize; drag below 120 px or click the panel icon button to collapse. The `‹/›` handle on the resizer also toggles.

**Toast** — Reindex and Index Info buttons show a fixed toast notification at the bottom of the screen (works in both landing and search states, auto-dismisses after 4 s).

### Keyboard shortcuts

| Key | Action |
|---|---|
| Type | Instant BM25 (150 ms debounce) |
| ↩ | Deep semantic search |
| ↑ / ↓ | Navigate results (global — works regardless of focus) |
| ⌘E | Edit selected file |
| ⌘S | Save (while editing) |
| ⌘O | Open in default editor |
| ⌘⇧F | Reveal in Finder |
| Esc | Cancel edit / clear query / return to landing |

## Mac integration

- **Dock app:** open `http://localhost:8765` in Safari → File → Add to Dock.
- **Always running:** LaunchAgent `~/Library/LaunchAgents/com.qmd-ui.server.plist` (generated by `install.sh`) with `RunAtLoad` + `KeepAlive`. The server keeps the qmd daemon alive.
- **Hotkey:** Raycast / Shortcuts: `open "http://localhost:8765/?q={query}"` — page reads `?q=` on load and searches immediately.

## Failure modes

| Failure | Handling |
|---|---|
| qmd daemon not running | server spawns it on startup; deep search re-checks `/health` and respawns before failing |
| First deep search ~12 s | "warming models" UI state, never a silent hang |
| MCP session invalidated | one transparent re-handshake + retry |
| `qmd` binary missing/erroring | 500 with stderr; shown in results area |
| Path traversal via `/api/open` or `/api/save` | resolved path must be inside a collection root; 400 otherwise |
| File in index but deleted/moved on disk | `resolveRealPath` fails both variants → filtered from search results |
| qmd dash/underscore normalization | `resolveRealPath` tries both variants; real path returned to client |
