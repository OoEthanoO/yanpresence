#!/bin/bash
# Installs yanpresence as a systemd user service so it starts with your session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/yanpresence.service"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=yanpresence — Apple Music rich presence for Discord
# Both the browser it reads and the Discord client it writes to are session
# things, so there is nothing to do before the graphical session exists. This
# is ordering only: the unit is wanted by default.target so it still starts on
# a desktop that never activates graphical-session.target, and it waits its
# turn on one that does.
After=graphical-session.target
# Discord and the browser come and go; the daemon reconnects on its own and
# should not be rate-limited out of existence for restarting.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN $ROOT/bin/yanpresence.js
Restart=on-failure
# Long enough that a bad config fails visibly instead of looping.
RestartSec=30
Environment=NO_COLOR=1

[Install]
WantedBy=default.target
UNIT_EOF

systemctl --user daemon-reload
systemctl --user enable --now yanpresence.service

echo "Installed yanpresence.service"
echo "  unit:   $UNIT"
echo "  logs:   journalctl --user -u yanpresence -f"
echo "  status: systemctl --user status yanpresence"
echo
echo "If you play in Chrome, load the companion extension too — see browser/README.md."
echo "Snap-packaged browsers only answer MPRIS queries from unconfined callers;"
echo "running under systemd --user is unconfined, so this install is the safe way."
