#!/bin/sh
# Stable host-side controller for immutable Avalon application releases.
set -eu
umask 077

controller_dir=$(cd -- "$(dirname "$0")" >/dev/null && pwd)
. "$controller_dir/lib.sh"

source_repo=${AVALON_SOURCE_REPO:-"$HOME/avalon"}
release_root=${AVALON_RELEASE_ROOT:-"$HOME/.local/lib/avalon"}
releases="$release_root/releases"
artifact_base=${AVALON_ARTIFACT_BASE:-"https://github.com/shengjiex98/avalon/releases/download/deployment-artifacts"}
node_bin=${AVALON_NODE:-"$HOME/.local/bin/node"}
systemctl_bin=${AVALON_SYSTEMCTL:-systemctl}
export AVALON_NODE="$node_bin"

usage() {
  echo 'Usage: controller.sh prepare <commit> | deploy <commit> [rollback-commit] | deploy-main' >&2
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

prepare() (
  target=${1:-}
  valid_target "$target" || usage

  case "$("$node_bin" -v)" in
    v24.*) ;;
    *) echo "unexpected node $("$node_bin" -v); refusing $target" >&2; return 1 ;;
  esac

  mkdir -p "$releases" || return 1
  release="$releases/$target"
  if [ -d "$release" ]; then
    "$node_bin" "$controller_dir/verify-release.mjs" "$release" "$target" >/dev/null || return 1
    printf '%s\n' "$release"
    return 0
  fi

  stage=$(mktemp -d "$releases/.staging-$target.XXXXXX") || return 1
  download=
  cleanup() {
    [ -n "${stage:-}" ] && [ -d "$stage" ] && rm -rf -- "$stage"
    [ -n "${download:-}" ] && [ -d "$download" ] && rm -rf -- "$download"
  }
  trap cleanup EXIT HUP INT TERM
  download=$(mktemp -d "$releases/.download-$target.XXXXXX") || return 1
  archive="avalon-$target.tar.gz"

  curl -fsSL --retry 3 --connect-timeout 10 --max-time 300 \
    "$artifact_base/$archive" -o "$download/$archive" || return 1
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 30 \
    "$artifact_base/$archive.sha256" -o "$download/$archive.sha256" || return 1
  expected=$(sed -n '1{s/[[:space:]].*//;p;}' "$download/$archive.sha256")
  case "$expected" in
    *[!0-9a-f]*|'') echo "invalid checksum for $archive" >&2; return 1 ;;
  esac
  [ "${#expected}" -eq 64 ] || { echo "invalid checksum for $archive" >&2; return 1; }
  actual=$(sha256sum "$download/$archive" | sed 's/[[:space:]].*//')
  [ "$actual" = "$expected" ] || { echo "checksum mismatch for $archive" >&2; return 1; }

  tar -xzf "$download/$archive" --strip-components=1 -C "$stage" || return 1
  "$node_bin" "$controller_dir/verify-release.mjs" "$stage" "$target" >/dev/null || return 1

  (
    cd "$stage"
    env -u TARGET_STATE_VERSION -u AVALON_FORCE -u NODE_TEST_CONTEXT \
      "$node_bin" --test "test/**/*.test.js"
  ) || return 1

  "$node_bin" "$controller_dir/verify-release.mjs" "$stage" "$target" >/dev/null || return 1
  chmod -R a-w "$stage" || return 1
  mv "$stage" "$release" || return 1
  stage=
  rm -rf -- "$download"
  download=
  trap - EXIT HUP INT TERM
  printf '%s\n' "$release"
)

manifest_state_version() {
  "$node_bin" -e '
    const fs = require("node:fs");
    console.log(JSON.parse(fs.readFileSync(process.argv[1])).stateVersion);
  ' "$1/release.json"
}

select_release() {
  selected=$1
  next="$release_root/.current-$selected-$$"
  ln -s "releases/$selected" "$next"
  mv -Tf "$next" "$release_root/current"
}

selected_release() {
  readlink "$release_root/current" 2>/dev/null || true
}

snapshot_file() {
  printf '%s\n' "${AVALON_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/avalon/rooms.json}"
}

