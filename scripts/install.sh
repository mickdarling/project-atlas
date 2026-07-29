#!/bin/sh
# Install Project Atlas as a local application:
#   - server LaunchAgent (KeepAlive: always running, starts at login)
#   - daily-scan LaunchAgent (07:00 re-harvest; never touches verdicts.json)
#   - Atlas.app in ~/Applications (opens the dashboard, Dock-able)
# Re-runnable: safe to invoke after pulling changes.
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/project-atlas"
UID_N="$(id -u)"

mkdir -p "$AGENTS" "$LOGS" "$HOME/Applications"

# Free the port from any ad-hoc `node server.js` so the agent can bind it.
# (Only ever kills a process listening on Atlas's own port.)
OLD_PID="$(lsof -nP -tiTCP:4317 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

# Build the menu bar app (native Swift, no dependencies).
echo "building AtlasMenu…"
mkdir -p "$DIR/app/AtlasMenu.app/Contents/MacOS"
swiftc -O "$DIR/menubar/AtlasMenu.swift" -o "$DIR/app/AtlasMenu.app/Contents/MacOS/AtlasMenu"
codesign --force --sign - "$DIR/app/AtlasMenu.app" 2>/dev/null || true

# Apps go in BEFORE the agents load — the menu agent execs the installed binary.
rm -rf "$HOME/Applications/Atlas.app" "$HOME/Applications/AtlasMenu.app"
cp -R "$DIR/app/Atlas.app" "$HOME/Applications/Atlas.app"
cp -R "$DIR/app/AtlasMenu.app" "$HOME/Applications/AtlasMenu.app"
chmod +x "$HOME/Applications/Atlas.app/Contents/MacOS/Atlas" \
         "$HOME/Applications/AtlasMenu.app/Contents/MacOS/AtlasMenu"

# The repo's plists are TEMPLATES — no user paths are committed. They're
# instantiated here for whoever runs the installer.
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "✗ node not found on PATH"; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

for name in com.mickdarling.project-atlas com.mickdarling.project-atlas-scan com.mickdarling.project-atlas-menu; do
  # bootout is idempotent-ish; ignore "not loaded"
  launchctl bootout "gui/$UID_N/$name" 2>/dev/null || true
  sed -e "s|__HOME__|$HOME|g" -e "s|__DIR__|$DIR|g" \
      -e "s|__NODE__|$NODE_BIN|g" -e "s|__NODEDIR__|$NODE_DIR|g" \
      "$DIR/launchagents/$name.plist" > "$AGENTS/$name.plist"
  # bootstrap right after bootout can hit the old job still tearing down
  # (EIO). Give launchd a beat and retry.
  ok=""
  for attempt in 1 2 3 4; do
    if launchctl bootstrap "gui/$UID_N" "$AGENTS/$name.plist" 2>/dev/null; then
      ok=1; break
    fi
    sleep 1
  done
  [ -n "$ok" ] || { echo "✗ could not bootstrap $name"; exit 1; }
done

sleep 1
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:4317/api/data; then
  echo "✓ server up at http://127.0.0.1:4317"
else
  echo "✗ server did not answer — check $LOGS/server.log"
  exit 1
fi
echo "✓ daily scan scheduled for 07:00 (log: $LOGS/scan.log)"
echo "✓ menu bar app running (⊞ icon; log: $LOGS/menu.log)"
echo "✓ Atlas.app installed in ~/Applications"
