#!/bin/sh
# Install the static half of the deployment control plane, from a clone.
#
# That half is one script -- bootstrap.sh -- plus the systemd units that call
# it. Everything else ships inside the release artifact and needs no install
# step at all. Run this once on a new host, and again only on the rare occasion
# bootstrap.sh itself changes; the controller warns when the installed copy has
# drifted from the release it just deployed.
#
# Idempotent, and safe to run over the older versioned-bundle layout: each unit
# is replaced atomically, symlink or not.
set -eu

here=$(cd -- "$(dirname "$0")" >/dev/null && pwd)
root=${AVALON_CONTROLLER_ROOT:-"$HOME/.local/libexec/avalon-deploy"}
unit_dir=${AVALON_SYSTEMD_USER_DIR:-"$HOME/.config/systemd/user"}
units='avalon.service avalon-listen.service avalon-update.service avalon-update@.service avalon-update.timer'

mkdir -p "$root" "$unit_dir"

# Write beside the destination, then rename: a reader either sees the old file
# or the new one, never a half-written script systemd is about to run.
install_file() {
  destination=$2
  staged="$(dirname "$destination")/.$(basename "$destination").tmp-$$"
  cp "$1" "$staged"
  chmod "$3" "$staged"
  mv -f "$staged" "$destination"
}

install_file "$here/bootstrap.sh" "$root/bootstrap.sh" 755
for unit in $units; do
  install_file "$here/$unit" "$unit_dir/$unit" 644
done

printf '%s\n' "$root/bootstrap.sh"
echo 'installed; now run: systemctl --user daemon-reload' >&2
