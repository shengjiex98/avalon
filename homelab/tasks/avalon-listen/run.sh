#!/usr/bin/env bash
set -euo pipefail
exec "${AVALON_NODE:-$HOME/.local/bin/node}" "$APP_DIR/deploy/listen.mjs"
