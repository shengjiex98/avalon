# Plan: collapse the versioned deploy controller into a static bootstrap

Repository: `shengjiex98/avalon`. Audience: a coding agent or engineer with
access to the repo and (for the cutover) the game-server host. Read
`docs/deployment.md`, `deploy/controller.sh`, and `deploy/install-controller.sh`
before starting — this plan changes them.

## Why

PRs #41–#51 moved deployment off the mutable checkout onto immutable release
artifacts. That part is right and stays. But they also made the control plane a
**separately versioned bundle**: 13 files copied to
`~/.local/libexec/avalon-deploy/versions/<n>` by `install-controller.sh`,
tracked by a hand-bumped `deploy/controller-version` (bumped in 7 of those 11
PRs), with systemd units as symlinks into the bundle. Every controller change
now needs a PR *and* a manual host install, the installed controller can drift
from the repo, and the bundle has recreated the original problem one level up:
the updater needs its own update mechanism.

The fix: split the control plane by **mutability**, not by "deploy vs app".

1. **Static layer** — one ~70-line `bootstrap.sh`, installed once at
   `~/.local/libexec/avalon-deploy/bootstrap.sh`, expected never to change. It
   only: resolves GitHub `main`, downloads and checksum-verifies that commit's
   release tarball, extracts it to a temp dir, and runs **that commit's own**
   `deploy/controller.sh`.
2. **Versioned layer** — everything else (`controller.sh`, `gate.sh`,
   `lib.sh`, `listen.mjs`, `verify-release.mjs`, `wait-for-health.mjs`, the
   systemd units) stays in `deploy/` in the repo and **ships inside the release
   artifact** (it already does: `package-release.sh` uses `git archive`, so
   every tracked file is in the tarball). Deploy-logic changes then ship
   through the exact same CI pipeline, tests, and health-gated rollout as app
   changes — no version file, no install step, no drift.

Deleted outright: `deploy/controller-version`, `deploy/install-controller.sh`,
`deploy/update.sh` (legacy checkout updater), `deploy/resolve-main.mjs`
(inlined into the bootstrap).

Unchanged: `gate.sh` semantics (exit 75 / busy / hourly retry),
`scripts/package-release.sh`, the release manifest schema,
`.github/workflows/deploy.yml`, the ntfy trigger design, snapshot
backup/restore, and `avalon.service`'s execution model
(`current` symlink + `--preserve-symlinks-main`).

## Design decisions already made (do not re-litigate)

- **The candidate commit's controller performs its own deployment, rollback
  included.** Safe because CI runs `test/controller.test.js` from the exact
  artifact before publishing it, and because a broken controller strands
  *deployments*, never the running server; the next fix commit heals it via
  the same bootstrap. This trade (rare stranding vs. permanent
  two-pipeline coordination) is accepted.
- **The bootstrap never executes downloaded bytes before the checksum
  verifies.** This ordering is load-bearing; preserve it in any refactor.
- **The bootstrap does not self-update, and the controller does not overwrite
  it.** The controller *warns* on drift (journal + ntfy); a human runs
  `deploy/install-bootstrap.sh` from a clone. Keeps the static layer genuinely
  static.
- **systemd units are release-managed real files**, copied (not symlinked)
  into `~/.config/systemd/user/` by the controller during the switch, and
  restored from the rollback release on failed health. Unit changes ship by PR
  again, with rollback.
