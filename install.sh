#!/bin/sh
# install.sh — sets up qmd-ui as a login service on macOS
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node 2>/dev/null || echo '')"
QMD_BIN="$(which qmd 2>/dev/null || echo '')"
PLIST_LABEL="com.navid.qmd-ui"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOG_DIR="$HOME/.cache/qmd"

# ── checks ──────────────────────────────────────────────────────────────────

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH. Install with: brew install node" >&2
  exit 1
fi

if [ -z "$QMD_BIN" ]; then
  echo "Error: qmd not found in PATH. See https://github.com/tobi/qmd" >&2
  exit 1
fi

echo "node : $NODE_BIN"
echo "qmd  : $QMD_BIN"
echo "repo : $REPO_DIR"
echo "plist: $PLIST_DEST"
echo ""

# ── write plist ─────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"

cat > "$PLIST_DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO_DIR/server.mjs</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
        <key>QMD_BIN</key>
        <string>$QMD_BIN</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/qmd-ui.err</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/qmd-ui.out</string>
</dict>
</plist>
PLIST

# ── load ─────────────────────────────────────────────────────────────────────

# unload first in case a previous version is running
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

# ── verify ───────────────────────────────────────────────────────────────────

echo "Waiting for server to start..."
for i in $(seq 1 10); do
  sleep 1
  if curl -sf http://127.0.0.1:8765/ >/dev/null 2>&1; then
    echo ""
    echo "✓ qmd-ui is running at http://127.0.0.1:8765"
    echo ""
    echo "Logs: tail -f $LOG_DIR/qmd-ui.err"
    echo "Stop: launchctl unload $PLIST_DEST"
    echo "Restart: launchctl kickstart -k gui/\$(id -u)/$PLIST_LABEL"
    exit 0
  fi
done

echo ""
echo "Server did not respond after 10s. Check logs:"
echo "  tail -20 $LOG_DIR/qmd-ui.err"
exit 1
