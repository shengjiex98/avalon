Here is the deployment comparison as parallel file trees. `sha-1` is the running version and `sha-2` is the incoming version.

| Previous deployment design | Current deployment design |
|---|---|
| <pre>repository/<br>├── .github/workflows/<br>│   └── deploy.yml<br>├── scripts/<br>│   ├── package-release.sh<br>│   ├── write-release-manifest.mjs<br>│   └── stamp-frontend-version.mjs<br>└── deploy/<br>    ├── bootstrap.sh<br>    ├── controller.sh<br>    ├── gate.sh<br>    ├── lib.sh<br>    ├── listen.mjs<br>    ├── verify-release.mjs<br>    ├── wait-for-health.mjs<br>    ├── install-bootstrap.sh<br>    ├── avalon.service<br>    ├── avalon-listen.service<br>    ├── avalon-update.service<br>    ├── avalon-update@.service<br>    └── avalon-update.timer</pre> | <pre>repository/<br>├── .github/workflows/<br>│   └── deploy.yml<br>├── scripts/<br>│   ├── package-release.sh<br>│   ├── verify-packaged-release.mjs<br>│   ├── write-release-manifest.mjs<br>│   └── stamp-frontend-version.mjs<br>└── deploy/<br>    ├── updater.sh<br>    ├── verify-pointer.mjs<br>    ├── listen.mjs<br>    ├── install-updater.sh<br>    ├── avalon.service<br>    ├── avalon-listen.service<br>    ├── avalon-update.service<br>    └── avalon-update.timer</pre> |

## Published deployment artifacts

| Previous deployment design | Current deployment design |
|---|---|
| <pre>deployment-artifacts release/<br>├── avalon-sha-1.tar.gz<br>├── avalon-sha-1.tar.gz.sha256<br>├── avalon-sha-2.tar.gz<br>└── avalon-sha-2.tar.gz.sha256</pre> | <pre>deployment-artifacts release/<br>├── avalon-sha-1.tar.gz<br>├── avalon-sha-2.tar.gz<br>└── latest.json<br>    ├── schema: 1<br>    ├── commit: sha-2<br>    └── sha256: &lt;digest of sha-2 archive&gt;</pre> |

Previously, the notification selected `sha-2` directly:

```text
ntfy: "deploy sha-2"
              │
              ▼
avalon-update@sha-2.service
```

Now, the pointer selects `sha-2`; ntfy only wakes the updater:

```text
latest.json ──selects──> avalon-sha-2.tar.gz
                              ▲
                              │
ntfy: "deploy" ──wakes──> generic updater
```

## Files inside each immutable release

The application payload is structurally similar in both designs, but the authority of its `deploy/` directory changed.

| Previous `releases/sha-2/` | Current `releases/sha-2/` |
|---|---|
| <pre>sha-2/<br>├── release.json<br>├── package.json<br>├── src/<br>├── public/<br>├── scripts/<br>├── test/<br>└── deploy/<br>    ├── controller.sh       ← executed<br>    ├── gate.sh             ← executed<br>    ├── lib.sh              ← sourced<br>    ├── verify-release.mjs  ← executed<br>    ├── wait-for-health.mjs ← executed<br>    ├── listen.mjs          ← executed<br>    └── *.service/*.timer   ← installed</pre> | <pre>sha-2/<br>├── release.json<br>├── package.json<br>├── src/<br>├── public/<br>├── scripts/<br>├── test/<br>└── deploy/<br>    └── ...                 ← inert repository content<br><br>The installed updater uses only:<br>├── release.json<br>├── package.json<br>├── src/server.js<br>└── public/index.html<br><br>No candidate deployment file is executed<br>or installed.</pre> |

## Installed host control plane

| Previous host | Current host |
|---|---|
| <pre>~/.local/libexec/avalon-deploy/<br>└── bootstrap.sh<br><br>~/.config/systemd/user/<br>├── avalon.service<br>├── avalon-listen.service<br>├── avalon-update.service<br>├── avalon-update@.service<br>└── avalon-update.timer<br><br>Most deployment logic came from:<br>~/.local/lib/avalon/current/deploy/</pre> | <pre>~/.local/libexec/avalon-deploy/<br>├── updater.sh<br>├── verify-pointer.mjs<br>└── listen.mjs<br><br>~/.config/systemd/user/<br>├── avalon.service<br>├── avalon-listen.service<br>├── avalon-update.service<br>└── avalon-update.timer<br><br>All deployment logic is permanently<br>installed outside candidate releases.</pre> |

## Application releases and rollback state

These paths exist in both designs:

| Previous deployment design | Current deployment design |
|---|---|
| <pre>~/.local/lib/avalon/<br>├── current ──> releases/sha-1<br>├── releases/<br>│   ├── sha-1/<br>│   └── sha-2/<br>└── rollback/<br>    └── sha-2/<br>        ├── rooms.json<br>        └── no-snapshot<br><br>~/.local/state/avalon/<br>└── rooms.json<br><br>~/.config/<br>└── avalon.env</pre> | <pre>~/.local/lib/avalon/<br>├── current ──> releases/sha-1<br>├── releases/<br>│   ├── sha-1/<br>│   └── sha-2/<br>└── rollback/<br>    └── sha-2/<br>        ├── rooms.json<br>        ├── had-snapshot<br>        └── no-snapshot<br><br>~/.local/state/avalon/<br>└── rooms.json<br><br>~/.config/<br>└── avalon.env</pre> |

After a successful deployment, both designs move the pointer:

```text
Before: current ──> releases/sha-1
After:  current ──> releases/sha-2
```

The crucial difference is who performs that move:

```text
Previous
sha-2/deploy/controller.sh
    └── controls installation, restart, selection, and rollback

Current
~/.local/libexec/avalon-deploy/updater.sh
    └── controls installation, restart, selection, and rollback
```

The current design therefore keeps the target release and the deployment authority on opposite sides of the trust boundary.
