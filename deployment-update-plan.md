# Final Implementation Plan: Simplified Updater with Stable Release Pointer

## Objective

Replace the current candidate-controlled deployment stack with a single, statically installed host updater driven by a stable GitHub Release asset:

```text
latest.json → immutable avalon-<commit>.tar.gz
```

The pointer will contain the archive’s SHA-256 digest, eliminating the standalone `.sha256` file.

The finished system must preserve:

- Immediate deployment attempts after pushes to `main`.
- Active-game continuity for API- and state-compatible releases.
- Deferral of breaking releases until active games finish.
- Immutable commit-addressed releases.
- Atomic activation.
- Snapshot-aware rollback.
- Exact-commit health verification.
- Server-before-GitHub-Pages ordering.
- An untrusted wake-up channel that cannot select arbitrary code.
- Both self-hosted and public Pages-client deployment modes.

---

# 1. Target Architecture

## GitHub Actions

```text
push to main
  → package immutable archive
  → extract and test the exact archive
  → upload avalon-<sha>.tar.gz
  → replace latest.json as the publication commit point
  → send exact “deploy” ntfy message
  → poll public /api/health until commit == GITHUB_SHA
  → publish GitHub Pages client
```

## Host

```text
ntfy “deploy”
  → avalon-listen.service
  → avalon-update.service
  → static updater fetches latest.json
  → downloads immutable archive
  → verifies built-in SHA-256
  → verifies embedded release.json
  → checks API/state compatibility
  → activates or defers
  → verifies local health
  → rolls back on failure
```

## Host Files

```text
~/.local/libexec/avalon-deploy/
├── updater.sh
├── verify-pointer.mjs       # optional; see implementation guidance
└── listen.mjs

~/.config/systemd/user/
├── avalon.service
├── avalon-listen.service
├── avalon-update.service
└── avalon-update.timer

~/.local/lib/avalon/
├── current -> releases/<sha>
├── releases/
│   ├── <old-sha>/
│   └── <new-sha>/
└── rollback/

~/.local/state/avalon/
├── rooms.json
└── avatars/
```

---

# 2. Stable Pointer Contract

## Asset URL

Use the existing fixed GitHub Release tag:

```text
deployment-artifacts
```

The stable pointer URL is:

```text
https://github.com/<owner>/<repo>/releases/download/deployment-artifacts/latest.json
```

The immutable archive URL is derived from its commit:

```text
https://github.com/<owner>/<repo>/releases/download/deployment-artifacts/avalon-<sha>.tar.gz
```

The repository already publishes commit-addressed assets under the fixed `deployment-artifacts` release, so this extends the current artifact contract rather than introducing another storage mechanism. .github/workflows/deploy.yml:87-113

## `latest.json` Schema

Use the smallest practical contract:

```json
{
  "schema": 1,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Do **not** include an arbitrary archive URL or filename. The updater derives it as:

```text
avalon-${commit}.tar.gz
```

This prevents the pointer from redirecting the updater to:

- Another host.
- A path outside the release root.
- An unexpected GitHub asset.
- A shell-sensitive filename.

## Validation Rules

The host must reject the pointer unless:

- It is a JSON object.
- `schema === 1`.
- `commit` matches `^[0-9a-f]{40}$`.
- `sha256` matches `^[0-9a-f]{64}$`.
- No coercion is used for these values.

After extraction, also require:

```text
release.json.commit == latest.json.commit
```

and validate:

- `release.json.stateVersion` is a positive integer.
- `release.json.apiProtocol` is a positive integer.
- `release.json.nodeMajor` is the supported Node major.
- Required application files exist.
- The runtime Node major matches the manifest.

The existing release manifest already carries the commit, state version, API protocol, Node major, and deployer schema. docs/deployment.md:136-145

## Cache Handling

Fetch the mutable pointer with:

- `Cache-Control: no-cache`.
- A cache-busting query parameter such as `?t=<unix-time>`.
- Redirect following enabled.
- A bounded timeout and retry count.

Example:

```sh
pointer_url="$artifact_base/latest.json?t=$(date +%s)"
curl -fsSL \
  --retry 3 \
  --connect-timeout 10 \
  --max-time 30 \
  -H 'Cache-Control: no-cache' \
  "$pointer_url"
