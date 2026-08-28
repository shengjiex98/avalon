#!/bin/sh
# Reconcile an Avalon host with the release selected by the installed
# latest.json pointer. This file is installed outside release directories and
# never executes deployment code from a candidate archive.
set -eu
umask 077

script_dir=$(cd -- "$(dirname "$0")" >/dev/null && pwd)

usage() {
  echo 'Usage: updater.sh reconcile [--force]' >&2
  exit 64
}

[ "${1:-}" = reconcile ] || usage
shift
force=0
case "$#:${1:-}" in
  0:) ;;
  1:--force) force=1 ;;
  *) usage ;;
esac

[ -n "${XDG_RUNTIME_DIR:-}" ] || XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR

# Host configuration is operator-owned and lives outside every release.
requested_port=${PORT:-}
if [ -f "$HOME/.config/avalon.env" ]; then
  . "$HOME/.config/avalon.env"
fi
PORT=${requested_port:-${PORT:-8420}}
export PORT

release_root=${AVALON_RELEASE_ROOT:-"$HOME/.local/lib/avalon"}
releases="$release_root/releases"
rollbacks="$release_root/rollback"
artifact_base=${AVALON_ARTIFACT_BASE:-"https://github.com/shengjiex98/avalon/releases/download/deployment-artifacts"}
node_bin=${AVALON_NODE:-"$HOME/.local/bin/node"}
systemctl_bin=${AVALON_SYSTEMCTL:-systemctl}
state_file=${AVALON_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/avalon/rooms.json}
health_timeout=${AVALON_HEALTH_TIMEOUT_SECONDS:-30}
keep_releases=${AVALON_KEEP_RELEASES:-2}

log() {
  printf '%s\n' "avalon-updater: $*" >&2
}

valid_commit() {
  case "${1:-}" in *[!0-9a-f]*|'') return 1 ;; esac
  [ "${#1}" -eq 40 ]
}

case "$PORT" in *[!0-9]*|'') log "invalid PORT $PORT"; exit 64 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || { log "invalid PORT $PORT"; exit 64; }
case "$keep_releases" in *[!0-9]*|'') log 'AVALON_KEEP_RELEASES must be a nonnegative integer'; exit 64 ;; esac

for tool in curl tar sha256sum flock mktemp chmod cp mv rm mkdir ln readlink sed date sleep; do
  command -v "$tool" >/dev/null 2>&1 || { log "$tool is required"; exit 69; }
done
[ -x "$node_bin" ] || { log "Node runtime is not executable: $node_bin"; exit 69; }
[ -f "$script_dir/verify-pointer.mjs" ] || { log 'installed verify-pointer.mjs is missing'; exit 69; }
case "$("$node_bin" -v 2>/dev/null || true)" in
  v24.*) ;;
  *) log "Node 24 is required; found $("$node_bin" -v 2>/dev/null || echo unknown)"; exit 69 ;;
esac
"$node_bin" -e '
  const value = Number(process.argv[1]);
  process.exit(Number.isFinite(value) && value > 0 ? 0 : 1);
' "$health_timeout" || { log 'health timeout must be a positive number'; exit 64; }

mkdir -p "$releases" "$rollbacks"
exec 9>"$release_root/.deploy.lock"
if ! flock -n 9; then
  log 'another reconciliation is already in flight; nothing to do'
  exit 0
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/avalon-update.XXXXXX")
stage=
cleanup() {
  code=$?
  if [ -n "${stage:-}" ] && [ -d "$stage" ]; then
    chmod -R u+w "$stage" 2>/dev/null || true
    rm -rf -- "$stage"
  fi
  [ ! -d "$work" ] || rm -rf -- "$work"
  exit "$code"
}
trap cleanup EXIT HUP INT TERM

pointer="$work/latest.json"
pointer_url="$artifact_base/latest.json?t=$(date +%s)"
curl -fsSL --retry 3 --connect-timeout 10 --max-time 30 \
  -H 'Cache-Control: no-cache' "$pointer_url" -o "$pointer" || {
    log 'cannot download latest.json'
    exit 1
  }

pointer_values=$("$node_bin" "$script_dir/verify-pointer.mjs" "$pointer") || exit $?
commit=$(printf '%s\n' "$pointer_values" | sed -n '1p')
digest=$(printf '%s\n' "$pointer_values" | sed -n '2p')
valid_commit "$commit" || { log 'pointer verifier returned an invalid commit'; exit 1; }
archive="avalon-$commit.tar.gz"
release="$releases/$commit"

