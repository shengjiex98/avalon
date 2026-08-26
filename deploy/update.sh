#!/bin/sh
# Fast-forward this deployment to origin/main, verify it, and restart.
#
# Exit 0   already current, or updated and restarted
# Exit 75  a game is in progress; the caller should retry later
# Exit 1   the update failed and the previous commit was restored
#
# Both CI and the reconcile timer run this. The checkout it manages is
# deploy-only: local edits are discarded without warning.
set -eu

here=$(cd -- "$(dirname "$0")" >/dev/null && pwd)   # resolve before cd; $0 may be relative
cd "$here/.."

# systemctl --user run from a listener or a timer needs the bus named.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

port_override="${PORT:-}"                          # an explicit PORT wins over the host file
[ -f "$HOME/.config/avalon.env" ] && . "$HOME/.config/avalon.env"
[ -n "$port_override" ] && PORT="$port_override"
PORT="${PORT:-8420}"; export PORT

# What the live process is serving, which is not always what the working tree
# says: a tree moved by anything other than this script leaves the old code
# running, and comparing only the tree would call that "already current" and
# never restart. Empty when the server is down or is not a git checkout -- both
# cases deliberately do nothing here, so an unreadable commit cannot turn the
# hourly timer into an hourly restart.
running_health() {
  node -e '
    fetch(`http://127.0.0.1:${process.env.PORT}/api/health`)
      .then((r) => r.json()).then((h) => {
        console.log(h.commit ?? "");
        console.log(h.stateVersion ?? "");
      })
      .catch(() => console.log("\n"));
  ' 2>/dev/null || true
}

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
health=$(running_health)
running=$(printf '%s\n' "$health" | sed -n '1p')
running_sv=$(printf '%s\n' "$health" | sed -n '2p')
target_sv=$(git show "$target:src/state-version.js" 2>/dev/null \
  | sed -n 's/.*STATE_VERSION = \([0-9][0-9]*\).*/\1/p')

# Nothing to do only when the tree *and* the process are both on the target.
if [ "$previous" = "$target" ]; then
  [ -z "$running" ] && exit 0            # cannot tell; leave a healthy server alone
  [ "$running" = "$target" ] && exit 0
  echo "tree is current but $running is running; restarting" >&2
fi

# A known-equal state shape makes a restart lossless. Unknown or different
# versions fail closed through the existing gate before the checkout moves.
if [ -n "$running_sv" ] && [ -n "$target_sv" ] && [ "$running_sv" = "$target_sv" ]; then
  echo "state version $target_sv is restart-compatible" >&2
else
  # Before touching the working tree, not merely before restarting: static files
  # are read from disk per request and /version.json is derived from their mtimes,
  # so a checkout alone already changes what open browsers are served.
  set +e; "$here/gate.sh"; gate=$?; set -e
  if [ "$gate" -eq 75 ]; then
    publish "busy $target"
    exit 75
  fi
  [ "$gate" -eq 0 ] || exit "$gate"   # a broken gate is not a game in progress
fi

# Only when the tree actually has to move: an unconditional reset would discard
# a working tree that is already correct, for no gain.
[ "$previous" = "$target" ] || git reset --hard --quiet "$target"

case "$(node -v)" in
  v24.*) ;;
  *) echo "unexpected node $(node -v); staying on $previous" >&2
     [ "$previous" = "$target" ] || git reset --hard --quiet "$previous"
     publish "failed $target node"
     exit 1 ;;
esac

if ! node --test "test/**/*.test.js" >/dev/null 2>&1; then
  [ "$previous" = "$target" ] || git reset --hard --quiet "$previous"
  echo "tests failed on $target; stayed on $previous" >&2
  publish "failed $target tests"
  exit 1
fi

systemctl --user restart avalon
publish "deployed $target"
echo "deployed $target"