```

The archive URL remains immutable and does not need cache busting.

---

# 3. Artifact Packaging Changes

## Modify `scripts/package-release.sh`

Change the packager to output only:

```text
avalon-<sha>.tar.gz
```

Remove generation of:

```text
avalon-<sha>.tar.gz.sha256
```

The current implementation computes the digest and writes the standalone checksum at the end of the packaging script. scripts/package-release.sh:24-31

After the change:

```sh
archive="$output/avalon-$commit.tar.gz"
timestamp=$(git -C "$root" show -s --format=%ct "$commit")

tar --sort=name \
  --mtime="@$timestamp" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -C "$stage" \
  -cf - "avalon-$commit" |
  gzip -n >"$archive"

printf '%s\n' "$archive"
```

The publishing workflow—not the packager—will calculate the digest used in `latest.json`.

## Why the Workflow Owns the Pointer

The pointer is deployment metadata, not application-release content.

Generating it in the publishing job ensures:

- It describes the exact artifact downloaded from the CI artifact store.
- The digest is recomputed immediately before release publication.
- The pointer is not taken from code inside the candidate archive.
- Replacing it is clearly the deployment publication commit point.

---

# 4. GitHub Actions Changes

Modify `.github/workflows/deploy.yml`.

The workflow currently packages the release, invokes the candidate controller, uploads both archive and checksum, publishes them, sends a commit-bearing ntfy message, parses return messages, and finally deploys Pages. .github/workflows/deploy.yml:20-176

## 4.1 Test Job

### Package the archive

Keep:

```yaml
- name: Package the immutable release
  run: scripts/package-release.sh "$GITHUB_SHA" dist
```

### Test the exact archive

Replace the candidate-controller preparation step with:

1. Extract `dist/avalon-$GITHUB_SHA.tar.gz` under `$RUNNER_TEMP`.
2. Validate `release.json`.
3. Run the full suite from the extracted tree.

Conceptual workflow step:

```yaml
- name: Test the exact packaged release
  run: |
    set -eu

    archive="dist/avalon-$GITHUB_SHA.tar.gz"
    tree="$RUNNER_TEMP/release-tree"

    mkdir "$tree"
    tar -xzf "$archive" --strip-components=1 -C "$tree"

    node scripts/verify-packaged-release.mjs "$tree" "$GITHUB_SHA"

    (
      cd "$tree"
      node --test "test/**/*.test.js"
    )
```

The verifier used here must come from the checked-out trusted workflow revision, not be executed from inside the candidate archive.

### Upload only the archive

Change the workflow artifact configuration to:

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: avalon-${{ github.sha }}
    path: dist/avalon-${{ github.sha }}.tar.gz
    if-no-files-found: error
    retention-days: 1
```

Remove the `.sha256` path.

## 4.2 Publish Job

The publish job must:

1. Download the exact tested archive.
2. Compute its SHA-256.
3. Verify the workflow SHA is still the default branch’s current SHA.
4. Upload the immutable archive.
5. Generate `latest.json`.
6. Replace `latest.json` **last**.

### Final default-branch check

Before publication, query GitHub through `gh api`:

```sh
main_sha=$(
  gh api "repos/$GH_REPO/commits/main" --jq '.sha'
)

if [ "$main_sha" != "$GITHUB_SHA" ]; then
  echo "superseded by $main_sha; not publishing $GITHUB_SHA"
  exit 0
fi
```

This prevents a superseded workflow from moving the pointer backward after a newer push reaches `main`.

This check moves branch authority into CI. The host no longer needs `AVALON_MAIN_URL`.

### Pointer generation