# Prints commit, stateVersion, and apiProtocol. All validation logic here is
# installed code passed through -e; no verifier from the candidate is run.
verify_release() {
  "$node_bin" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [release, expected] = process.argv.slice(1);
    const fail = (message) => { throw new Error(message); };
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(release, "release.json"), "utf8")); }
    catch (error) { fail(`cannot read release.json: ${error.message}`); }
    if (manifest.commit !== expected) fail("manifest commit does not match pointer");
    if (!Number.isInteger(manifest.stateVersion) || manifest.stateVersion < 1) fail("invalid stateVersion");
    if (!Number.isInteger(manifest.apiProtocol) || manifest.apiProtocol < 1) fail("invalid apiProtocol");
    if (manifest.nodeMajor !== 24) fail(`unsupported Node major ${manifest.nodeMajor}`);
    if (manifest.deployerSchema !== 1) fail(`unsupported deployer schema ${manifest.deployerSchema}`);
    for (const name of ["package.json", "src/server.js", "public/index.html"]) {
      const file = path.join(release, name);
      let stat;
      try { stat = fs.statSync(file); } catch { fail(`missing ${name}`); }
      if (!stat.isFile()) fail(`${name} is not a regular file`);
    }
    process.stdout.write(`${manifest.commit}\n${manifest.stateVersion}\n${manifest.apiProtocol}\n`);
  ' "$1" "$2"
}

# The tar implementation also rejects absolute and parent-traversing names;
# this explicit pass additionally enforces the one derived top-level root.
verify_archive_names() {
  listing=$1
  expected_root="avalon-$2"
  "$node_bin" -e '
    const fs = require("node:fs");
    const [listing, root] = process.argv.slice(1);
    const names = fs.readFileSync(listing, "utf8").split("\n").filter(Boolean);
    if (!names.length) throw new Error("archive is empty");
    for (const raw of names) {
      const name = raw.replace(/\/$/, "");
      if (!name || name.startsWith("/") || name.includes("\\")) throw new Error(`unsafe archive path ${JSON.stringify(raw)}`);
      const parts = name.split("/");
      if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`unsafe archive path ${JSON.stringify(raw)}`);
      if (parts[0] !== root) throw new Error(`unexpected archive root ${JSON.stringify(parts[0])}`);
    }
  ' "$listing" "$expected_root"
}

verify_archive_links() {
  "$node_bin" -e '
    const fs = require("node:fs");
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      const separator = line.includes(" -> ") ? " -> " : line.includes(" link to ") ? " link to " : null;
      if (!separator) continue;
      const target = line.slice(line.indexOf(separator) + separator.length).trim();
      if (!target || target.startsWith("/") || target.split("/").includes("..")) {
        throw new Error(`archive link escapes release: ${JSON.stringify(target)}`);
      }
    }
  ' "$1"
}

# Check extracted object types without following links. Internal symlinks are
# allowed, but every target must resolve lexically inside the immutable tree;
# hard links are rejected because the release format does not need them.
verify_extracted_tree() {
  "$node_bin" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.resolve(process.argv[1]);
    const inside = (candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
          const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
          if (!inside(target)) throw new Error(`symlink escapes release: ${path.relative(root, file)}`);
        } else if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) {
          if (stat.nlink !== 1) throw new Error(`hard link is not allowed: ${path.relative(root, file)}`);
        } else throw new Error(`unsupported archive entry: ${path.relative(root, file)}`);
      }
    };
    visit(root);
  ' "$1"
}

selected_release() {
  readlink "$release_root/current" 2>/dev/null || true
}

select_release() {
  selected=$1
  next="$release_root/.current-$selected-$$"
  ln -s "releases/$selected" "$next"
  "$node_bin" -e '
    const fs = require("node:fs");
    fs.renameSync(process.argv[1], process.argv[2]);
  ' "$next" "$release_root/current" || {
    rm -f -- "$next"
    return 1
  }
}

# 0 = valid response written to stdout; 2 = server unavailable; 1 = reachable
# but malformed/unexpected, which must fail closed.
read_health() {
  output="$work/health.json"
  if ! code=$(curl -sS --connect-timeout 2 --max-time 5 -o "$output" -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/health"); then
    return 2
  fi
  [ "$code" = 200 ] || { log "health endpoint returned $code"; return 1; }
  "$node_bin" -e '
    const fs = require("node:fs");
    const h = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("health is not an object");
    if (typeof h.commit !== "string" || !/^[0-9a-f]{40}$/.test(h.commit)) throw new Error("health commit is unknown");
    if (!Number.isInteger(h.activeGames) || h.activeGames < 0) throw new Error("invalid activeGames");
    const version = (value) => Number.isInteger(value) && value > 0 ? String(value) : "";
    process.stdout.write(`${h.commit}\n${version(h.stateVersion)}\n${version(h.protocol)}\n${h.activeGames}\n`);
  ' "$output" || { log 'health response is malformed'; return 1; }
}

health_values=
server_available=1
set +e
health_values=$(read_health)
health_status=$?
set -e
case "$health_status" in
  0) ;;
  2) server_available=0 ;;
  *) exit "$health_status" ;;
