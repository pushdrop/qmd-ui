# qmd-ui

Minimal local web UI for searching a [qmd](https://github.com/tobi/qmd) markdown index. Zero-dependency Node server + single HTML page.

![](https://img.shields.io/badge/runtime-node-339933) ![](https://img.shields.io/badge/deps-none-blue)

- **Instant tier** — BM25 keyword results as you type (~100 ms via `qmd search`)
- **Deep tier** — press ↩ for hybrid semantic search through the warm `qmd mcp --http` daemon (~4 s)
- Markdown preview pane, copy path, Open (⌘O) / Reveal in Finder (⌘⇧F)
- Dark/light follows system appearance

See [SPEC.md](SPEC.md) for the design and measured latency numbers.

## Run

```sh
node server.mjs
# → http://localhost:8765
```

The server auto-starts the qmd daemon (`qmd mcp --http --daemon` on :8181) if it isn't running. Requires `qmd` at `/opt/homebrew/bin/qmd` with at least one collection indexed.

## Install as a background service

```sh
cp com.navid.qmd-ui.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.navid.qmd-ui.plist
```

(Adjust the paths inside the plist if your username or node path differ.)

For an app-like window with a dock icon: open `http://localhost:8765` in Safari → **File → Add to Dock**.
