#!/bin/sh
# Build a "Claude Budget.app" shortcut. Double-click opens the dashboard.
#
#   scripts/make-desktop-shortcut.sh              -> ~/Desktop
#   scripts/make-desktop-shortcut.sh /Applications
#   scripts/make-desktop-shortcut.sh --uninstall
#
# Unlike the .command file, an .app bundle opens no Terminal window. It also
# self-heals: if the server isn't answering it tries the LaunchAgent first,
# then falls back to starting the server directly, before opening the browser.
set -eu

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Desktop}"
APP="$DEST/Claude Budget.app"
LABEL="com.andy.claude-budget"
PORT="${BUDGET_PORT:-4478}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$HOME/Desktop/Claude Budget.app" "/Applications/Claude Budget.app"
  echo "removed Claude Budget.app"
  exit 0
fi

[ -d "$DEST" ] || { echo "no such directory: $DEST"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Budget</string>
  <key>CFBundleDisplayName</key><string>Claude Budget</string>
  <key>CFBundleIdentifier</key><string>com.andy.claude-budget.launcher</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <!-- No Dock icon / menu bar: this launches and exits. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/sh
PORT=$PORT
PROJECT="$PROJECT"
LABEL="$LABEL"
URL="http://localhost:\$PORT"

up() { curl -s -o /dev/null --max-time 2 "\$URL/api/state" 2>/dev/null; }

if ! up; then
  # Prefer the LaunchAgent so there's only ever one owner of the port.
  launchctl kickstart "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || true
  i=0; while [ \$i -lt 12 ] && ! up; do i=\$((i+1)); sleep 0.25; done

  if ! up; then
    # Agent unavailable (not installed, or Full Disk Access revoked by a
    # node upgrade). Start a detached server so the shortcut still works.
    NODE="\$(command -v node || true)"
    for c in /opt/homebrew/bin/node /usr/local/bin/node; do
      [ -n "\$NODE" ] && break
      [ -x "\$c" ] && NODE="\$c"
    done
    if [ -n "\$NODE" ]; then
      cd "\$PROJECT" && nohup "\$NODE" src/server.mjs >/dev/null 2>&1 &
      i=0; while [ \$i -lt 20 ] && ! up; do i=\$((i+1)); sleep 0.25; done
    fi
  fi
fi

if up; then
  open "\$URL"
else
  osascript -e 'display alert "Claude Budget" message "Could not start the dashboard.\\n\\nCheck ~/.claude/budget-data/agent.err — an EPERM there means macOS revoked Full Disk Access for node (this happens after brew upgrade node)." as warning' >/dev/null 2>&1
fi
LAUNCH

chmod +x "$APP/Contents/MacOS/launch"

# Build the icon. Generated rather than copied from a system app so the
# shortcut looks intentional; skipped gracefully if the toolchain is missing.
NODE="$(command -v node || true)"
if [ -n "$NODE" ] && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  if "$NODE" "$PROJECT/scripts/make-icon.mjs" "$TMP/icon.png" >/dev/null 2>&1; then
    mkdir -p "$TMP/icon.iconset"
    for sz in 16 32 128 256 512; do
      sips -z $sz $sz "$TMP/icon.png" --out "$TMP/icon.iconset/icon_${sz}x${sz}.png" >/dev/null 2>&1
      sips -z $((sz * 2)) $((sz * 2)) "$TMP/icon.png" \
        --out "$TMP/icon.iconset/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$TMP/icon.iconset" -o "$APP/Contents/Resources/icon.icns" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
fi

touch "$APP"
echo "created: $APP"
echo "Double-click it to open the dashboard."
