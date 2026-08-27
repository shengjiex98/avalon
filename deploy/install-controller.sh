#!/bin/sh
# Install the deployment control plane outside every application release.
set -eu

here=$(cd -- "$(dirname "$0")" >/dev/null && pwd)
root=${AVALON_CONTROLLER_ROOT:-"$HOME/.local/libexec/avalon-deploy"}
version=$(sed -n '1p' "$here/controller-version")

case "$version" in
  *[!0-9]*|'') echo 'invalid controller version' >&2; exit 65 ;;
esac

versions="$root/versions"
destination="$versions/$version"
mkdir -p "$versions"

if [ -e "$destination" ]; then
  for file in controller.sh gate.sh lib.sh verify-release.mjs wait-for-health.mjs controller-version; do
    cmp -s "$here/$file" "$destination/$file" || {
      echo "controller version $version is already installed with different contents" >&2
      exit 65
    }
  done
else
  stage=$(mktemp -d "$versions/.install-$version.XXXXXX")
  cleanup() {
    [ -n "${stage:-}" ] && [ -d "$stage" ] && rm -rf -- "$stage"
  }
  trap cleanup EXIT HUP INT TERM
  install -m 755 "$here/controller.sh" "$here/gate.sh" "$stage/"
  install -m 644 "$here/lib.sh" "$here/verify-release.mjs" \
    "$here/wait-for-health.mjs" "$here/controller-version" "$stage/"
  mv "$stage" "$destination"
  stage=
  trap - EXIT HUP INT TERM
fi

next="$root/.current-$version-$$"
ln -s "versions/$version" "$next"
mv -Tf "$next" "$root/current"
printf '%s\n' "$root/current"
