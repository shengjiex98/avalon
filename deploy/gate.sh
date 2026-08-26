#!/bin/sh
# May the running server be replaced right now?
#
# Exit 0   yes: either the restart is lossless, or no game would be lost
# Exit 75  (EX_TEMPFAIL) no: replacing the process now loses a live game.
#          The caller should retry later.
#
# Two things make a replacement safe, and this is the only place that knows
# it. A restart onto code with the same STATE_VERSION restores every room from
# the snapshot, so it is safe even mid-game. Otherwise the rooms are lost, and
# safety reduces to whether any of them is worth keeping.
#
# TARGET_STATE_VERSION is the STATE_VERSION of the code about to be deployed.
# Deliberately not a commit: nothing here knows how the server is deployed, so
# an image-based deployment can pass a label or a build arg and keep using
# this unchanged. Leave it empty when the target is unknown -- an unknown
# version fails closed through the live-game check below.
#
# AVALON_FORCE=1 skips the check entirely.
set -eu

here=$(cd -- "$(dirname -- "$0")" >/dev/null && pwd)
. "$here/lib.sh"

[ "${AVALON_FORCE:-0}" = "1" ] && { echo 'forced: skipping the safety check' >&2; exit 0; }

avalon_load_env

target_sv="${TARGET_STATE_VERSION:-}"
running_sv=$(avalon_health | sed -n '2p')

# A known-equal state shape makes the restart lossless, so a game in progress
# is no reason to wait. Unknown on either side is not equal.
if [ -n "$running_sv" ] && [ -n "$target_sv" ] && [ "$running_sv" = "$target_sv" ]; then
  echo "state version $target_sv is restart-compatible" >&2
  exit 0
fi

status=$(node -e '
  fetch(`http://127.0.0.1:${process.env.PORT}/api/health/update`, { signal: AbortSignal.timeout(5000) })
    .then((r) => console.log(r.status))
    .catch(() => console.log(0));   // not running: nothing to protect
')

case "$status" in
  409) echo 'busy: a game is in progress' >&2; exit 75 ;;
  200|0) exit 0 ;;
  *) echo "warning: unexpected update-gate status $status; proceeding" >&2; exit 0 ;;
esac
