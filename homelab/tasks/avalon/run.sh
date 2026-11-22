#!/usr/bin/env bash
# start.mjs loads the server from its working directory, which is the release
# the updater selected, not this checkout.
set -euo pipefail
cd "${AVALON_RELEASE_ROOT:-$HOME/.local/lib/avalon}/current"
exec "${AVALON_NODE:-$HOME/.local/bin/node}" "$APP_DIR/deploy/start.mjs"
