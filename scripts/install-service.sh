#!/usr/bin/env bash
# install-service.sh — runs Hub Player Flow as the systemd user service
# hub-flow.service: started at boot (the user needs lingering:
# `sudo loginctl enable-linger <user>`), restarted when it stops, at low CPU
# and disk priority, its output in the journal (journalctl --user -u hub-flow).
#
#   scripts/install-service.sh WORLD_PATH [PORT]
#
# WORLD_PATH is the world folder to read. Keep it the same when replacing an
# earlier way of running the tool: the folders in .cache/ and data/ are named
# after it, and data/ cannot be rebuilt. PORT defaults to 9191, where the MCME
# dashboard reads the signals. The service runs the production build: build it
# first with scripts/deploy.sh --build-only. The service is enabled, not
# started: start it with `systemctl --user start hub-flow`.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
world="${1:-}"
port="${2:-9191}"
safe='^[A-Za-z0-9._/-]+$'

[ -n "$world" ] || { echo "usage: scripts/install-service.sh WORLD_PATH [PORT]" >&2; exit 1; }
[ -d "$world" ] || { echo "no world folder at $world" >&2; exit 1; }
# Written into the unit as they are: no spaces or quotes to escape
[[ "$world" =~ $safe ]] || { echo "the world path may only hold letters, digits and . _ / -" >&2; exit 1; }
[[ "$here" =~ $safe ]] || { echo "this folder's path may only hold letters, digits and . _ / -" >&2; exit 1; }
[[ "$port" =~ ^[0-9]{2,5}$ ]] || { echo "invalid port: $port" >&2; exit 1; }
node="$(command -v node)" || { echo "node is not on the PATH" >&2; exit 1; }
[ -f "$here/dist/server/server/index.js" ] || { echo "no production build yet: run scripts/deploy.sh --build-only first" >&2; exit 1; }

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
cat >"$unit_dir/hub-flow.service.tmp" <<EOF
[Unit]
Description=Hub Player Flow (the MCME dashboard's Players → New players)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$here
Environment=HOST=127.0.0.1
Environment=PORT=$port
Environment="NODE_OPTIONS=--no-deprecation --no-warnings"
ExecStart=$node dist/server/server/index.js $world
# Indexing hundreds of thousands of player files must never slow the game servers
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
mv "$unit_dir/hub-flow.service.tmp" "$unit_dir/hub-flow.service"
systemctl --user daemon-reload
systemctl --user enable hub-flow.service
echo "hub-flow.service installed and enabled (world $world, 127.0.0.1:$port)."
echo "Start it with: systemctl --user start hub-flow"