backup_snapshot() {
  backup_dir="$release_root/rollback/$1"
  state_file=$(snapshot_file)
  mkdir -p "$backup_dir"
  if [ -f "$state_file" ]; then
    cp -p "$state_file" "$backup_dir/rooms.json"
    rm -f "$backup_dir/no-snapshot"
  else
    : >"$backup_dir/no-snapshot"
    rm -f "$backup_dir/rooms.json"
  fi
}

restore_snapshot() {
  backup_dir="$release_root/rollback/$1"
  state_file=$(snapshot_file)
  mkdir -p "$(dirname "$state_file")"
  if [ -f "$backup_dir/rooms.json" ]; then
    cp -p "$backup_dir/rooms.json" "$state_file.restore"
    mv -f "$state_file.restore" "$state_file"
  elif [ -f "$backup_dir/no-snapshot" ]; then
    rm -f "$state_file" "$state_file.tmp"
  fi
}

wait_for_commit() {
  "$node_bin" "$controller_dir/wait-for-health.mjs" \
    "$PORT" "$1" "${AVALON_HEALTH_TIMEOUT_SECONDS:-30}"
}

deploy_target() {
  target=${1:-}
  valid_target "$target" || usage
  requested_rollback=${2:-}
  [ -z "$requested_rollback" ] || valid_target "$requested_rollback" || usage
  avalon_load_env
  export AVALON_NODE="$node_bin"

  if ! prepare "$target"; then
    publish "failed $target tests"
    return 1
  fi
  target_release="$releases/$target"

  running=$(avalon_health | sed -n '1p')
  running_state_version=$(avalon_health | sed -n '2p')
  if [ "$running" = "$target" ] && [ "$(selected_release)" = "releases/$target" ]; then
    return 0
  fi

  rollback=${requested_rollback:-$running}
  if valid_target "$rollback" && [ ! -d "$releases/$rollback" ]; then
    if ! prepare "$rollback"; then
      echo "cannot prepare running release $rollback for rollback" >&2
      publish "failed $target rollback"
      return 1
    fi
  fi
  if valid_target "$rollback"; then
    "$node_bin" "$controller_dir/verify-release.mjs" "$releases/$rollback" "$rollback" >/dev/null
    rollback_state_version=$(manifest_state_version "$releases/$rollback")
    if [ -n "$running_state_version" ] && [ "$rollback_state_version" != "$running_state_version" ]; then
      echo "rollback $rollback is state version $rollback_state_version, running server is $running_state_version" >&2
      publish "failed $target rollback"
      return 1
    fi
  fi

  target_state_version=$(manifest_state_version "$target_release")
  set +e
  TARGET_STATE_VERSION="$target_state_version" "$controller_dir/gate.sh"
  gate=$?
  set -e
  if [ "$gate" -eq 75 ]; then
    publish "busy $target"
    return 75
  fi
  [ "$gate" -eq 0 ] || return "$gate"

  "$systemctl_bin" --user daemon-reload
  "$systemctl_bin" --user stop avalon
  backup_snapshot "$target"
  select_release "$target"

  if "$systemctl_bin" --user start avalon && wait_for_commit "$target"; then
    publish "deployed $target"
    echo "deployed $target"
    return 0
  fi

  echo "release $target failed health; rolling back to ${rollback:-unknown}" >&2
  "$systemctl_bin" --user stop avalon || true
  if valid_target "$rollback" && [ -d "$releases/$rollback" ]; then
    select_release "$rollback"
    restore_snapshot "$target"
    "$systemctl_bin" --user start avalon
    if ! wait_for_commit "$rollback"; then
      echo "critical: rollback $rollback did not become healthy" >&2
    fi
  else
    echo 'critical: no verified rollback release is available' >&2
  fi
  publish "failed $target health"
  return 1
}

deploy_main() {
  git -C "$source_repo" fetch --quiet origin main
  target=$(git -C "$source_repo" rev-parse origin/main)
  deploy_target "$target"
}

case "${1:-}" in
  prepare) shift; [ "$#" -eq 1 ] || usage; prepare "$1" ;;
  deploy) shift; [ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage; deploy_target "$@" ;;
  deploy-main) shift; [ "$#" -eq 0 ] || usage; deploy_main ;;
  *) usage ;;
esac
