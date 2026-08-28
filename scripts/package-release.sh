#!/bin/sh
# Build the immutable, architecture-neutral server release for one commit.
set -eu

if [ "$#" -gt 2 ]; then
  echo 'Usage: package-release.sh [commit] [output-directory]' >&2
  exit 64
fi

root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse "${1:-HEAD}^{commit}")
output=${2:-"$root/dist"}
mkdir -p "$output"
output=$(cd "$output" && pwd)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
release="$stage/avalon-$commit"
mkdir "$release"

git -C "$root" archive "$commit" | tar -x -C "$release"
node "$release/scripts/write-release-manifest.mjs" "$commit" "$release/release.json"

archive="$output/avalon-$commit.tar.gz"
timestamp=$(git -C "$root" show -s --format=%ct "$commit")
tar --sort=name --mtime="@$timestamp" --owner=0 --group=0 --numeric-owner \
  -C "$stage" -cf - "avalon-$commit" | gzip -n >"$archive"

printf '%s\n' "$archive"
