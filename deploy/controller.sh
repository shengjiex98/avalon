#!/bin/sh
# Stable host-side controller for immutable Avalon application releases.
set -eu

controller_dir=$(cd -- "$(dirname "$0")" >/dev/null && pwd)
source_repo=${AVALON_SOURCE_REPO:-"$HOME/avalon"}
release_root=${AVALON_RELEASE_ROOT:-"$HOME/.local/lib/avalon"}
releases="$release_root/releases"

usage() {
  echo 'Usage: controller.sh prepare <40-character-commit>' >&2
  exit 64
}

prepare() {
  target=${1:-}
  case "$target" in
    *[!0-9a-f]*|'') usage ;;
  esac
  [ "${#target}" -eq 40 ] || usage

  case "$(node -v)" in
    v24.*) ;;
    *) echo "unexpected node $(node -v); refusing $target" >&2; exit 1 ;;
  esac

  git -C "$source_repo" cat-file -e "$target^{commit}"
  mkdir -p "$releases"
  release="$releases/$target"
  if [ -d "$release" ]; then
    node "$controller_dir/verify-release.mjs" "$release" "$target" >/dev/null
    printf '%s\n' "$release"
    return 0
  fi

  stage=$(mktemp -d "$releases/.staging-$target.XXXXXX")
  cleanup() {
    [ -n "${stage:-}" ] && [ -d "$stage" ] && rm -rf -- "$stage"
  }
  trap cleanup EXIT HUP INT TERM

  git -C "$source_repo" archive "$target" | tar -x -C "$stage"
  node "$stage/scripts/write-release-manifest.mjs" "$target" "$stage/release.json"
  node "$controller_dir/verify-release.mjs" "$stage" "$target" >/dev/null

  (
    cd "$stage"
    env -u TARGET_STATE_VERSION -u AVALON_FORCE \
      node --test "test/**/*.test.js"
  )

  node "$controller_dir/verify-release.mjs" "$stage" "$target" >/dev/null
  chmod -R a-w "$stage"
  mv "$stage" "$release"
  stage=
  trap - EXIT HUP INT TERM
  printf '%s\n' "$release"
}

case "${1:-}" in
  prepare) shift; [ "$#" -eq 1 ] || usage; prepare "$1" ;;
  *) usage ;;
esac