```sh
archive="avalon-$GITHUB_SHA.tar.gz"
digest=$(sha256sum "dist/$archive" | sed 's/[[:space:]].*//')

node -e '
  const fs = require("node:fs");
  const [commit, sha256, output] = process.argv.slice(1);

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("invalid commit");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("invalid sha256");
  }

  fs.writeFileSync(output, `${JSON.stringify({
    schema: 1,
    commit,
    sha256,
  }, null, 2)}\n`);
' "$GITHUB_SHA" "$digest" dist/latest.json
```

### Publication order

```sh
# Immutable payload first.
gh release upload "$release_tag" "dist/$archive" --clobber

# Mutable pointer last.
gh release upload "$release_tag" dist/latest.json --clobber
```

`latest.json` is the publication commit point. The updater must never observe a pointer whose archive has not already been uploaded.

### Release creation

Continue creating the fixed release if it is absent, with:

```text
--latest=false
```

This prevents deployment assets from becoming a user-facing product release.

## 4.3 Server Deployment Job

Simplify the trigger to:

```sh
curl -fsS \
  --max-time 10 \
  -d deploy \
  "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null
```

Remove:

- The SHA from the ntfy body.
- ntfy result polling.
- `busy <sha>` parsing.
- `failed <sha>` parsing.
- Result-message correlation.

Keep:

- Polling `$API_BASE/api/health`.
- Success only when `.commit == $GITHUB_SHA`.
- Re-sending `deploy` every five minutes.
- The existing timeout.
- Failure if the public server never reports the target commit.

CI’s success proof remains the application itself, not the notification channel.

## 4.4 Pages Job

Preserve:

```yaml
needs: deploy-server
```

Keep:

- `API_BASE` generation.
- Frontend SHA stamping.
- Pages publication only after the server reports the exact commit.

This ordering is necessary because the Pages client and server negotiate through `API_PROTOCOL`. The public client currently checks the protocol before opening a lobby. docs/api.md:65-73

---

# 5. Static Host Updater

## Add `deploy/updater.sh`

This becomes the only deployment transaction implementation.

It must be installed outside release directories:

```text
~/.local/libexec/avalon-deploy/updater.sh
```

Application releases must not update or execute it automatically.

## Supported Interface

```text
updater.sh reconcile
updater.sh reconcile --force
```

`--force` must be an explicit operator-only argument. Do not accept force behavior from:

- `latest.json`.
- ntfy.
- Candidate environment variables.
- Release metadata.

## Configuration

Support:

```sh
AVALON_RELEASE_ROOT
AVALON_ARTIFACT_BASE
AVALON_NODE
AVALON_SYSTEMCTL
AVALON_STATE_FILE
AVALON_HEALTH_TIMEOUT_SECONDS
AVALON_KEEP_RELEASES
PORT
```

Default artifact base:

```text
https://github.com/shengjiex98/avalon/releases/download/deployment-artifacts
```

Remove:

```text
AVALON_MAIN_URL
TARGET_STATE_VERSION
```

Load host-specific values from:

```text
~/.config/avalon.env
```

Use an explicit internal environment and never source anything from the candidate release.

---

# 6. Updater Transaction

Implement the updater in this exact order.

## 6.1 Initialize Safely

- `set -eu`.
- `umask 077`.
- Establish `XDG_RUNTIME_DIR` when absent.
- Validate command-line arguments.
- Validate required tools.
- Create the release root.
- Acquire a nonblocking `flock`.

If another reconciliation is in progress:

```text
log and exit 0
```

## 6.2 Fetch and Validate `latest.json`

1. Create a private temporary download directory.
2. Fetch the stable pointer with cache busting.
3. Parse it using trusted installed code.
4. Validate `schema`, `commit`, and `sha256`.
5. Derive:

```sh
archive="avalon-$commit.tar.gz"
```

Do not evaluate JSON using shell `eval`.

### Pointer parser implementation

Prefer a small installed Node helper:

```text
deploy/verify-pointer.mjs
```

Interface:

