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

for name in com.mickdarling.project-atlas com.mickdarling.project-atlas-scan; do
  # bootout is idempotent-ish; ignore "not loaded"
  launchctl bootout "gui/$UID_N/$name" 2>/dev/null || true
  cp "$DIR/launchagents/$name.plist" "$AGENTS/"
  launchctl bootstrap "gui/$UID_N" "$AGENTS/$name.plist"
done

rm -rf "$HOME/Applications/Atlas.app"
cp -R "$DIR/app/Atlas.app" "$HOME/Applications/Atlas.app"
chmod +x "$HOME/Applications/Atlas.app/Contents/MacOS/Atlas"

sleep 1
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:4317/api/data; then
  echo "✓ server up at http://127.0.0.1:4317"
else
  echo "✗ server did not answer — check $LOGS/server.log"
  exit 1
fi
echo "✓ daily scan scheduled for 07:00 (log: $LOGS/scan.log)"
echo "✓ Atlas.app installed in ~/Applications"
