#!/bin/sh
# Install claude-budget as a login-time LaunchAgent so the dashboard is always
# available at http://localhost:4478 — no terminal, no Claude Code session.
#
# Uninstall:  scripts/install-launchagent.sh --uninstall
set -eu

LABEL="com.andy.claude-budget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PORT="${BUDGET_PORT:-4478}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.claude/budget-data"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$PROJECT/src/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>BUDGET_PORT</key><string>$PORT</string></dict>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.claude/budget-data/agent.log</string>
  <key>StandardErrorPath</key><string>$HOME/.claude/budget-data/agent.err</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL -> http://localhost:$PORT"
echo
echo "If the dashboard does not come up, check $HOME/.claude/budget-data/agent.err."
echo "A macOS 'operation not permitted' error there means launchd lacks access to"
echo "the project's location (~/Desktop is TCC-protected). Fix either by granting"
echo "Full Disk Access to $NODE in System Settings > Privacy & Security, or by"
echo "moving this project somewhere outside ~/Desktop, ~/Documents, and ~/Downloads."