```bash
node verify-pointer.mjs latest.json
```

Output:

```text
<commit>
<sha256>
```

It must:

- Reject malformed JSON.
- Reject additional incompatible schema versions.
- Reject non-string commit or digest values.
- Output only validated values.
- Exit nonzero with a concise error.

The installer must install this helper alongside `updater.sh`, ensuring it is not sourced from the candidate release.

## 6.3 No-op Detection

Fetch:

```text
http://127.0.0.1:$PORT/api/health
```

If:

```text
health.commit == latest.commit
```

and:

```text
current -> releases/<commit>
```

then exit successfully without downloading or restarting.

## 6.4 Prepare or Reuse the Release

If `releases/<commit>` already exists:

- Validate its `release.json`.
- Validate required files.
- Require the manifest commit to match.
- Reuse it without downloading.

Otherwise:

1. Download `avalon-<commit>.tar.gz`.
2. Calculate SHA-256 locally.
3. Compare it with `latest.json.sha256`.
4. Reject before extraction if it differs.
5. Create `releases/.staging-<commit>.*`.
6. Extract with `--strip-components=1`.
7. Verify the embedded manifest.
8. Verify required files:
   - `package.json`
   - `src/server.js`
   - `public/index.html`
9. Verify the installed Node major.
10. Make the staging tree recursively read-only.
11. Atomically rename it to `releases/<commit>`.

Never execute:

- `deploy/*` from the candidate.
- `npm` lifecycle scripts.
- Shell code from the archive.
- Candidate-provided verifiers.

## 6.5 Tar Extraction Safety

Before or during extraction, reject archives containing:

- Absolute paths.
- `..` path traversal components.
- Symlinks escaping the release tree.
- Hard links escaping the release tree.
- Multiple unexpected top-level roots.

Add adversarial archive fixtures to the updater tests.

---

# 7. API and State Compatibility Gate

## Compatibility Tuple

Use:

```text
(stateVersion, apiProtocol)
```

The running server exposes:

```text
health.stateVersion
health.protocol
```

The target release manifest exposes:

```text
release.stateVersion
release.apiProtocol
```

A live-game restart is compatible only when both are known and equal.

## Decision Table

| Condition | Result |
| --- | --- |
| Target already serving | No-op |
| Server unreachable | Deploy; nothing is running to protect |
| No active games | Deploy |
| Active games and both versions equal | Deploy |
| Active games and state version differs | Exit 75 |
| Active games and API protocol differs | Exit 75 |
| Active games and either version is unknown | Exit 75 |
| Health response is malformed | Fail closed |
| Explicit interactive `--force` | Deploy after warning |

## Reuse Existing Update Endpoint

Do not initially redesign `/api/health/update`.

Algorithm:

1. Fetch `/api/health`.
2. If both versions match, proceed.
3. Otherwise call `/api/health/update`.
4. Treat `409` as exit 75.
5. Treat `200` as safe.
6. Treat an unreachable server as safe only if the ordinary health request also proved it was unavailable.
7. Treat unexpected responses as errors, not permission to proceed.

The current gate treats equal state versions as restart-compatible and uses `/api/health/update` for live-game protection. deploy/gate.sh:33-52

The simplified updater extends that fast path to require API compatibility as well.

---

# 8. Activation and Rollback

## Activation Order

After the release has been prepared and the compatibility gate allows deployment:

1. Determine and validate the current rollback release.
2. Stop `avalon.service`.
3. Back up the state snapshot.
4. Record whether no snapshot existed.
5. Atomically replace `current`.
6. Start `avalon.service`.
7. Poll local `/api/health`.
8. Require `.commit == target`.
9. Declare success only after exact-commit health passes.

## Snapshot Backup

Use:

```text
~/.local/lib/avalon/rollback/<target-sha>/
├── rooms.json
```

or:

```text
no-snapshot
```

The snapshot must be copied only after stopping the old process so its final write is complete.