esac

running_commit=$(printf '%s\n' "$health_values" | sed -n '1p')
running_state=$(printf '%s\n' "$health_values" | sed -n '2p')
running_protocol=$(printf '%s\n' "$health_values" | sed -n '3p')

if [ "$server_available" -eq 1 ] && [ "$running_commit" = "$commit" ] && \
  [ "$(selected_release)" = "releases/$commit" ]; then
  log "$commit is already selected and serving"
  exit 0
fi

if [ -d "$release" ]; then
  manifest_values=$(verify_release "$release" "$commit") || { log "existing release $commit is invalid"; exit 1; }
else
  downloaded="$work/$archive"
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 300 \
    "$artifact_base/$archive" -o "$downloaded" || { log "cannot download $archive"; exit 1; }
  actual=$(sha256sum "$downloaded" | sed 's/[[:space:]].*//')
  [ "$actual" = "$digest" ] || { log "checksum mismatch for $archive"; exit 1; }

  tar -tzf "$downloaded" >"$work/archive.list" || { log "cannot list $archive"; exit 1; }
  verify_archive_names "$work/archive.list" "$commit" || { log "unsafe $archive"; exit 1; }
  tar -tvzf "$downloaded" >"$work/archive.verbose" || { log "cannot inspect $archive"; exit 1; }
  verify_archive_links "$work/archive.verbose" || { log "unsafe link in $archive"; exit 1; }
  stage=$(mktemp -d "$releases/.staging-$commit.XXXXXX")
  tar -xzf "$downloaded" --strip-components=1 -C "$stage" || { log "cannot extract $archive"; exit 1; }
  verify_extracted_tree "$stage" || { log "unsafe extracted tree in $archive"; exit 1; }
  manifest_values=$(verify_release "$stage" "$commit") || { log "invalid manifest in $archive"; exit 1; }
  chmod -R a-w "$stage"
  mv "$stage" "$release"
  stage=
fi

target_state=$(printf '%s\n' "$manifest_values" | sed -n '2p')
target_protocol=$(printf '%s\n' "$manifest_values" | sed -n '3p')

