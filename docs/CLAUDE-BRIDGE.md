# The Claude Code status-line bridge

Claude Code can pipe a JSON status-line payload to a command on every render. The
bridge receives that payload, keeps only the approved fields, and forwards them to
this server on loopback.

This is the only way subscription usage reaches the display. There is deliberately no
code path that reads Claude Code's credentials or calls the private endpoint behind
`/usage`.

## Install

```bash
pnpm bridge:install
# or, from a built install:
gca-claude-bridge install
```

Flags: `--data-dir`, `--settings`, `--port`, `--endpoint`.

Available without the web UI on purpose: in Docker the server runs in a container
while Claude Code runs on the host, so the bridge has to be installable there.

Other commands:

```bash
gca-claude-bridge status      # JSON install state; exit 0 if installed
gca-claude-bridge uninstall   # restore the previous status line
```

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
2. Claude authenticated but no payload yet → _Waiting for Claude_. It does **not**
   silently fall through to an API credential, because that would swap one
   measurement for a different one without saying so. Opt in with
   "Fall back to the API credential when Claude Code is quiet".
3. No local Claude and a valid usage credential → organization API mode.
4. Otherwise a setup-required frame.

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
| _Bridge not installed_               | Run `gca-claude-bridge install`                                                                              |
| _Waiting for Claude_                 | Normal. Usage appears after Claude Code's next request.                                                      |
| Panel shows `—` for a window         | Claude Code did not report it; correct, not a bug.                                                           |
| Bridge installed but nothing arrives | Check the server port matches `--port`, and that the token file is readable by the user Claude Code runs as. |
| Uninstall reports a conflict         | Your status line changed after install. Edit `~/.claude/settings.json` by hand.                              |
| Claude binary not found              | Expected in Docker or under a system account. Install the bridge on the host.                                |

Check state without the UI:

```bash
gca-claude-bridge status
curl -s http://127.0.0.1:3210/api/v1/health | jq .bridge
```
