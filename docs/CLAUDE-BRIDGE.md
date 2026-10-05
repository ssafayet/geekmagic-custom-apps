# The Claude Code status-line bridge

Claude Code can pipe a JSON status-line payload to a command on every render. The
bridge receives that payload, keeps only the approved fields, and forwards them to
this server on loopback.

There is deliberately no code path that reads Claude Code's credentials or calls the
private endpoint behind `/usage`.

## The bridge is not the only local source

`claude -p "/usage"` answers locally: it reports `num_turns: 0` and
`total_cost_usd: 0`, so it is not a model call and costs no tokens. Its side effect is
what the server uses — the CLI refreshes `cachedUsageUtilization` in `~/.claude.json`,
which holds the same two windows as structured JSON.

The module reads that as a **fallback**, whenever the bridge inbox is empty:

| Source                        | Costs | Fresh after a server restart   | Works from a container       |
| ----------------------------- | ----- | ------------------------------ | ---------------------------- |
| Bridge (status line)          | Free  | No — waits for the next render | Yes, bridge runs on the host |
| `claude -p "/usage"` fallback | Free  | Yes                            | No — needs the CLI locally   |
| `pnpm bridge:push`            | Free  | Yes                            | Yes — reads the CLI, posts   |

The bridge stays the primary source: it needs no process spawn and no extra network
call. The fallback exists because the inbox is in memory, so a restart empties it, and
because someone may never install the bridge at all.

