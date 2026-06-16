# qmd-ui

Minimal local web UI for searching a [qmd](https://github.com/tobi/qmd) markdown index. Zero-dependency Node server + single HTML page.

- **Instant tier** — BM25 keyword results as you type (~100 ms via `qmd search`)
- **Deep tier** — press ↩ for hybrid semantic/reranked search through the warm `qmd mcp --http` daemon (~4 s warm, ~12 s first cold start)
- Markdown preview pane, copy path, Open (⌘O) / Reveal in Finder (⌘⇧F)
- Dark/light follows system appearance; no build step, no npm

See [SPEC.md](SPEC.md) for design decisions and measured latency numbers.

---

## Prerequisites

| Requirement | Check | Install |
|---|---|---|
| macOS | — | — |
| Node.js ≥ 18 | `node --version` | `brew install node` |
| qmd ≥ 2.5 | `qmd --version` | `brew install tobi/tap/qmd` |
| qmd collection indexed | `qmd status` | see below |

If qmd has no collection yet:
```sh
qmd collection add home ~   # index ~/  for *.md files
qmd update                  # build the full-text index
qmd embed                   # generate vector embeddings (needed for deep search)
```

---

## Install

```sh
git clone https://github.com/makersmake/qmd-ui.git
cd qmd-ui
./install.sh
```

`install.sh` detects `node` and `qmd` from your PATH, generates a LaunchAgent plist with the correct absolute paths for your machine, loads it, and confirms the server is up. The service starts automatically at login and restarts if it crashes.

After install, open **http://localhost:8765** in any browser. For an app-like experience with a dock icon: open it in Safari → **File → Add to Dock**.

---

## Run without the background service

```sh
node server.mjs
# → http://localhost:8765
```

If `qmd` is not in your PATH, set `QMD_BIN`:
```sh
QMD_BIN=/path/to/qmd node server.mjs
```

---

## Manage the service

```sh
# view logs
tail -f ~/.cache/qmd/qmd-ui.err

# restart (e.g. after editing server.mjs)
launchctl kickstart -k gui/$(id -u)/com.qmd-ui.server

# stop
launchctl unload ~/Library/LaunchAgents/com.qmd-ui.server.plist

# start again
launchctl load ~/Library/LaunchAgents/com.qmd-ui.server.plist
```

> `index.html` is read from disk on every request — UI-only changes take effect on the next browser refresh, no restart needed.

---

## Ports

| Port | Service |
|---|---|
| `8765` | qmd-ui (web UI + JSON API) |
| `8181` | qmd MCP HTTP daemon (managed automatically) |

Both bind to `127.0.0.1` only and are not reachable from the network.

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

**`node` or `qmd` not found during install**
Both must be in your PATH. Run `which node` and `which qmd` — if either returns nothing, install the missing tool and retry.

**Deep search hangs ~12 s on first query**
Expected — the qmd daemon is loading embedding models into memory on first use. Subsequent queries are ~4 s. If it never returns, check `~/.cache/qmd/mcp.log`.

**Server started but shows no results**
Run `qmd status` to confirm files are indexed. If you recently added a collection, restart the server so it re-caches collection roots:
```sh
launchctl kickstart -k gui/$(id -u)/com.qmd-ui.server
```

**Port conflict**
Change `PORT` on line 10 of `server.mjs`, re-run `./install.sh` to regenerate the plist. For port 8181 (qmd daemon): `qmd mcp stop` and the server will respawn it.
