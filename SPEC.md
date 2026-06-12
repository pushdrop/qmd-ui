# qmd-ui — a local search UI for qmd

**Goal:** type a query, see ranked results from the qmd index (733 docs in `home`), read the doc, jump to the file. Feels instant, looks native, zero maintenance.

## Decision: browser-based, not Swift

A single-file local web server + one HTML page beats a Swift app here:

- qmd is a CLI/daemon; any UI is a thin shell around it. A SwiftUI app adds Xcode, signing, and a build pipeline for what is fundamentally "textbox → JSON → list".
- macOS 26 gives web pages an app-like presence for free: open the page in Safari → **File → Add to Dock**. You get a dock icon, its own window, no browser chrome.
- Iterating on ranking display, snippets, and keyboard shortcuts is minutes in HTML vs. rebuild cycles in Swift.

Runtime: **Node** (`/opt/homebrew/bin/node`, already installed), **zero npm dependencies** — only `node:http` and `node:child_process`.

## Measured performance (this machine, 2026-06-12)

| Path | Latency | Use |
|---|---|---|
| `qmd search --json` (BM25, CLI spawn) | ~0.1 s | as-you-type results |
| `query` tool via warm HTTP daemon (hybrid lex+vec+rerank) | ~4 s | deep search on Enter |
| Same, cold daemon (model load) | ~12 s | first deep search only |
| `qmd query` via CLI spawn (cold every time) | ~7 s | ruled out — daemon is the right transport |

This forces the core UX decision: **two search tiers**.

1. **Instant tier** — every keystroke (debounced 150 ms) runs BM25 via `qmd search --json -n 20`. Results update live.
2. **Deep tier** — pressing **Enter** runs a hybrid semantic query through the MCP HTTP daemon and replaces the list. A subtle "deep search…" spinner shows while it runs; if the daemon is cold, show "warming models (~10 s, first search only)".

This matches how the tool actually performs instead of pretending hybrid search can be incremental.

## Architecture

```
~/qmd-ui/
  server.mjs    # ~150 lines: static page + 4 JSON endpoints + MCP session
  index.html    # ~250 lines: UI, inline CSS/JS, no build step
  SPEC.md       # this file
```

```
Browser (localhost:8765)
   │  same-origin fetch (no CORS issues)
   ▼
server.mjs ──spawn──▶ qmd search --json …      (instant tier)
   │       ──spawn──▶ qmd get / collection show (doc view, path resolution)
   │       ──HTTP───▶ qmd mcp daemon :8181/mcp  (deep tier, models stay warm)
   │       ──spawn──▶ open / open -R            (jump to file)
```

The server binds **127.0.0.1 only**. Nothing is reachable from the network.

## server.mjs

### Startup

1. `GET http://127.0.0.1:8181/health`; if unreachable, spawn `qmd mcp --http --daemon` and poll health (daemon logs to `~/.cache/qmd/mcp.log`).
2. Cache collection roots once: parse `qmd collection list` for names, then `qmd collection show <name>` for each `Path:` (e.g. `home → /Users/navid`). Used to resolve `qmd://home/foo.md` → `/Users/navid/foo.md`.
3. Listen on `127.0.0.1:8765`.

### Endpoints

All shell-outs use `execFile` (argument array, never string interpolation into a shell).

- `GET /` → `index.html`.
- `GET /api/search?q=` → `execFile('qmd', ['search', '--json', '-n', '20', q])`, pipe JSON through. Empty `q` → `[]`.
- `POST /api/query` `{q}` → MCP `tools/call` on the daemon (below). Build the query document server-side:
  ```json
  {"name":"query","arguments":{
    "searches":[{"type":"lex","query": q}, {"type":"vec","query": q}],
    "intent":"interactive search from qmd-ui",
    "limit": 20}}
  ```
  Return the `structuredContent.results` array (verified present in responses).
