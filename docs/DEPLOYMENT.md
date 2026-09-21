# Deployment

## Choosing a mode

| Mode                   | Claude Code detection | Notes                                                                                     |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| Native, as your user   | Automatic             | Preferred. The service can see your Claude installation.                                  |
| Native, system service | No                    | Fine for device + ADS-B only; install the bridge separately.                              |
| Docker                 | No                    | Install the bridge on the host with `GCA_BRIDGE_TOKEN`; needs routing to the display LAN. |

Claude Code runs as _you_. A service running as `root` or a dedicated system user
cannot see your installation — that is not a bug to work around, it is why the bridge
exists.

Running natively as your own user buys one more thing: the module can read usage
straight from `claude -p "/usage"` when the bridge inbox is empty, so a restart shows
numbers immediately instead of waiting for the next status-line render.

## Environment variables

Every value has a working default; an install that only wants loopback access needs
none of them. Module settings live in the database and the UI, never here.

| Variable                           | Default            | Purpose                                                                                                                                     |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GCA_HOST`                         | `127.0.0.1`        | Bind address. Anything other than loopback counts as exposed and requires an administrator password.                                        |
| `GCA_PORT`                         | `3210`             | HTTP port                                                                                                                                   |
| `GCA_DATA_DIR`                     | platform default   | Database, master key, bridge token and device backups                                                                                       |
| `GCA_LOG_LEVEL`                    | `info`             | Pino level                                                                                                                                  |
| `GCA_MASTER_KEY_FILE`              | —                  | Use a mounted secret instead of the generated key file. Required if secrets must survive a container rebuild that discards the data volume. |
| `GCA_BRIDGE_TOKEN`                 | —                  | Pre-shared status-line bridge token, for when the server and the bridge cannot share a data directory (Docker). Minimum 16 characters.      |
| `GCA_BRIDGE_ALLOW_PRIVATE_SOURCES` | `false`            | Accept bridge posts from any private address, not only loopback. Needed when the server is containerised and the port is published.         |
| `GCA_AUTH_REQUIRED`                | follows `GCA_HOST` | Force the browser API's login on or off. Set `false` for a container that binds `0.0.0.0` but publishes its port on the host's loopback.    |
| `GCA_PUBLIC_BASE_URL`              | —                  | External URL when behind a reverse proxy                                                                                                    |
| `GCA_TRUST_PROXY`                  | `false`            | Honour `X-Forwarded-*`                                                                                                                      |

[`.env.example`](../.env.example) is a copy-ready version of this table.

## Native

```bash
pnpm install
pnpm build
pnpm db:migrate     # optional; the server migrates on start
pnpm start
```

Data lives in:

- macOS: `~/Library/Application Support/geekmagic-custom-apps`
- Linux: `$XDG_DATA_HOME/geekmagic-custom-apps` or `~/.local/share/geekmagic-custom-apps`

### macOS (launchd)

Run under your own account so Claude detection works. Save as
`~/Library/LaunchAgents/com.geekmagic.customapps.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.geekmagic.customapps</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/geekmagic-custom-apps/apps/server/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/geekmagic-custom-apps</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GCA_HOST</key><string>127.0.0.1</string>
    <key>GCA_PORT</key><string>3210</string>
    <key>GCA_LOG_LEVEL</key><string>info</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/gca.log</string>
  <key>StandardErrorPath</key><string>/tmp/gca.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.geekmagic.customapps.plist
