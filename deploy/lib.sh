# Sourced by the deploy scripts. Nothing here runs on its own.
#
# What both the gate and the updater need to know: which port this host's
# server listens on, and what the *running* process reports about itself.

# Host settings live outside the repo. An explicit PORT in the environment
# still wins, so a second server can be gated on its own port.
avalon_load_env() {
  requested="${PORT:-}"
  [ -f "$HOME/.config/avalon.env" ] && . "$HOME/.config/avalon.env"
  PORT="${requested:-${PORT:-8420}}"
  export PORT
}

# The commit and the state version the running process reports, one per line.
# Both lines are empty when the server is down or answers something else --
# callers treat that as "unknown", never as a value.
#
# node rather than curl/jq: the project ships no dependencies, and the runtime
# is by definition installed wherever the server runs.
avalon_health() {
  node -e '
    fetch(`http://127.0.0.1:${process.env.PORT}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).then((h) => {
        console.log(h.commit ?? "");
        console.log(h.stateVersion ?? "");
      })
      .catch(() => console.log("\n"));
  ' 2>/dev/null || true
}
