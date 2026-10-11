#!/usr/bin/env bash
# deploy.sh — updates Hub Player Flow and restarts its service.
#
#   scripts/deploy.sh [--no-pull] [--build-only]
#
# Pulls the checked-out branch (fast-forward only), installs the locked
# dependencies, builds the client for the path the MCME dashboard serves it
# under (BASE_URL, default /hub-flow/) and the server, then restarts
# hub-flow.service and waits until it answers. --build-only stops after the
# build (for the first install, before scripts/install-service.sh).
set -euo pipefail

cd "$(dirname "$0")/.."
pull=1
restart=1
for arg in "$@"; do
    case "$arg" in
        --no-pull) pull=0 ;;
        --build-only) pull=0; restart=0 ;;
        *) echo "usage: scripts/deploy.sh [--no-pull] [--build-only]" >&2; exit 1 ;;
    esac
done

[ "$pull" = 1 ] && git pull --ff-only
npm ci --no-audit --no-fund
BASE_URL="${BASE_URL:-/hub-flow/}" npm run build
[ "$restart" = 1 ] || { echo "Built. Not restarted."; exit 0; }

systemctl --user cat hub-flow.service >/dev/null 2>&1 \
    || { echo "hub-flow.service is not installed: see scripts/install-service.sh" >&2; exit 1; }
port="$(systemctl --user show -p Environment hub-flow.service | grep -o 'PORT=[0-9]*' | cut -d= -f2)"
port="${port:-9191}"
systemctl --user restart hub-flow.service

# It answers once the players are indexed: seconds with a warm cache, longer after a long stop
for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/world-info"; then
        echo "hub-flow answers on 127.0.0.1:$port"
        exit 0
    fi
    sleep 5
done
echo "hub-flow did not answer within 10 minutes: journalctl --user -u hub-flow" >&2
exit 1