# Resolve and validate the rollback before asking systemd to stop anything.
selected=$(selected_release)
rollback=
case "$selected" in
  '')
    if [ "$server_available" -eq 1 ]; then
      log 'a server is running but no verified rollback release is selected'
      exit 1
    fi
    ;;
  releases/*)
    rollback=${selected#releases/}
    valid_commit "$rollback" || { log "current points at an invalid release: $selected"; exit 1; }
    [ -d "$releases/$rollback" ] || { log "current release $rollback is missing"; exit 1; }
    verify_release "$releases/$rollback" "$rollback" >/dev/null || { log "rollback release $rollback is invalid"; exit 1; }
    if [ "$server_available" -eq 1 ] && [ "$running_commit" != "$rollback" ]; then
      log "health reports $running_commit but current selects $rollback"
      exit 1
    fi
    ;;
  *) log "current points outside releases: $selected"; exit 1 ;;
esac

if [ "$force" -eq 1 ]; then
  log "warning: operator forced deployment of $commit"
elif [ "$server_available" -eq 0 ]; then
  log 'server is unavailable; proceeding because nothing answered the ordinary health check'
elif [ -n "$running_state" ] && [ -n "$running_protocol" ] && \
  [ "$running_state" = "$target_state" ] && [ "$running_protocol" = "$target_protocol" ]; then
  : # Snapshot and browser protocols are both compatible.
else
  update_body="$work/update-health.json"
  set +e
  update_code=$(curl -sS --connect-timeout 2 --max-time 5 -o "$update_body" -w '%{http_code}' \
    "http://127.0.0.1:$PORT/api/health/update")
  update_status=$?
  set -e
  [ "$update_status" -eq 0 ] || { log 'update gate became unreachable after health succeeded'; exit 1; }
  case "$update_code" in
    200)
      "$node_bin" -e '
        const fs = require("node:fs");
        const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (body?.updateSafe !== true) throw new Error("update endpoint did not declare safety");
      ' "$update_body" || { log 'update gate returned malformed permission'; exit 1; }
      ;;
    409) log "active game deferred incompatible release $commit"; exit 75 ;;
    *) log "unexpected update gate response $update_code"; exit 1 ;;
  esac
fi

wait_for_commit() {
  expected=$1
  attempts=$("$node_bin" -e '
    const seconds = Number(process.argv[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) process.exit(64);
    console.log(Math.max(1, Math.ceil(seconds * 4)));
  ' "$health_timeout") || return 1
  i=0
  while [ "$i" -lt "$attempts" ]; do
    body="$work/wait-health.json"
    set +e
    code=$(curl -sS --connect-timeout 1 --max-time 2 -o "$body" -w '%{http_code}' \
      "http://127.0.0.1:$PORT/api/health")
    status=$?
    set -e
    if [ "$status" -eq 0 ] && [ "$code" = 200 ] && \
      "$node_bin" -e '
        const fs = require("node:fs");
        const [file, expected] = process.argv.slice(1);
        process.exit(JSON.parse(fs.readFileSync(file, "utf8")).commit === expected ? 0 : 1);
      ' "$body" "$expected" 2>/dev/null; then
      return 0
    fi
    i=$((i + 1))
    [ "$i" -ge "$attempts" ] || sleep 0.25
  done
  log "Avalon did not serve $expected before the health timeout"
  return 1
}

restore_snapshot() {
  mkdir -p "$(dirname "$state_file")"
  if [ -f "$backup_dir/rooms.json" ]; then
    cp -p "$backup_dir/rooms.json" "$state_file.restore"
    mv -f "$state_file.restore" "$state_file"
  elif [ -f "$backup_dir/no-snapshot" ]; then
    rm -f -- "$state_file" "$state_file.tmp"
  fi
}

restart_unchanged() {
  if valid_commit "$rollback" && [ -d "$releases/$rollback" ]; then
    "$systemctl_bin" --user start avalon || true
    if ! wait_for_commit "$rollback"; then
      log "critical: unchanged release $rollback did not become healthy"
    fi
  fi
}

backup_dir="$rollbacks/$commit"
rm -rf -- "$backup_dir"
mkdir -p "$backup_dir"

"$systemctl_bin" --user stop avalon
# The stop above lets the old server make its final atomic snapshot before the
# transaction copies it. If backup or selection fails, restart the untouched
# release rather than leaving a healthy old service stopped.
if [ -f "$state_file" ]; then
  if ! cp -p "$state_file" "$backup_dir/rooms.json" || \
    ! : >"$backup_dir/had-snapshot"; then
    log 'cannot back up the stopped server snapshot'
    restart_unchanged
    exit 1
  fi
else
  if ! : >"$backup_dir/no-snapshot"; then
    log 'cannot record the absence of a server snapshot'
    restart_unchanged
    exit 1
  fi
fi

if ! select_release "$commit"; then
  log "cannot atomically select $commit"
  restart_unchanged
  exit 1
fi

if "$systemctl_bin" --user start avalon && wait_for_commit "$commit"; then
  log "deployed $commit"
else
  log "release $commit failed health; rolling back to ${rollback:-no previous release}"
  "$systemctl_bin" --user stop avalon || true
  if valid_commit "$rollback" && [ -d "$releases/$rollback" ]; then
    if ! select_release "$rollback"; then
      log "critical: cannot restore rollback pointer $rollback"
      rm -f -- "$release_root/current"
      rollback=
    fi
  else
    rm -f -- "$release_root/current"
  fi
  restore_snapshot
  if valid_commit "$rollback" && [ -d "$releases/$rollback" ]; then
    "$systemctl_bin" --user start avalon || true
    if ! wait_for_commit "$rollback"; then
      log "critical: rollback $rollback did not become healthy"
    fi
  else
    log 'critical: no verified rollback release is available'
  fi
  exit 1
fi

# Pruning is deliberately last. Preserve the selected release, its immediate
# rollback, and AVALON_KEEP_RELEASES other releases.
extra=0
ordered_releases=$("$node_bin" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const sha = /^[0-9a-f]{40}$/;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && sha.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      modified: fs.statSync(path.join(root, entry.name)).mtimeMs,
    }))
    .sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
  for (const entry of entries) console.log(path.join(root, entry.name));
' "$releases")
for candidate in $ordered_releases; do
  name=${candidate##*/}
  valid_commit "$name" || continue
  [ "$name" = "$commit" ] && continue
  [ -n "$rollback" ] && [ "$name" = "$rollback" ] && continue
  if [ "$extra" -lt "$keep_releases" ]; then
    extra=$((extra + 1))
  else
    chmod -R u+w "$candidate" 2>/dev/null || true
    rm -rf -- "$candidate"
  fi
done
for stale in "$releases"/.staging-*; do
  [ ! -d "$stale" ] || { chmod -R u+w "$stale" 2>/dev/null || true; rm -rf -- "$stale"; }
done
for backup in "$rollbacks"/*; do
  [ -d "$backup" ] || continue
  name=${backup##*/}
  valid_commit "$name" || continue
  [ -d "$releases/$name" ] || rm -rf -- "$backup"
done

exit 0