Avatar files do not need transactional copying because they are content-addressed and referenced by snapshots; leave them in the persistent state directory.

## Rollback

If the new release fails to become healthy:

1. Stop the failed service.
2. Restore the old `current` symlink.
3. Restore `rooms.json`, or restore the absence of a snapshot.
4. Start the old service.
5. Require `/api/health.commit == rollbackCommit`.
6. Exit nonzero.
7. Log a critical error if rollback itself does not become healthy.

The current deployment controller already restores the release pointer and snapshot on target health failure. docs/deployment.md:184-193

## Pruning

Only after successful target health verification:

- Keep the current release.
- Keep the immediate rollback release.
- Keep a configurable number of additional recent releases, defaulting to two.
- Remove stale staging directories.
- Remove rollback backups whose target releases were pruned.

Never prune before successful activation.

---

# 9. Listener Simplification

## Modify `deploy/listen.mjs`

Change:

```js
const TRIGGER = /^deploy ([0-9a-f]{40})$/;
```

to:

```js
const TRIGGER = /^deploy$/;
```

The current listener extracts a SHA and starts a commit-specific systemd unit. deploy/listen.mjs:22-37

Replace that with:

```js
spawn('systemctl', ['--user', 'start', 'avalon-update.service'])
```

Required behavior:

- Accept only the exact body `deploy`.
- Ignore `deploy <sha>`.
- Ignore whitespace variants unless intentionally normalized.
- Ignore arbitrary messages.
- Never log the topic.
- Coalesce triggers while an update is running.
- Exit on stream failure so systemd reconnects.
- Use `since=1m` to tolerate listener restarts.

The message carries no deployment authority.

---

# 10. Static systemd Units

## `avalon.service`

Make it permanently installed rather than release-owned.

Retain:

```ini
WorkingDirectory=%h/.local/lib/avalon/current
ExecStart=%h/.local/bin/node --preserve-symlinks-main %h/.local/lib/avalon/current/src/server.js
Restart=on-failure
StateDirectory=avalon
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true
```

These existing directives already isolate the application and keep writable state in the managed state directory. deploy/avalon.service:19-38

## `avalon-update.service`

Use:

```ini
[Service]
Type=oneshot
EnvironmentFile=-%h/.config/avalon.env
ExecStart=%h/.local/libexec/avalon-deploy/updater.sh reconcile
SuccessExitStatus=75
```

## `avalon-update.timer`

Retain:

- `OnBootSec=5min`.
- `OnUnitActiveSec=1h`.
- `Persistent=true`.

This remains the recovery path when ntfy notifications are missed.

## `avalon-listen.service`

Change it to run:

```text
~/.local/libexec/avalon-deploy/listen.mjs
```

rather than the selected release’s copy.

## Remove Eventually

```text
avalon-update@.service
```

Do not remove it until the migration sequence has moved the host away from the old commit-specific listener.

---

# 11. Static Installer

## Add `deploy/install-updater.sh`

Install atomically:

```text
deploy/updater.sh
    → ~/.local/libexec/avalon-deploy/updater.sh

deploy/verify-pointer.mjs
    → ~/.local/libexec/avalon-deploy/verify-pointer.mjs

deploy/listen.mjs
    → ~/.local/libexec/avalon-deploy/listen.mjs

static systemd units
    → ~/.config/systemd/user/
```

Requirements:

- Idempotent.
- Temporary file plus rename for every installed file.
- Correct executable and read-only modes.
- Never overwrite `~/.config/avalon.env`.
- Never trigger a deployment automatically.
- Print follow-up commands.

The current installer already uses adjacent temporary files and atomic renames; preserve that behavior. deploy/install-bootstrap.sh:19-34

---

# 12. Migration Strategy

The migration must avoid a bootstrap deadlock.

The installed legacy bootstrap currently requires:

- A commit-specific archive.
- A standalone `.sha256` file.
- `deploy/controller.sh` inside the candidate archive.

Therefore, removing those in the first commit would prevent the old host from installing the replacement.

