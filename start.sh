#!/bin/bash
# start.sh — kept for old habits and scripts. Hub Player Flow now runs as the
# systemd user service hub-flow (scripts/install-service.sh); this restarts it
# and never starts a second copy. For development: npm run dev.
if systemctl --user cat hub-flow.service >/dev/null 2>&1; then
    exec systemctl --user restart hub-flow.service
fi
echo "hub-flow.service is not installed (or this is not the user's session): see scripts/install-service.sh" >&2
exit 1