```

`PATH` must include wherever `claude` lives, or detection will not find it.

### Linux (systemd --user)

`~/.config/systemd/user/geekmagic-custom-apps.service`:

```ini
[Unit]
Description=geekmagic-custom-apps
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/geekmagic-custom-apps
ExecStart=/usr/bin/node %h/geekmagic-custom-apps/apps/server/dist/main.js
Environment=GCA_HOST=127.0.0.1
Environment=GCA_PORT=3210
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now geekmagic-custom-apps
loginctl enable-linger "$USER"   # survive logout
```

For a device-only deployment a system-wide unit is fine; use `DynamicUser=yes` with a
`StateDirectory`, and accept that Claude detection will not work.

## Authentication and the bind address

Binding beyond loopback turns the login on. A fresh install has no password, and there
is **no login or set-password screen in the web UI**, so an exposed server with no
password answers every API call with 401 and cannot be recovered from the browser.

Inside a container the bind address is misleading: a published port cannot reach the
container's own loopback, so it must bind `0.0.0.0` even when `-p 127.0.0.1:3210:3210`
means nothing outside the host can connect. Say so with `GCA_AUTH_REQUIRED=false`.

Set a password from the command line if you do want one:

```bash
curl -X POST http://127.0.0.1:3210/api/v1/auth/password \
  -H 'content-type: application/json' -d '{"password":"at-least-12-characters"}'
```

That route is open only while no password exists; afterwards it needs the current one.

## Docker

```bash
docker compose -f docker/compose.yaml up -d
```

The image builds the UI and server, then flattens the workspace with `pnpm deploy`,
so the runtime carries no symlinks into a workspace root that does not exist there.
It runs as `node`, includes a healthcheck, and uses tini for signal handling.

Requirements:

- **Routing to the displays.** `network_mode: host` is simplest on Linux. On Docker
  Desktop host networking behaves differently — publish `127.0.0.1:3210:3210` instead
  and make sure the display subnet is reachable.
- **A persistent volume** at `/data`.
- **Your own master key** if secrets must survive a volume rebuild:

  ```yaml
  environment:
    GCA_MASTER_KEY_FILE: /run/secrets/gca_master_key
  volumes:
    - ./master.key:/run/secrets/gca_master_key:ro
  ```

  ```bash
  head -c 32 /dev/urandom | base64 > master.key && chmod 600 master.key
  ```

- **The bridge on the host**, not in the container, and pointed at the published port:

  ```bash
  gca-claude-bridge install --port 3210
  ```

The container **must not** mount your home directory to obtain Claude credentials.
Nothing in this project reads them.

Because the container binds `0.0.0.0`, authentication is required. Set the
administrator password on first visit; the bootstrap route is open only until one
exists.

Fonts are bundled with the renderer, so no system font packages are installed and
output is byte-identical to a native run.

## Reverse proxy

```nginx
location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Set `GCA_TRUST_PROXY=true` and `GCA_PUBLIC_BASE_URL`. Keep the app on loopback and let
the proxy terminate TLS.

## Backups

Everything is under the data directory:

| Path                  | Contents                                                          |
| --------------------- | ----------------------------------------------------------------- |
| `app.db`              | Devices, modules, playlists, audit log                            |
| `master.key`          | Decrypts secrets — **without it the database's secrets are lost** |
| `claude-bridge.token` | Bridge shared secret                                              |
| `claude-bridge.json`  | Bridge manifest, including your previous status line              |
| `device-backups/`     | Album contents downloaded from PRO displays                       |

Stop the service before copying `app.db`, or use `sqlite3 app.db ".backup out.db"`.
A migration takes a pre-migration copy automatically.

## Upgrading

```bash
git pull && pnpm install && pnpm build
systemctl --user restart geekmagic-custom-apps
```

Migrations run at startup, in a transaction, after a file copy. Settings migrations
run per module on load and are recorded in the audit log.

## Health and diagnostics

```bash
curl -s http://127.0.0.1:3210/api/v1/health | jq
```

Reports version, uptime, which modules loaded, which were rejected and why, device
count and bridge state. The Diagnostics page generates a shareable report and shows
its full contents before download; hostnames, coordinates and credentials are
excluded.

## Troubleshooting

| Symptom                         | Check                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| Display never updates           | Device page health; unchanged frames are skipped by design |
| `DEVICE_ADDRESS_BLOCKED`        | The address is outside private ranges                      |
| `DEVICE_PROFILE_UNKNOWN`        | Unrecognised firmware; export a probe report               |
| PRO shows an old picture        | Open the Picture app once on the device                    |
| Claude shows _setup required_   | Install the bridge on the host running Claude Code         |
| Secrets fail after a move       | `master.key` did not come with the data directory          |
| Container cannot reach displays | Host networking or subnet routing                          |
