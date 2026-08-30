#!/bin/sh
# Install the stable updater, listener, and units from a trusted clone.
set -eu
umask 022

here=$(cd -- "$(dirname "$0")" >/dev/null && pwd)
root=${AVALON_CONTROLLER_ROOT:-"$HOME/.local/libexec/avalon-deploy"}
unit_dir=${AVALON_SYSTEMD_USER_DIR:-"$HOME/.config/systemd/user"}
state_dir=$(dirname "${AVALON_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/avalon/rooms.json}")
units='avalon.service avalon-listen.service avalon-update.service avalon-update.timer'

mkdir -p "$root" "$unit_dir"
# avalon.service no longer gets this directory from StateDirectory=, which
# also means nothing else creates it for ReadWritePaths= or holds its mode.
mkdir -p "$state_dir"
chmod 700 "$state_dir"

install_file() {
  source=$1
  destination=$2
  mode=$3
  staged="$(dirname "$destination")/.$(basename "$destination").tmp-$$"
  cp "$source" "$staged"
  chmod "$mode" "$staged"
  mv -f "$staged" "$destination"
}

install_file "$here/updater.sh" "$root/updater.sh" 755
install_file "$here/verify-pointer.mjs" "$root/verify-pointer.mjs" 644
install_file "$here/listen.mjs" "$root/listen.mjs" 644
install_file "$here/start.mjs" "$root/start.mjs" 644
for unit in $units; do
  install_file "$here/$unit" "$unit_dir/$unit" 644
done

printf '%s\n' "$root/updater.sh" "$root/verify-pointer.mjs" "$root/listen.mjs" "$root/start.mjs"
echo 'installed without starting a deployment' >&2
echo 'now run: systemctl --user daemon-reload' >&2
echo 'then run: systemctl --user enable --now avalon-update.timer avalon-listen' >&2