Use three PRs plus one explicit host operation.

---

## PR 1: Add the New Static Path Without Changing Production Behavior

### Add

```text
deploy/updater.sh
deploy/verify-pointer.mjs
deploy/install-updater.sh
deploy/static/avalon.service
deploy/static/avalon-listen.service
deploy/static/avalon-update.service
deploy/static/avalon-update.timer
test/updater.test.js
test/pointer.test.js
```

### Preserve unchanged

```text
deploy/bootstrap.sh
deploy/controller.sh
deploy/gate.sh
deploy/lib.sh
deploy/avalon-update@.service
existing workflow trigger
standalone .sha256 generation
```

### Listener compatibility

The static listener installed by PR 1 may accept both during migration:

```text
deploy
deploy <40-hex-sha>
```

Both forms must start the same generic `avalon-update.service`; the SHA must be discarded.

The final listener will accept only `deploy`.

### Important constraint

Do not replace the existing release-owned unit files in PR 1. The old controller still copies those files during its deployment.

Place the future static units under `deploy/static/` and have `install-updater.sh` install them.

### PR 1 acceptance

- Existing deployment path still passes.
- New updater tests pass.
- New installer works against a temporary fake home.
- No production workflow behavior changes yet.

---

## Operational Gate: Install the Static Updater

After PR 1 deploys through the legacy path, a human runs on the personal host:

```bash
~/avalon/deploy/install-updater.sh
systemctl --user daemon-reload
systemctl --user enable --now avalon-update.timer avalon-listen
```

Verify:

```bash
systemctl --user status avalon
systemctl --user status avalon-listen
systemctl --user status avalon-update.timer
readlink ~/.local/lib/avalon/current
curl -s localhost:8420/api/health | jq
curl -s "$API_BASE/api/health" | jq
```

Do not merge PR 2 until this gate is confirmed.

---

## PR 2: Cut Over Artifact Publication and Deployment

### Change

- Stop producing `.sha256`.
- Generate and publish `latest.json`.
- Upload archive first and pointer last.
- Send `deploy`.
- Remove ntfy return-status polling.
- Test the extracted artifact directly.
- Make the non-`static/` unit definitions match the installed static units.
- Change `listen.mjs` to accept only `deploy`.
- Update release and workflow tests.

### Retain temporarily

```text
deploy/bootstrap.sh
deploy/controller.sh
deploy/gate.sh
deploy/lib.sh
deploy/avalon-update@.service
deploy/install-bootstrap.sh
```

They are now unused but provide emergency compatibility until the new path has completed at least one successful deployment.

### PR 2 production acceptance

Test both:

1. A compatible deployment during an active disposable game.
2. An API- or state-incompatible deployment that exits 75, leaves the game running, and deploys after the game ends.

---

## PR 3: Remove the Legacy Stack

After at least one verified production deployment through `latest.json`, remove:

```text
deploy/bootstrap.sh
deploy/controller.sh
deploy/gate.sh
deploy/lib.sh
deploy/verify-release.mjs
deploy/wait-for-health.mjs       # if folded into updater
deploy/avalon-update@.service
deploy/install-bootstrap.sh
deploy/static/                   # promote static units to deploy/
test/bootstrap.test.js
test/controller.test.js
```

Before deleting legacy tests, migrate all still-relevant behavioral coverage into updater, listener, workflow, and release tests.

---

# 13. Test Plan

## Pointer Tests

Add tests for:

- Valid schema.
- Invalid schema.
- Invalid JSON.
- Missing fields.
- Non-string fields.
- Invalid commit.
- Invalid SHA-256.
- Additional irrelevant fields.
- Parser emits only validated values.
- Archive name is derived rather than accepted from JSON.

## Packaging Tests

Update `test/release.test.js` to verify:

- Deterministic archive.
- Embedded manifest commit.
- State version.
- API protocol.
- Required Node major.
- No standalone `.sha256` output.
- Archive digest can be reproduced with `sha256sum`.

