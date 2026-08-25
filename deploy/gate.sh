#!/bin/sh
# Refuse to disturb a server that is hosting a game.
#
# Exit 0   the process may be replaced
# Exit 75  (EX_TEMPFAIL) a game is in progress; the caller should retry later
#
# Nothing here knows how the server is deployed, so an image-based deployment
# can keep using it unchanged. AVALON_FORCE=1 skips the check entirely.
set -eu

[ "${AVALON_FORCE:-0}" = "1" ] && { echo 'forced: skipping the game check' >&2; exit 0; }

requested="${PORT:-}"                             # an explicit PORT wins over the host file
[ -f "$HOME/.config/avalon.env" ] && . "$HOME/.config/avalon.env"
PORT="${requested:-${PORT:-8420}}"
export PORT

# node rather than curl/jq: the project ships no dependencies, and the runtime
# is by definition installed wherever the server runs.
status=$(node -e '
  fetch(`http://127.0.0.1:${process.env.PORT}/api/health/update`)
    .then((r) => console.log(r.status))
    .catch(() => console.log(0));   // not running: nothing to protect
')

case "$status" in
  409) echo 'busy: a game is in progress' >&2; exit 75 ;;
  200|0) exit 0 ;;
  *) echo "warning: unexpected update-gate status $status; proceeding" >&2; exit 0 ;;
esac
