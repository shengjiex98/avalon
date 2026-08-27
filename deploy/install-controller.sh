#!/bin/sh
# Install the deployment control plane outside every application release.
set -eu

here=$(cd -- "$(dirname "$0")" >/dev/null && pwd)
root=${AVALON_CONTROLLER_ROOT:-"$HOME/.local/libexec/avalon-deploy"}
unit_dir=${AVALON_SYSTEMD_USER_DIR:-"$HOME/.config/systemd/user"}
version=$(sed -n '1p' "$here/controller-version")
bundle_files='controller.sh gate.sh lib.sh verify-release.mjs wait-for-health.mjs controller-version avalon.service avalon-update.service avalon-update.timer'

case "$version" in
  *[!0-9]*|'') echo 'invalid controller version' >&2; exit 65 ;;
esac

versions="$root/versions"
destination="$versions/$version"
mkdir -p "$versions"

if [ -e "$destination" ]; then
  for file in $bundle_files; do
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
    "$here/wait-for-health.mjs" "$here/controller-version" \
    "$here/avalon.service" "$here/avalon-update.service" \
    "$here/avalon-update.timer" "$stage/"
  mv "$stage" "$destination"
  stage=
  trap - EXIT HUP INT TERM
fi

next="$root/.current-$version-$$"
ln -s "versions/$version" "$next"
mv -Tf "$next" "$root/current"

# Unit links target the stable controller pointer, so one controller selection
# updates the control plane as a set. Replace each legacy checkout link
# atomically; systemd observes the new files on its next daemon-reload.
mkdir -p "$unit_dir"
for unit in avalon.service avalon-update.service avalon-update.timer; do
  next_unit="$unit_dir/.$unit-$version-$$"
  ln -s "$root/current/$unit" "$next_unit"
  mv -Tf "$next_unit" "$unit_dir/$unit"
done

printf '%s\n' "$root/current"