`push` is the two combined, and it exists because the first two rows have a gap between
them. The status line only fires in clients that render one — a terminal session does,
the VS Code extension does not — and the fallback cannot run inside a container. Where
both are true the module has no source at all. `push` reads the same CLI cache the
fallback reads, on the host where it is readable, and posts it to the same endpoint the
bridge posts to. See [Pushing usage on a timer](#pushing-usage-on-a-timer).

`cachedUsageUtilization` is internal to Claude Code — its sibling keys are codenames —
so it is not a stable contract. Every parse failure yields "no reading", never an
error, and the spawn is limited to one per five minutes.

## Install

Build first — the status line runs the compiled bridge — then install from the
checkout:

```bash
pnpm build
pnpm bridge:install
```

Every bridge command is a script in the root `package.json`, and each reads `.env`
from the checkout like `pnpm start` does:

| Command                 | Does                                               |
| ----------------------- | -------------------------------------------------- |
| `pnpm bridge:install`   | Add the bridge to `~/.claude/settings.json`        |
| `pnpm bridge:doctor`    | Explain why usage is not arriving                  |
| `pnpm bridge:status`    | Print install state as JSON; exit 0 when installed |
| `pnpm bridge:push`      | Read usage from the local CLI and post it now      |
| `pnpm bridge:uninstall` | Restore the previous status line                   |
| `pnpm bridge --help`    | Every command and flag                             |

Flags go straight after the script: `pnpm bridge:install --port 3211`. Install takes
`--data-dir`, `--settings`, `--port`, `--endpoint` and `--token`.

The command written into Claude Code's settings is
`node <checkout>/tools/claude-statusline-bridge/dist/cli.js run --config …`, an
absolute path to the build. Claude Code runs it from whatever project is open, so it
must not depend on anything resolving from the current directory. Moving or deleting
the checkout breaks it; re-run `pnpm bridge:install` from the new location.

The web UI's **Install status-line bridge** action does the same thing in one click.
The command line exists because in Docker the server runs in a container while Claude
Code runs on the host, so the bridge has to be installable there.

Install is idempotent: running it again rewrites the same status line, reuses the
existing token, and will not chain the bridge to its own previous invocation, so it
is safe to put in a provisioning script.

It finishes by asking the server whether it accepts the token, because installing
successfully says nothing about whether usage will actually arrive.

### When nothing arrives

```bash
pnpm bridge:doctor
```

`run` cannot report anything — it swallows every failure so a broken bridge is never
the reason a Claude Code session shows an error. `doctor` is where the diagnosis
lives. It names the actual fault:

| Output                          | Cause                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `the server rejects this token` | The bridge and the server hold different secrets. Put the same `GCA_BRIDGE_TOKEN` in `.env` and reinstall.  |
| `refuses this source address`   | A published container port arrives through NAT. Set `GCA_BRIDGE_ALLOW_PRIVATE_SOURCES=true` (compose does). |
| `Cannot reach`                  | Server down, or the wrong port in `--port` / `--endpoint`.                                                  |
| `No payload has arrived yet`    | Everything is wired up; Claude Code has not rendered since.                                                 |

If that last row never changes, the client you use is not rendering a status line at
all — the VS Code extension does not — and no amount of reinstalling will help, because
nothing about the bridge is broken. Use `push` instead.

### Same machine as the server

The server and the bridge both derive the token from the data directory, so they
agree without being told anything. `pnpm bridge:install` once is the whole setup.
`pnpm bridge:status` exits 0 when installed, which suits a health check.

### Pushing usage on a timer

```bash
pnpm bridge:push                           # one shot
pnpm bridge:push --watch                   # stay resident, every 60s
pnpm bridge:push --watch --interval 120
```

`push` reads usage with the same code path as the CLI fallback and posts it as a
status-line payload, so the server keeps one parser and cannot tell the difference. It
reads the same token file as `install`, so on a single machine there is nothing to
configure. `--token` (or `GCA_BRIDGE_TOKEN`) saves a token to that file first, and
`--token-file` reads another one instead.

One-shot exits non-zero on failure and names the cause, so it suits `cron` or a launchd
timer. `--watch` keeps going across failures instead, on the assumption the server is
only restarting.

`--watch` holds the event loop open with a referenced timer between pushes. That is
load-bearing: an unreferenced one lets Node exit mid-wait, and under a `KeepAlive`
supervisor the result still pushes — once per respawn — so it looks like it is working
while actually crash-looping and ignoring `--interval`. If the agent's stderr shows
`Detected unsettled top-level await`, that is what is happening.

A launchd agent at `~/Library/LaunchAgents/dev.gca.claude-push.plist` — replace the
node path with the output of `which node`, and the checkout path with yours:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.gca.claude-push</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/geekmagic-smalltv-custom-apps/tools/claude-statusline-bridge/dist/cli.js</string>
    <string>push</string>
    <string>--watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/gca/claude-push.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/gca/claude-push.err</string>
</dict></plist>
```

launchd does not read `.env`. If the server runs in Docker, run `pnpm bridge:push
--token "$GCA_BRIDGE_TOKEN"` once first: the token is saved to the token file the agent
then reads.

```bash
launchctl load ~/Library/LaunchAgents/dev.gca.claude-push.plist
```

Nothing is pushed that the status line would not have sent: two percentages and two
reset timestamps. There is no session id, model, path or cost in a pushed payload,
because none of that exists outside a render.

### Docker

The container cannot see your Claude Code, so the bridge runs on the host, from the
same checkout `compose.yaml` lives in. Two things have to line up.

**The token.** The host bridge cannot read the token file inside the volume, so the
two sides would generate different secrets and every post would be rejected. Decide
one up front and give it to both — `.env` does that, since `docker compose` and the
`pnpm bridge:*` scripts all read it.

**The source address.** The endpoint is loopback-only by default, and Docker's NAT
rewrites the source of a post from the host. `compose.yaml` sets
`GCA_BRIDGE_ALLOW_PRIVATE_SOURCES=true` for that reason; the host-network override
does not need it.

```bash
# 1. One shared secret, in .env next to compose.yaml.
cp .env.example .env
echo "GCA_BRIDGE_TOKEN=$(openssl rand -hex 32)" >> .env

# 2. The container takes it from .env.
docker compose up -d --build

# 3. The host bridge takes it from the same .env.
pnpm install && pnpm build
pnpm bridge:install
```

The token must be at least 16 characters; a shorter one fails at startup rather than
being accepted weakly. Changed it later? Restart the container and re-run step 3.

| Networking                               | `GCA_BRIDGE_ALLOW_PRIVATE_SOURCES` | Verified |
| ---------------------------------------- | ---------------------------------- | -------- |
| Published port (`compose.yaml`, default) | `true`, set by compose             | Yes      |
| `network_mode: host` (Linux override)    | Not needed                         | Yes      |

Keep the port published on `127.0.0.1` unless you want LAN access to the UI. The
allowance widens which source addresses may connect; the bearer token remains the
actual authentication either way, and a wrong token is still rejected.

Note that the CLI fallback does **not** work from a container: `claude` is not
installed there and `~/.claude.json` is not mounted. In Docker the bridge and `push`
are the only local sources, which is the case the pending-snapshot behaviour was
written for.

## What install does

1. Reads `~/.claude/settings.json`, preserving every unrelated key.
2. Writes a timestamped backup beside it.
3. Records the existing `statusLine` value verbatim in a manifest.
4. Writes its own `statusLine`, carrying over the original `padding`.
5. Creates a `0600` token file if one does not exist.

The written command points at a config file, not at the token:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/usr/local/bin/node /opt/gca/bridge.js run --config /data/claude-bridge.json",
    "padding": 0
  }
}
```

**The token is never written into Claude's settings.** It lives in an owner-only file
that the config points at, so sharing or backing up `settings.json` cannot leak it.

## Preserving your status line

If you already have a status line, it keeps working. The bridge runs it with the same
stdin payload and returns its stdout, so what you see does not change.

On uninstall the previous configuration is restored byte-for-byte — but only if the
current configuration still matches what was installed. If you changed it in the
meantime, uninstall refuses, leaves your edit alone, and tells you to finish by hand.
Silently reverting someone's configuration would be worse than doing nothing.

## What is forwarded

Only these fields survive sanitization:

| Field                            | Notes                                          |
| -------------------------------- | ---------------------------------------------- |
| `version`                        | Truncated to 32 characters                     |
| `session_id`                     | **Hashed** to 16 hex characters before storage |
| `model.id`, `model.display_name` |                                                |
| `rate_limits.five_hour`          | `used_percentage` clamped to 100, `resets_at`  |
| `rate_limits.seven_day`          | Same                                           |
| `rate_limits.spend_limit`        | May legitimately exceed 100%                   |
| `cost.total_cost_usd`            | Only when present                              |

Everything else is discarded: `cwd`, `transcript_path`, `workspace`, prompt text, tool
details, output style. A window whose reset time has already passed is dropped rather
than displayed as current.

Absence is preserved. Claude Code omits `rate_limits` entirely outside an active
session, and omits individual windows too. Those render as _unknown_, never as zero —
claiming full quota when the truth is unknown would be worse than showing nothing.

## Never breaking Claude Code

Every failure path still prints a status line and exits 0:

| Failure                | Behaviour                                    |
| ---------------------- | -------------------------------------------- |
| Server down            | Swallowed; chained status line still renders |
| Missing or empty token | Swallowed                                    |
| Payload over 64 KiB    | Rejected before any request                  |
| Chained command fails  | Swallowed; empty status line                 |
| Post times out (1.5 s) | Swallowed                                    |

Nothing is ever written to stdout or stderr that could leak the token, the payload or
a server error into the conversation. Internal diagnostics carry an error class name
only.

## Ingestion endpoint

```
POST /internal/claude/statusline
Authorization: Bearer <token>
Content-Type: application/json
```

Not part of the browser API: no cookies, no CSRF, its own bearer token compared in
constant time, loopback-only, a 64 KiB body limit and its own rate limit
(40 requests / 10 s).

A payload with nothing usable returns **202**, not 400 — it is a normal occurrence
outside an active session, and the bridge must not treat it as something to retry.

An accepted payload updates the snapshot immediately, invalidates the frame cache and
triggers a refresh, rather than waiting for the next scheduled tick.

## Source selection

With `source: auto`:

1. A fresh bridge payload containing any window → local rate-limit mode.
2. No payload, but the local CLI answers → local rate-limit mode from the CLI.
3. Claude authenticated but neither source answers → _Waiting for Claude_. It does **not**
   silently fall through to an API credential, because that would swap one
   measurement for a different one without saying so. Opt in with
   "Fall back to the API credential when Claude Code is quiet".
4. No local Claude and a valid usage credential → organization API mode.
5. Otherwise a setup-required frame.

Having no reading yet is reported as a **pending** snapshot, not a thrown error. A
throw counted against the module's crash backoff on every poll, which after a restart
was guaranteed — the display took progressively longer to pick usage up once it did
arrive.

A source change is logged and invalidates the current frame.

## Organization usage mode

Uses only documented organization endpoints:

```
GET /v1/organizations/usage_report/messages
GET /v1/organizations/cost_report
```

Both are paginated through `has_more` and `next_page`, followed defensively with page
and record caps. Polling is never faster than once per minute, matching Anthropic's
guidance, regardless of the module's configured refresh interval.

An individual account or a workspace-scoped key usually cannot read these. A 403 or
404 produces a precise message rather than a vague failure:

> This credential can call Claude, but it is not authorized for organization usage
> reporting. Use local Claude Code mode or an Admin/authorized organization credential.

Credential validation issues a single one-day query with `limit=1`. **No paid model
call is ever made to test a key.**

## Troubleshooting

| Symptom                              | Cause                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| _Bridge not installed_               | Run `pnpm bridge:install`                                                                                    |
| _Waiting for Claude_                 | Normal. Usage appears after Claude Code's next request.                                                      |
| Panel shows `—` for a window         | Claude Code did not report it; correct, not a bug.                                                           |
| Bridge installed but nothing arrives | Check the server port matches `--port`, and that the token file is readable by the user Claude Code runs as. |
| Uninstall reports a conflict         | Your status line changed after install. Edit `~/.claude/settings.json` by hand.                              |
| Claude binary not found              | Expected in Docker or under a system account. Install the bridge on the host.                                |

Check state without the UI:

```bash
pnpm bridge:status
pnpm bridge:doctor
curl -s http://127.0.0.1:3210/api/v1/health | jq .bridge   # loopback installs only
```

On a server that requires login, an anonymous health check reports only
`{"status":"ok"}`; `doctor` authenticates with the bridge token and still works.
