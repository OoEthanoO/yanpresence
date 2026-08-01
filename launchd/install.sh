#!/bin/bash
# Installs yanpresence as a login agent so it starts with your session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.yanpresence.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/yanpresence"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>

	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$ROOT/bin/yanpresence.js</string>
	</array>

	<key>WorkingDirectory</key>
	<string>$ROOT</string>

	<key>RunAtLoad</key>
	<true/>

	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>

	<!-- Give up on restart storms rather than hammering a broken install. -->
	<key>ThrottleInterval</key>
	<integer>30</integer>

	<key>ProcessType</key>
	<string>Background</string>

	<key>StandardOutPath</key>
	<string>$LOGDIR/yanpresence.log</string>
	<key>StandardErrorPath</key>
	<string>$LOGDIR/yanpresence.err.log</string>

	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
		<key>NO_COLOR</key>
		<string>1</string>
	</dict>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Installed $LABEL"
echo "  plist: $PLIST"
echo "  logs:  $LOGDIR/yanpresence.log"
echo
echo "The first run will ask for permission to control Music.app. If you never see"
echo "the prompt, run 'npm start' once in a terminal to trigger it interactively."