## Workflow Tests

Update `test/deploy.test.js` to assert:

- The exact archive is extracted and tested.
- Only the archive is uploaded as the workflow artifact.
- The publisher recomputes SHA-256.
- `latest.json` contains `schema`, `commit`, and `sha256`.
- The immutable archive uploads before `latest.json`.
- The final `main` check precedes pointer replacement.
- The ntfy body is exactly `deploy`.
- CI does not parse ntfy result messages.
- CI proves deployment through `/api/health.commit`.
- Pages still depends on the server job.

## Updater Tests

Cover:

1. Valid pointer and matching archive.
2. Pointer download failure.
3. Pointer cache-busting request.
4. Malformed pointer.
5. Missing archive.
6. Digest mismatch.
7. Manifest commit mismatch.
8. Unsupported Node version.
9. Missing required file.
10. Unsafe tar path.
11. Escaping symlink.
12. Existing valid release reuse.
13. Existing invalid release rejection.
14. Exact target already running.
15. Compatible active-game deployment.
16. State-incompatible active-game deferral.
17. API-incompatible active-game deferral.
18. Both-incompatible idle deployment.
19. Unknown compatibility with active game.
20. Server unavailable recovery.
21. Lock contention.
22. Gate-before-stop ordering.
23. Snapshot created only after stop.
24. Atomic pointer switch.
25. Exact target health success.
26. Target health failure.
27. Code and snapshot rollback.
28. Rollback health failure.
29. Pruning only after success.
30. Explicit operator force.
31. Candidate scripts never execute.

## Listener Tests

Cover:

- Exact `deploy`.
- Rejection of `deploy <sha>` after migration.
- Rejection of arbitrary bodies.
- Coalescing while running.
- Topic secrecy.
- Restart behavior after stream failure.

## Application Tests

Retain and extend:

- Health reports commit, protocol, state version, and active games.
- Lobby does not block update.
- Active game blocks an incompatible update.
- Finished-game grace period remains.
- Browser reconnects after compatible restart.
- Protocol mismatch produces a clear browser error.

The server already exposes the health values needed by the updater, and its current update endpoint is covered for lobby, active-game, and result-screen behavior. src/server.js:114-125test/server.test.js:81-116

---

# 14. Documentation Changes

Update:

```text
AGENTS.md
docs/deployment.md
docs/architecture.md
docs/testing.md
README.md, if it references bootstrap installation
```

Document:

- Stable `latest.json` URL.
- Pointer schema.
- Embedded SHA-256 verification.
- Absence of standalone checksum assets.
- Static updater installation.
- Manual updater upgrades.
- Immutable release layout.
- API/state compatibility tuple.
- Active-game deferral behavior.
- Snapshot rollback.
- Exact-commit health proof.
- Wake-only ntfy semantics.
- Hourly reconciliation.
- Server-before-Pages ordering.
- Tailscale Funnel security boundary.
- Three-stage migration.

Remove references to:

- Host-side resolution of `main`.
- Candidate-owned controller.
- Second artifact download.
- Host-side full test suite.
- Release-owned systemd units.
- Commit-specific update services.
- `deployed`, `busy`, and `failed` ntfy responses.
- Standalone `.sha256` files.

---

# 15. Security Requirements

## Deployment authority

After migration, authority resides in:

```text
latest.json on the fixed deployment-artifacts release
```

Protect it by ensuring:

- Only the default-branch publishing job has `contents: write`.
- Pull-request jobs never publish.
- The publishing job confirms `main == GITHUB_SHA`.
- The pointer is written after the immutable archive.
- The host does not accept a target from ntfy.
- The host does not accept arbitrary archive URLs.

## Funnel exposure

Expose only the Avalon application through Tailscale Funnel.

Do not add public endpoints for:

- Deployment.
- Restart.
- systemd.
- Shell execution.
- Updater status requiring host privileges.

The update listener and GitHub downloads remain outbound host connections.

## Host privileges