- `GET /api/doc?file=` → `execFile('qmd', ['get', file])`, return raw markdown as `text/plain`. Accepts the `file` string exactly as it appeared in search results.
- `POST /api/open` `{file, reveal}` → resolve `qmd://<collection>/<rel>` against the cached collection root, **verify the resolved absolute path is inside that root** (reject otherwise), then `open -R <path>` (reveal=true, Finder) or `open <path>` (default .md editor).

### MCP session handling (verified against the daemon)

The daemon speaks MCP Streamable HTTP at `POST /mcp`. The server keeps **one session for its lifetime**:

1. POST `initialize` (`protocolVersion: "2025-03-26"`, headers `Content-Type: application/json`, `Accept: application/json, text/event-stream`).
2. Capture the `Mcp-Session-Id` response header; send it on every subsequent request.
3. POST `notifications/initialized` once.
4. `tools/call` per deep search.

If a `tools/call` returns an error or non-200 (session expired, daemon restarted), drop the session, re-run the handshake, retry once. Serialize deep searches: if one is in flight and a new one arrives, abort the old fetch client-side; server-side, latest-wins.

## index.html

Single page, inline `<style>` and `<script>`, no framework.

**Layout** — Spotlight-like:

```
┌─────────────────────────────────────────────────────┐
│  🔍  [ search box                                 ]  │
│      "↩ deep search · esc clear"                     │
├──────────────────────────┬──────────────────────────┤
│ results (scrolls)        │ preview pane             │
│ ▸ Title          93%     │ rendered markdown of     │
│   home/sikulix/README.md │ the selected result      │
│   snippet…               │                          │
│ ▸ Title          54%     │  [Open ⌘O] [Reveal ⌘R]   │
└──────────────────────────┴──────────────────────────┘
```

**Behavior**

- Keystroke → debounce 150 ms → `/api/search` → render list. Show tier badge: `keyword` vs `semantic`.
- **Enter** → `/api/query` (deep tier) → replace list, badge flips to `semantic`. Spinner with cold-start message if >2 s.
- **↑/↓** move selection (selection loads preview via `/api/doc`, debounced 100 ms); **⌘O** open in editor; **⌘R** reveal in Finder; **Esc** clears query and focuses the box.
- Preview: render markdown with `marked` loaded from a CDN `<script>`; if it fails to load (offline), fall back to `<pre>` plain text. The data path stays fully local either way.
- Score shown as a percentage; result paths shown collection-relative (`home/…`).
- Dark mode via `prefers-color-scheme`, system font stack (`-apple-system`).

## Mac integration

- **Dock app:** open `http://localhost:8765` in Safari → File → Add to Dock. Done — standalone window + icon.
- **Always running:** LaunchAgent `~/Library/LaunchAgents/com.navid.qmd-ui.plist` running `node ~/qmd-ui/server.mjs` with `RunAtLoad` + `KeepAlive`. The server in turn keeps the qmd daemon alive.
- **Optional hotkey:** Raycast script command / Shortcuts: `open "http://localhost:8765/?q={query}"` — the page reads `?q=` on load and searches immediately.

## Failure modes

| Failure | Handling |
|---|---|
| qmd daemon not running | server spawns it on boot; deep search re-checks `/health` and respawns before failing |
| First deep search ~12 s | explicit "warming models" UI state, never a silent hang |
| MCP session invalidated | one transparent re-handshake + retry |
| `qmd` binary missing/erroring | endpoint returns 500 with stderr text; UI shows it in the results area |
| Path traversal via `/api/open` | resolved path must be inside the collection root; otherwise 400 |

## Out of scope (v1) / later

- Collection filter chips (only one collection today; trivial to add via `collection` arg to search)
- Recent-queries dropdown (localStorage)
- Index health footer from `qmd status`
- `multi_get` batch view

## Build order

1. `server.mjs` with `/api/search` + static page; UI list + keyboard nav → usable in ~an hour.
2. Preview pane (`/api/doc`) + open/reveal.
3. Deep tier (MCP session) + cold-start UX.
4. LaunchAgent + Add to Dock.
