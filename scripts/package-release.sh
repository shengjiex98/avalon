#!/bin/sh
# Assemble the already-built application into one immutable server release.
set -eu

if [ "$#" -gt 3 ]; then
  echo 'Usage: package-release.sh [commit] [output-directory] [browser-directory]' >&2
  exit 64
fi

root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse "${1:-HEAD}^{commit}")
output=${2:-"$root/dist"}
browser=${3:-"$root/dist/self-hosted-public"}
server="$root/build/server"
if [ ! -d "$browser" ]; then
  echo "package-release.sh: missing tested browser output: $browser" >&2
  exit 66
fi
if [ ! -f "$server/main.mjs" ]; then
  echo "package-release.sh: missing tested server output: $server/main.mjs" >&2
  exit 66
fi
mkdir -p "$output"
output=$(cd "$output" && pwd)
browser=$(cd "$browser" && pwd)
server=$(cd "$server" && pwd)

archive="$output/avalon-$commit.tar.gz"
partial="$output/.avalon-$commit.tar.gz.$$"
stage=$(mktemp -d)
trap 'rm -rf "$stage" "$partial"' EXIT HUP INT TERM

release="$stage/avalon-$commit"
mkdir -p "$release/build"
cp -R "$browser" "$release/build/public"
cp -R "$server" "$release/build/server"
node "$root/scripts/write-release-manifest.mjs" "$commit" "$release/release.json"

# Until the final rename, the output directory contains no candidate that an
# updater could select. Read the completed partial archive back before publish.
tar -C "$stage" -czf "$partial" "avalon-$commit"
tar -tzf "$partial" >/dev/null
mv "$partial" "$archive"

printf '%s\n' "$archive"
