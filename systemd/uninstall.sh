#!/bin/bash
set -euo pipefail

UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/yanpresence.service"

systemctl --user disable --now yanpresence.service 2>/dev/null || true
rm -f "$UNIT"
systemctl --user daemon-reload

echo "Removed yanpresence.service"
