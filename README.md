# qmd-ui

Minimal local web UI for searching a [qmd](https://github.com/tobi/qmd) markdown index. Zero-dependency Node server + single HTML page.

- **Instant tier** — BM25 keyword results as you type (~100 ms via `qmd search`)
- **Deep tier** — press ↩ for hybrid semantic/reranked search through the warm `qmd mcp --http` daemon (~4 s warm, ~12 s first cold start)
- Markdown preview pane, copy path, Open (⌘O) / Reveal in Finder (⌘⇧F)
- Dark/light follows system appearance; no build step, no npm

See [SPEC.md](SPEC.md) for design decisions and measured latency numbers.

---

## Prerequisites

1. **macOS** (uses `open` and LaunchAgents; tested on macOS 26)
2. **Node.js ≥ 18** at `/opt/homebrew/bin/node`
   ```sh
   brew install node
   ```
3. **qmd ≥ 2.5** at `/opt/homebrew/bin/qmd`
   ```sh
   brew install tobi/tap/qmd   # or however qmd is distributed in your environment
   ```
4. **At least one qmd collection indexed.** Confirm with:
   ```sh
   qmd status
   # should show "Documents: N files indexed"
   ```
   If not set up yet:
   ```sh
   qmd collection add home ~   # index your home directory for *.md files
   qmd update                  # build the index
   qmd embed                   # generate vector embeddings (needed for deep search)
   ```

> **Path assumptions.** `server.mjs` hardcodes `QMD = '/opt/homebrew/bin/qmd'`. If your `qmd` binary is elsewhere (e.g. `/usr/local/bin/qmd`), edit line 9 of `server.mjs` before running.

---

## Quick start

```sh
git clone https://github.com/makersmake/qmd-ui.git ~/qmd-ui
cd ~/qmd-ui
node server.mjs
# → open http://localhost:8765
```

The server:
- Binds to `127.0.0.1:8765` only (not reachable from the network)
- Auto-starts the qmd MCP HTTP daemon (`qmd mcp --http --daemon` on `:8181`) if it isn't already running
- Resolves `qmd://` collection URIs to real filesystem paths on startup; if you add or rename a collection, restart the server

---

## Install as a persistent background service (recommended)

The plist in this repo runs the server automatically at login and restarts it if it crashes.

**Step 1** — edit the plist to replace the hardcoded paths with your own:

| Field in plist | Default | What to change |
|---|---|---|
| `ProgramArguments[1]` (node) | `/opt/homebrew/bin/node` | output of `which node` |
| `ProgramArguments[2]` (server) | `/Users/navid/qmd-ui/server.mjs` | absolute path to where you cloned this repo |
| `StandardErrorPath` | `/Users/navid/.cache/qmd/qmd-ui.err` | any writable log path |
| `StandardOutPath` | `/Users/navid/.cache/qmd/qmd-ui.out` | any writable log path |

You can do this automatically with sed (replace `yourusername` and adjust the node path if needed):

```sh
sed \
  -e "s|/Users/navid|$HOME|g" \
  -e "s|/opt/homebrew/bin/node|$(which node)|g" \
  com.navid.qmd-ui.plist > ~/Library/LaunchAgents/com.navid.qmd-ui.plist
```

**Step 2** — load and start it:

```sh
launchctl load ~/Library/LaunchAgents/com.navid.qmd-ui.plist
launchctl start com.navid.qmd-ui
```

**Step 3** — verify it's running:

```sh
curl http://127.0.0.1:8765/   # should return the HTML page
```

**To stop / unload:**
```sh
launchctl unload ~/Library/LaunchAgents/com.navid.qmd-ui.plist
```

**To restart after editing server.mjs or index.html:**
```sh
launchctl kickstart -k gui/$(id -u)/com.navid.qmd-ui
```
> Note: `index.html` is read from disk on every request, so UI-only changes take effect on the next browser refresh without a server restart.

**Logs:**
```sh
tail -f ~/.cache/qmd/qmd-ui.err   # stderr (errors, startup messages)
tail -f ~/.cache/qmd/qmd-ui.out   # stdout (request log)
```

---

## Ports

| Port | Service | Notes |
|---|---|---|
| `8765` | qmd-ui web server | UI and JSON API |
| `8181` | qmd MCP HTTP daemon | Managed by the server; started automatically |

Both bind to `127.0.0.1` only.

---

## Mac app experience (optional)

Open `http://localhost:8765` in Safari → **File → Add to Dock**. This gives the UI its own dock icon and a chrome-free window, similar to a native app.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| Type | Instant BM25 search (150 ms debounce) |
| ↩ | Deep semantic search (hybrid lex+vec+rerank) |
| ↑ / ↓ | Navigate results |
| ⌘O | Open selected file in default editor |
| ⌘⇧F | Reveal selected file in Finder |
| Esc | Clear query |

---

## Troubleshooting

**Server won't start — `qmd` not found**
Edit `QMD` on line 9 of `server.mjs` to the absolute path from `which qmd`.

**Deep search hangs for ~12 s on first query**
Expected — the qmd daemon is loading embedding models into memory. Subsequent queries are ~4 s. If it never returns, check `~/.cache/qmd/mcp.log`.

**Preview shows an error fetching the doc**
Run `qmd status` to confirm the file is indexed. If the collection root path changed, restart the server so it re-caches collection roots.

**Port 8765 or 8181 already in use**
Change `PORT` on line 10 of `server.mjs` (and update the LaunchAgent) for 8765. For 8181, `qmd mcp stop` kills the daemon and the server will respawn it.
