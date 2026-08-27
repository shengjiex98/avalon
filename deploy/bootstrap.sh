#!/bin/sh
# The one piece of the deployment control plane that does not ship in a release.
#
# Everything else -- controller.sh, gate.sh, lib.sh, the units -- rides inside
# the release artifact it deploys, so a change to deploy logic goes through the
# same CI, tests, and health-gated rollout as a change to the game. This script
# is the exception, and it is expected never to change: it resolves main,
# downloads that commit's verified artifact, and hands control to *that
# commit's own* controller.
#
#   bootstrap.sh deploy-main                  hourly timer
#   bootstrap.sh deploy-trigger <40-hex-sha>  ntfy listener
#
# Nothing downloaded is executed before its checksum verifies. That ordering is
# the whole trust model here; preserve it in any change.
#
# This script does not update itself, and no controller overwrites it. When it
# does need to change, a human runs deploy/install-bootstrap.sh from a clone --
# the controller only warns when the two have drifted apart.
set -eu
umask 077

mode=${1:-}
requested=${2:-}

# systemctl --user needs this; a timer-started unit has it, an interactive
# `sh bootstrap.sh` may not.
[ -n "${XDG_RUNTIME_DIR:-}" ] || XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR

# Host settings (PORT, NTFY_TOPIC, NTFY_SERVER) live outside the repo.
if [ -f "$HOME/.config/avalon.env" ]; then
  . "$HOME/.config/avalon.env"
fi

release_root=${AVALON_RELEASE_ROOT:-"$HOME/.local/lib/avalon"}
artifact_base=${AVALON_ARTIFACT_BASE:-"https://github.com/shengjiex98/avalon/releases/download/deployment-artifacts"}
main_url=${AVALON_MAIN_URL:-"https://api.github.com/repos/shengjiex98/avalon/commits/main"}
node_bin=${AVALON_NODE:-"$HOME/.local/bin/node"}

usage() {
  echo 'Usage: bootstrap.sh deploy-main | deploy-trigger <commit>' >&2
  exit 64
}

valid_target() {
  case "${1:-}" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

publish() {
  [ -n "${NTFY_TOPIC:-}" ] || return 0
  curl -fsS --max-time 10 -d "$1" \
    "${NTFY_SERVER:-https://ntfy.sh}/${NTFY_TOPIC}" >/dev/null 2>&1 || true
}

# Named for the stage that failed, so a journal line and an ntfy message say
# the same thing. Only reachable once the target commit is known: a message CI
# cannot attribute to a commit is worse than no message.
fail() {
  echo "$2" >&2
  publish "failed $sha $1"
  exit 1
}

case "$mode" in
  deploy-main) [ "$#" -eq 1 ] || usage ;;
  deploy-trigger) { [ "$#" -eq 2 ] && valid_target "$requested"; } || usage ;;
  *) usage ;;
esac

work=
# The status is captured and re-raised deliberately: a trap whose last command
# fails replaces the exit status with 1, which would turn the controller's 75
# ("busy, retry later") into a failed unit and a red CI run.
cleanup() {
  code=$?
  if [ -n "${work:-}" ] && [ -d "$work" ]; then
    rm -rf -- "$work"
  fi
  exit "$code"
}
trap cleanup EXIT HUP INT TERM

# One deployment at a time. The hourly timer and a CI trigger can otherwise
# arrive together and race each other through the same release directory.
#
# Checked rather than assumed: a missing flock exits non-zero exactly like a
# held lock, which would turn every deployment into a silent no-op.
command -v flock >/dev/null 2>&1 ||
  { echo 'flock is required to serialize deployments; install util-linux' >&2; exit 1; }
mkdir -p "$release_root"
exec 9>"$release_root/.deploy.lock"
if ! flock -n 9; then
  echo 'another deployment is already in flight; nothing to do' >&2
  exit 0
fi

# GitHub decides what "main" is; a trigger only ever asks about a commit.
resolve_main() {
  "$node_bin" -e '
    const sha = /^[0-9a-f]{40}$/;
    fetch(process.argv[1], {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "avalon-deploy-bootstrap",
      },
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`main lookup returned ${response.status}`);
        return response.json();
      })
      .then((body) => {
        const commit = body.sha ?? body.object?.sha;
        if (!sha.test(commit ?? "")) throw new Error("main lookup returned no valid commit");
        process.stdout.write(`${commit}\n`);
      })
      .catch((error) => {
        console.error(`cannot resolve Avalon main: ${error.message}`);
        process.exitCode = 1;
      });
  ' "$main_url"
}

if ! sha=$(resolve_main) || ! valid_target "$sha"; then
  echo 'cannot resolve GitHub main; nothing deployed' >&2
  # In trigger mode CI is waiting on a named commit, so say so; the hourly
  # timer has no one to tell and retries on its own.
  sha=$requested
  if [ "$mode" = deploy-trigger ]; then
    publish "failed $sha main"
  fi
  exit 1
fi

if [ "$mode" = deploy-trigger ] && [ "$requested" != "$sha" ]; then
  echo "ignored deployment trigger for $requested; main is $sha" >&2
  exit 0
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/avalon-bootstrap.XXXXXX") || exit 1
archive="avalon-$sha.tar.gz"

curl -fsSL --retry 3 --connect-timeout 10 --max-time 300 \
  "$artifact_base/$archive" -o "$work/$archive" ||
  fail download "cannot download $archive"
curl -fsSL --retry 3 --connect-timeout 10 --max-time 30 \
  "$artifact_base/$archive.sha256" -o "$work/$archive.sha256" ||
  fail download "cannot download $archive.sha256"

expected=$(sed -n '1{s/[[:space:]].*//;p;}' "$work/$archive.sha256")
case "$expected" in
  *[!0-9a-f]*|'') fail checksum "invalid checksum for $archive" ;;
esac
[ "${#expected}" -eq 64 ] || fail checksum "invalid checksum for $archive"
actual=$(sha256sum "$work/$archive" | sed 's/[[:space:]].*//')
[ "$actual" = "$expected" ] || fail checksum "checksum mismatch for $archive"

# Only now may these bytes run.
mkdir "$work/tree"
tar -xzf "$work/$archive" --strip-components=1 -C "$work/tree" ||
  fail extract "cannot extract $archive"
[ -x "$work/tree/deploy/controller.sh" ] ||
  fail extract "release $sha ships no deploy/controller.sh"

# An explicit allowlist rather than the inherited environment: a stray
# TARGET_STATE_VERSION or AVALON_FORCE reaching the controller would answer the
# safety gate and the release's own test run on behalf of whoever set it.
set --
for name in HOME PATH XDG_RUNTIME_DIR PORT NTFY_TOPIC NTFY_SERVER \
  AVALON_NODE AVALON_RELEASE_ROOT AVALON_ARTIFACT_BASE AVALON_MAIN_URL \
  AVALON_SYSTEMCTL AVALON_STATE_FILE AVALON_HEALTH_TIMEOUT_SECONDS \
  AVALON_SYSTEMD_USER_DIR AVALON_CONTROLLER_ROOT; do
  present=
  eval "present=\${$name+set}"
  [ "$present" = set ] || continue
  eval "value=\$$name"
  set -- "$@" "$name=$value"
done

# A child, not exec: the temp tree has to outlive the controller only long
# enough for the trap above to remove it. Exit 75 ("busy, retry later") must
# reach systemd unchanged, so the status is passed straight through.
set +e
env -i "$@" "$work/tree/deploy/controller.sh" deploy "$sha"
status=$?
set -e
exit "$status"