- **Environment hygiene** (the PR#39 lesson): the bootstrap invokes the
  controller with an explicit `env -i` allowlist, and the controller keeps its
  existing scrub of `TARGET_STATE_VERSION` / `AVALON_FORCE` before tests.
  Regression-test both.

Deliver as **two PRs**: PR 1 lands the new machinery (inert until installed on
the host — the old controller v6 ignores it), the host cutover happens
manually, PR 2 deletes the superseded machinery and its deployment proves the
new path end-to-end.

---

## PR 1 — add the bootstrap, make the release self-deploying

### 1. `deploy/bootstrap.sh` (new, POSIX sh, target ≤ ~80 lines)

Modes, matching the units that call it:

```
bootstrap.sh deploy-trigger <40-hex-sha>   # from avalon-update@%i (ntfy listener)
bootstrap.sh deploy-main                   # from avalon-update.timer (hourly)
```

Behavior, in order:

1. `set -eu`; default `XDG_RUNTIME_DIR=/run/user/$(id -u)` if unset; source
   `~/.config/avalon.env` if present (for `PORT`, `NTFY_TOPIC`, `NTFY_SERVER`).
2. Take an exclusive non-blocking `flock` on
   `~/.local/lib/avalon/.deploy.lock`; if held, log and exit 0 (another
   deployment is in flight — today the timer and a trigger can race; this
   closes that gap).
3. Resolve `main` to a sha via the GitHub API (inline `node -e` fetch of
   `AVALON_MAIN_URL`, defaulting to the repo's `commits/main` endpoint —
   port the logic from `deploy/resolve-main.mjs`; validate `^[0-9a-f]{40}$`).
   Node is at `${AVALON_NODE:-$HOME/.local/bin/node}` as in the controller.
4. `deploy-trigger`: if the argument ≠ resolved main, log
   `ignored deployment trigger …` and exit 0 (moved verbatim from
   `controller.sh deploy_trigger`).
5. Download `avalon-<sha>.tar.gz` and `.sha256` from
   `${AVALON_ARTIFACT_BASE:-https://github.com/shengjiex98/avalon/releases/download/deployment-artifacts}`
   into a `mktemp -d`; verify with `sha256sum`; extract
   (`--strip-components=1`) into a second temp dir. Reuse the curl
   flags/checksum validation patterns from `controller.sh prepare`.
6. Run `<tmp>/deploy/controller.sh deploy <sha>` as a **child process** (not
   `exec`, so the temp dirs get cleaned up afterwards), with an explicit
   environment allowlist:
   `env -i HOME PATH XDG_RUNTIME_DIR PORT NTFY_TOPIC NTFY_SERVER` plus the
   `AVALON_*` overrides the test harness needs (`AVALON_NODE`,
   `AVALON_RELEASE_ROOT`, `AVALON_ARTIFACT_BASE`, `AVALON_MAIN_URL`,
   `AVALON_SYSTEMCTL`, `AVALON_STATE_FILE`, `AVALON_HEALTH_TIMEOUT_SECONDS`,
   `AVALON_SYSTEMD_USER_DIR`). `TARGET_STATE_VERSION` and `AVALON_FORCE` must
   not survive into that environment.
7. Propagate the controller's exit code unchanged — **75 must pass through**
   (the units treat it as success).
8. Any failure in steps 3–5: best-effort `publish "failed <sha> stage"` to
   ntfy (copy the 4-line `publish()` helper) and exit 1. `trap` cleanup of
   temp dirs on `EXIT HUP INT TERM`.

Note the deliberate double-download: the controller's `prepare` will download
the tarball again into `releases/.staging-*`. The archive is a few hundred KB
(no dependencies), and keeping `prepare` self-contained means the bootstrap
stays dumb and the controller's invariants ("nothing under `releases/` that
wasn't verified, tested, and sealed here") are untouched. Do not "optimize"
this by having the bootstrap write into `releases/`.

### 2. `deploy/install-bootstrap.sh` (new, replaces `install-controller.sh`)

Idempotent, run manually and rarely:

- Atomically install `bootstrap.sh` (mode 755) to
  `${AVALON_CONTROLLER_ROOT:-$HOME/.local/libexec/avalon-deploy}/bootstrap.sh`
  (write `.tmp`, `mv -f` — same pattern as the current installer).
- Copy the five unit files from its own source tree into
  `${AVALON_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}` as **regular
  files**, atomically replacing whatever is there (including the current
  symlinks into the v6 bundle).
- Print a reminder to `systemctl --user daemon-reload`.

### 3. `deploy/controller.sh` changes

- **Remove** the `deploy-main` and `deploy-trigger` modes,
  `deploy_main`/`deploy_trigger` functions, and the `main_url` default; the
  bootstrap owns target selection now. Usage becomes
  `prepare <commit> | deploy <commit> [rollback-commit]`.
- **Unit sync during the switch**: in `deploy_target`, just before the
  existing `daemon-reload`, copy `$target_release/deploy/{avalon.service,
  avalon-listen.service, avalon-update.service, avalon-update@.service,
  avalon-update.timer}` into `${AVALON_SYSTEMD_USER_DIR:-...}` (atomic
  per-file tmp+mv). In the failed-health rollback branch, copy the same set
  from `$releases/$rollback/deploy/` and `daemon-reload` again before
  restarting.
- **Listener refresh**: after a successful deploy (the `deployed` path),
  `"$systemctl_bin" --user try-restart avalon-listen || true` so the listener
  picks up the new release's `listen.mjs`. This cannot kill the in-flight
  update — the update runs in its own `avalon-update@` unit.
- **Bootstrap drift warning**: after a successful deploy, `cmp -s` the
  installed bootstrap against `$target_release/deploy/bootstrap.sh`; on
  mismatch, log to stderr and `publish "bootstrap drift <sha>"`. Never
  overwrite it.
- Optional, low priority — **release GC**: after a successful deploy, keep the
  current and rollback targets plus the 3 newest other releases; `chmod -R u+w`
  then `rm -rf` the rest (they are sealed read-only). Skip if it complicates
  the PR.

### 4. Unit file changes (in `deploy/`)

- `avalon-listen.service`: `WorkingDirectory` and `ExecStart` move from
  `%h/.local/libexec/avalon-deploy/current` to
  `%h/.local/lib/avalon/current` / `…/current/deploy/listen.mjs`. The
  listener now runs the *deployed release's* copy and is upgraded by
  `try-restart` after each deploy.
- `avalon-update.service`: `ExecStart=%h/.local/libexec/avalon-deploy/bootstrap.sh deploy-main`.
- `avalon-update@.service`: `ExecStart=%h/.local/libexec/avalon-deploy/bootstrap.sh deploy-trigger %i`.
- `avalon.service`, `avalon-update.timer`: content unchanged; update the
  header comments that say "the controller installer owns this unit".
- Keep `SuccessExitStatus=75` on both update units.

`listen.mjs`, `gate.sh`, `lib.sh`, `verify-release.mjs`,
`wait-for-health.mjs`: unchanged.

### 5. Tests

Follow the existing harness patterns in `test/controller.test.js` (env
overrides `AVALON_RELEASE_ROOT`, `AVALON_SYSTEMCTL` stub, `AVALON_ARTIFACT_BASE`
/ `AVALON_MAIN_URL` pointed at local fixtures).

- New `test/bootstrap.test.js`:
  - a tampered tarball (checksum mismatch) is rejected before anything from it
    executes;
  - `deploy-trigger` with a sha that is not current main exits 0 without
    downloading;
  - a held lock makes a second invocation exit 0 without deploying;
  - ambient `TARGET_STATE_VERSION` / `AVALON_FORCE` do not reach the
    controller (PR#39 regression, source-level or behavioral);
  - the controller is invoked from the extracted tree with `deploy <sha>`;
  - controller exit 75 propagates as bootstrap exit 75.
- `test/controller.test.js`: drop the `deploy-main`/`deploy-trigger` and
  `controller-version` cases; add: units are installed during a switch; failed
  health restores the rollback release's units; drift in the installed
  bootstrap produces the warning and does not modify the file.
- `test/release.test.js`: assert the packaged tarball contains
  `deploy/bootstrap.sh` and all five unit files (guards against a future
  `.gitattributes export-ignore` silently breaking self-deployment).

### 6. Docs (in PR 1, describing the new world)

- `docs/deployment.md` "Continuous deployment": replace the
  `install-controller.sh` install flow with `deploy/install-bootstrap.sh`;
  describe the two layers ("one static bootstrap; everything else rides in the
  release it deploys"); state that `controller.sh` runs from the downloaded
  release, not from any installed bundle; remove the `controller-version` and
  "separately versioned control plane" story; remove the claim that
  `deploy/update.sh` is the bootstrap path.
- Leave `AGENTS.md`/`CLAUDE.md` for PR 2.

Verification: `npm test` (CI runs the suite from the packaged tarball, which
now exercises the new files in their shipped form).

---

## Host cutover (manual, on the game-server host, ~10 minutes)

Current host state, verified 2026-08-26: controller bundle v6 active at
`~/.local/libexec/avalon-deploy/current` (versions 1–6 accumulated), unit
symlinks point into it, live release `a5b01ba…` == `main`, `avalon`,
`avalon-listen`, and the hourly timer all running.

1. Merge PR 1. The **old** controller v6 deploys it as an ordinary app
   release. Confirm `curl -s localhost:8420/api/health | jq .commit` equals
   the merge sha.
2. From a clone at that commit (e.g. `~/avalon` after `git pull`, or a
   worktree): run `deploy/install-bootstrap.sh`, then
   `systemctl --user daemon-reload && systemctl --user restart avalon-listen`.
   Do not restart `avalon` — its unit semantics are unchanged and the game
   server never stops during cutover.
3. Prove the new path: `systemctl --user start avalon-update.service` and
   check `journalctl --user -u avalon-update -e` — expect the bootstrap to
   resolve main, download, and the controller to report already-current.
   Then trigger the Deploy workflow (`workflow_dispatch` or merging PR 2) for
   a full end-to-end deployment through listener → bootstrap → controller.
4. Cleanup: `rm -rf ~/.local/libexec/avalon-deploy/versions ~/.local/libexec/avalon-deploy/current`
   (only `bootstrap.sh` remains in that directory).
5. Rollback plan if the new path misbehaves: the old control plane is one
   command away —
   `git -C ~/avalon show <pre-PR1-sha>:deploy/install-controller.sh` restored
   together with its bundle files via
   `git -C ~/avalon checkout <pre-PR1-sha> -- deploy && deploy/install-controller.sh && systemctl --user daemon-reload`
   (then `git checkout main -- deploy` to clean up). The server itself is
   never at risk: worst case, deployments stall while it keeps serving.

---

## PR 2 — delete the superseded machinery (after cutover is proven)

- Delete `deploy/update.sh`, `deploy/install-controller.sh`,
  `deploy/controller-version`, `deploy/resolve-main.mjs`.
- Delete/rewrite `test/deploy.test.js` (it tests `update.sh`); keep any gate
  coverage by moving it next to the gate tests.
- `docs/deployment.md`: remove remaining references to the deleted files.
- `AGENTS.md` / `CLAUDE.md`: nothing on the host reads `~/avalon` anymore, so
  retire the "recovery checkout" framing — `~/avalon` is now an ordinary
  development clone. Drop or sharply trim the worktree ceremony and the
  `git clean -fd` warning; keep the one-line note that `gh pr merge
  --delete-branch` can fail to switch branches when `main` is checked out
  elsewhere, if worktrees remain in use.
- Merging this PR **is** the end-to-end test of the new pipeline: watch it
  arrive via listener → bootstrap → target controller, and confirm
  `/api/health` reports the PR 2 merge sha.

## Risks and edge cases the implementer should hold onto

- **Order of trust**: checksum verification precedes any execution of
  downloaded bytes; the trust root (the GitHub release) is unchanged from the
  current design.
- **Exit-code contract**: 75 means "busy, retry later" at every layer —
  gate → controller → bootstrap → unit `SuccessExitStatus`. Breaking it turns
  a mid-game refusal into a red failure.
- **A commit with broken deploy code** deploys itself fine (old controller or
  bootstrap runs the *previous* logic to install it) but strands *subsequent*
  deploys until a fix commit lands. CI's controller/bootstrap tests are the
  guard; the server keeps running regardless.
- **First-install ordering on a fresh host**: `install-bootstrap.sh`, enable
  the timer, let `deploy-main` create the first release and `current`, then
  enable `avalon` and `avalon-listen` (the listener's WorkingDirectory needs
  `current` to exist). Worth one paragraph in `docs/deployment.md`.
- **GitHub API rate limit** (60/hour unauthenticated per IP) is fine at
  hourly-plus-triggers cadence; `AVALON_MAIN_URL` remains the test/override
  hook.
- `release.json` / `deployerSchema` stays 1. Bump it only if the
  bootstrap↔release contract itself changes (e.g. controller CLI renamed), so
  an old bootstrap refuses a release it cannot drive — that check lives in
  `verify-release.mjs` today and comes along free.
  