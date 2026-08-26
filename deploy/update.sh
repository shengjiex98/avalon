#!/bin/sh
# Fast-forward this deployment to origin/main, verify it, and restart.
#
# Exit 0   already current, or updated and restarted
# Exit 75  a game is in progress; the caller should retry later
# Exit 1   the update failed and the previous commit was restored
#
# Both CI and the reconcile timer run this. The checkout it manages is
# deploy-only: local edits are discarded without warning.
#
# Whether a restart is safe is not decided here: gate.sh answers that, given
# the state version this commit would run.
set -eu

here=$(cd -- "$(dirname "$0")" >/dev/null && pwd)   # resolve before cd; $0 may be relative
cd "$here/.."
. "$here/lib.sh"

# systemctl --user run from a listener or a timer needs the bus named.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

avalon_load_env

# Report progress to whoever triggered this. Deliberately incapable of failing
# the deployment: an unreachable notifier turns one problem into two, and the
# journal remains the real record either way.
publish() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS --max-time 10 -d "$1" \
    "${NTFY_SERVER:-https://ntfy.sh}/${NTFY_TOPIC}" >/dev/null 2>&1 || true
}

git fetch --quiet origin main
previous=$(git rev-parse HEAD)
target=$(git rev-parse origin/main)

# What the live process is serving, which is not always what the working tree
# says: a tree moved by anything other than this script leaves the old code
# running, and comparing only the tree would call that "already current" and
# never restart. Empty when the server is down or is not a git checkout -- both
# cases deliberately do nothing here, so an unreadable commit cannot turn the
# hourly timer into an hourly restart.
running=$(avalon_health | sed -n '1p')

# Nothing to do only when the tree *and* the process are both on the target.
if [ "$previous" = "$target" ]; then
  [ -z "$running" ] && exit 0            # cannot tell; leave a healthy server alone
  [ "$running" = "$target" ] && exit 0
  echo "tree is current but $running is running; restarting" >&2
fi

# Host preconditions first. Moving the checkout for code this host cannot run
# means resetting back afterwards, and the checkout alone already changes what
# open browsers are served: static files are read from disk per request and
# /version.json is derived from their mtimes.
case "$(node -v)" in
  v24.*) ;;
  *) echo "unexpected node $(node -v); staying on $previous" >&2
     publish "failed $target node"
     exit 1 ;;
esac

# May this replace the running process now? One question, one answer: the gate
# compares state versions and, when they cannot both be known to match, asks
# the server whether a game would be lost. Asked before the working tree moves,
# for the same reason as the node check above.
TARGET_STATE_VERSION=$(git show "$target:src/state-version.js" 2>/dev/null \
  | sed -n 's/.*STATE_VERSION = \([0-9][0-9]*\).*/\1/p')
export TARGET_STATE_VERSION

set +e; "$here/gate.sh"; gate=$?; set -e
if [ "$gate" -eq 75 ]; then
  publish "busy $target"
  exit 75
fi
[ "$gate" -eq 0 ] || exit "$gate"   # a broken gate is not a game in progress

# Only when the tree actually has to move: an unconditional reset would discard
# a working tree that is already correct, for no gain.
[ "$previous" = "$target" ] || git reset --hard --quiet "$target"

if ! node --test "test/**/*.test.js" >/dev/null 2>&1; then
  [ "$previous" = "$target" ] || git reset --hard --quiet "$previous"
  echo "tests failed on $target; stayed on $previous" >&2
  publish "failed $target tests"
  exit 1
fi

systemctl --user restart avalon
publish "deployed $target"
echo "deployed $target"
