#!/bin/sh
# Build the immutable, architecture-neutral server release for one commit.
#
# The archive must be byte-identical for a given commit on every machine that
# builds it, which is what lets the host compare a downloaded release against
# the one CI published. That reproducibility comes from GNU tar's --sort and
# --mtime and from gzip -n; a tar without them cannot produce this artifact.
set -eu

if [ "$#" -gt 4 ]; then
  echo 'Usage: package-release.sh [commit] [output-directory] [browser-directory] [node-modules-directory]' >&2
  exit 64
fi

if ! tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
     -cf /dev/null -T /dev/null 2>/dev/null; then
  echo 'package-release.sh: this tar cannot build reproducible archives.' >&2
  echo 'It needs GNU tar (--sort, --mtime, --numeric-owner); BSD tar will not do.' >&2
  echo 'On macOS: brew install gnu-tar, then put gtar on PATH as tar.' >&2
  exit 69
fi

root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse "${1:-HEAD}^{commit}")
output=${2:-"$root/dist"}
browser=${3:-"$root/build/public"}
modules=${4:-"$root/node_modules"}
if [ ! -d "$browser" ]; then
  echo "package-release.sh: missing tested browser output: $browser" >&2
  exit 66
fi
if [ ! -d "$modules" ]; then
  echo "package-release.sh: missing installed dependencies: $modules" >&2
  exit 66
fi
mkdir -p "$output"
output=$(cd "$output" && pwd)
browser=$(cd "$browser" && pwd)
modules=$(cd "$modules" && pwd)

archive="$output/avalon-$commit.tar.gz"
partial="$output/.avalon-$commit.tar.gz.$$"
stage=$(mktemp -d)
trap 'rm -rf "$stage" "$partial"' EXIT HUP INT TERM

# Every step is its own command. A pipeline would report only the exit status
# of its last stage, which is how a failed `tar -x` once produced an empty
# archive that looked like a successful release.
release="$stage/avalon-$commit"
mkdir "$release"
git -C "$root" archive --format=tar "$commit" -- \
  deploy package.json package-lock.json src >"$stage/source.tar"
tar -xf "$stage/source.tar" -C "$release"
rm -f "$stage/source.tar"
mkdir "$release/scripts"
cp "$root/scripts/verify-browser-artifact.mjs" "$release/scripts/verify-browser-artifact.mjs"
cp "$root/scripts/verify-packaged-release.mjs" "$release/scripts/verify-packaged-release.mjs"
cp "$root/scripts/write-release-manifest.mjs" "$release/scripts/write-release-manifest.mjs"
mkdir -p "$release/build"
cp -R "$browser" "$release/build/public"
mkdir "$release/public"
ln -s ../build/public/index.html "$release/public/index.html"
cp -R "$modules" "$release/node_modules"
npm prune --omit=dev --ignore-scripts --no-audit --no-fund --offline --prefix "$release"
node "$release/scripts/write-release-manifest.mjs" "$commit" "$release/release.json"
rm "$release/scripts/write-release-manifest.mjs"

timestamp=$(git -C "$root" show -s --format=%ct "$commit")
tar --sort=name --mtime="@$timestamp" --owner=0 --group=0 --numeric-owner \
  -C "$stage" -cf "$stage/release.tar" "avalon-$commit"
gzip -n -c "$stage/release.tar" >"$partial"

# Publish only an archive that reads back. Until the rename the output
# directory holds no file that an updater would mistake for a release.
tar -tzf "$partial" >/dev/null
mv "$partial" "$archive"

printf '%s\n' "$archive"
