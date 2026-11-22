#!/usr/bin/env bash
# Exit 75 means a release was deferred while games run. The next run retries,
# so it must not fail the unit and raise an alert.
set -uo pipefail
"$APP_DIR/deploy/updater.sh" reconcile && exit 0
rc=$?
[ "$rc" -eq 75 ] && exit 0
exit "$rc"