- Run Avalon as an unprivileged user.
- Keep the application service unable to modify release or updater files.
- Keep host secrets outside releases.
- Preserve existing systemd filesystem hardening.
- Give the updater write access only to the release root, state rollback location, and installed control-plane paths needed during manual installation.

---

# 16. Required Verification Commands

Run throughout implementation:

```bash
npm test
```

Focused development checks:

```bash
node --test test/pointer.test.js
node --test test/updater.test.js
node --test test/deploy.test.js
node --test test/release.test.js
node --test test/server.test.js
node --test test/ui-reconnect.test.js
```

Shell syntax:

```bash
sh -n deploy/updater.sh
sh -n deploy/install-updater.sh
```

Optional advisory lint:

```bash
shellcheck deploy/updater.sh deploy/install-updater.sh
```

Package verification:

```bash
rm -rf dist
scripts/package-release.sh HEAD dist
find dist -maxdepth 1 -type f -printf '%f\n'
```

Expected output must contain one archive and no `.sha256` file:

```text
avalon-<sha>.tar.gz
```

Manual pointer simulation:

```bash
sha=$(git rev-parse HEAD)
digest=$(sha256sum "dist/avalon-$sha.tar.gz" | cut -d' ' -f1)

printf '%s\n' \
  "{\"schema\":1,\"commit\":\"$sha\",\"sha256\":\"$digest\"}" \
  >dist/latest.json
```

Installer isolation test:

```bash
home=$(mktemp -d)
HOME="$home" deploy/install-updater.sh
find "$home" -type f -o -type l
```

---

# 17. Final Acceptance Criteria

## Fast development loop

- Every push to `main` packages and tests immediately.
- The immutable archive publishes before the stable pointer changes.
- The pointer change wakes the personal host immediately.
- The host deploys compatible updates without waiting for the hourly timer.
- CI confirms the public Funnel endpoint serves the target commit.

## Active-game continuity

- Active games survive updates when both `stateVersion` and `apiProtocol` match.
- Timers restore.
- Existing browser sessions reconnect.
- A state-version change waits.
- An API-protocol change waits.
- The deferred deployment completes after the game becomes safe.

## Artifact integrity

- No standalone `.sha256` file is produced or published.
- `latest.json.sha256` verifies the immutable archive.
- The archive’s embedded manifest commit matches the pointer commit.
- Candidate deployment code is never executed.
- A mismatched pointer, digest, or manifest cannot change `current`.

## Rollback

- A failed target never remains selected.
- The previous release pointer is restored.
- The previous room snapshot is restored.
- The rollback commit is health-verified.
- Pages is not published for a failed server deployment.

## Security

- ntfy is wake-only.
- Funnel exposes no update authority.
- Only the protected default-branch publish job replaces `latest.json`.
- The host derives the archive filename from a validated commit.
- Releases are immutable and read-only.
- Secrets remain outside the repository and releases.

## Simplicity

The final steady-state mechanism consists of:

- One static updater.
- One small pointer verifier.
- One small ntfy listener.
- Four static systemd units.
- One immutable release packager.
- One stable `latest.json` pointer.
- One GitHub Actions workflow.
- One application compatibility gate.

There is no candidate controller, host-side `main` resolution, standalone checksum asset, release-owned systemd control plane, commit-specific update unit, or bidirectional ntfy status protocol.

---

## Repository Inspection

- ✅ `nl -ba .github/workflows/deploy.yml | sed -n '1,215p'`
- ✅ `nl -ba scripts/package-release.sh | sed -n '1,80p'`
- ✅ `nl -ba deploy/install-bootstrap.sh | sed -n '1,90p'`
- ✅ `nl -ba deploy/listen.mjs | sed -n '1,100p'`
- ✅ `find test -maxdepth 1 -type f -printf '%f\n' | sort | rg '(bootstrap|controller|deploy|release|server|reconnect)'`
- ✅ `git status --short --branch`

No repository files were changed, so no commit or pull request was created.
