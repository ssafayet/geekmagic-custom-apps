# Security model

Local-first by default: the server binds to `127.0.0.1`, needs no account, and sends
nothing anywhere except the providers a module declares.

## Exposure and authentication

Binding beyond loopback is what turns authentication on. When exposed:

- A single administrator password, hashed with Argon2id.
- Session in an HTTP-only, `SameSite=Strict`, `Secure` cookie.
- Double-submit CSRF: a readable cookie whose value must be echoed in the
  `x-gca-csrf` header on every state-changing request.
- Startup logs an error if the server is exposed with no password set.

The **first** password can be set without authentication, otherwise a fresh exposed
deployment could never authenticate itself. Every subsequent change requires the
current password. `GET /api/v1/health` stays open so container healthchecks work.

For anything beyond a trusted LAN, put it behind a reverse proxy with TLS and set
`GCA_TRUST_PROXY=true`.

## SSRF

Device probe and upload URLs are server-side requests and are treated as a trust
boundary. See [DEVICES.md](DEVICES.md#network-safety) for the controls: private-range
allowlisting, address pinning after DNS resolution, no redirect following, body caps,
and encoding of every path component that came from a device.

The module HTTP client is separately restricted: HTTPS only, and only to hosts a
module's declared permissions unlock. A module cannot reach an arbitrary URL even by
accident.

## Secrets at rest

- A 256-bit master key is generated on first start, written `0600`, and kept **outside**
  the database — copying `app.db` alone yields nothing usable.
- Each secret is AES-256-GCM encrypted with a fresh random IV.
- The additional authenticated data binds `moduleInstanceId | fieldKey`, so a
  ciphertext copied into another module instance or field fails to decrypt rather than
  silently succeeding.
- Decryption failure is loud: the module is not started with a missing credential.
- In containers, mount your own key with `GCA_MASTER_KEY_FILE` so secrets survive a
  rebuild that discards the volume.

## Secrets in transit through the app

- A stored secret is **never** returned to the browser. The API exposes only
  `{ configured, lastFour, updatedAt }`.
- An empty form field preserves the stored value; removal is a separate action.
- Logs redact `apiKey`, `authorization`, `token`, `cookie`, `secret`, `password` and
  `session_id` recursively, in pino's redaction paths and again in a serializer.
- Audit details are redacted on write, so no credential can reach a stored row.
- Credentials never appear in a URL.

## What is never collected

From Claude Code: prompt text, conversation content, workspace paths, transcript
paths, tool details. The session id is hashed before storage. See
[CLAUDE-BRIDGE.md](CLAUDE-BRIDGE.md#what-is-forwarded).

Nothing else is collected at all: no analytics, no telemetry, no crash reporting.

## Location privacy

ADS-B coordinates are treated as sensitive:

- The settings page states plainly that they are sent to the provider on every poll.
- Logs get a value rounded to one decimal place (~11 km).
- The diagnostics export excludes coordinates and hostnames entirely, and shows you
  the full contents before you download anything.

## Destructive operations

Anything that removes user data uses a two-step confirmation bound to the **specific**
plan:

1. A `GET` returns the exact changes and mints a token bound to a hash of them.
2. The `POST` must present that token, and the server re-derives the plan and compares.

If the plan changed between review and confirmation — more files would be deleted, say
— the token no longer matches and the call is refused. Tokens are single-use and
expire in five minutes. No `GET` ever deletes anything.

Module actions that write outside the application are marked `writes: true` and
require explicit confirmation naming what they touch.

## Input handling

- Module settings validate against JSON Schema (Ajv) and then module cross-field
  rules; unrecognised properties are rejected rather than silently dropped.
- Every string reaching the SVG renderer is XML-escaped and stripped of control
  characters — aircraft callsigns come from a remote provider.
- Icons are referenced by id from a built-in set; modules cannot supply path data.
- Snapshots are size-capped, schema-guarded and scrubbed before persistence.
- The frame model is semantic. There is no path by which a module or provider can
  introduce HTML or JavaScript into the render pipeline.

## Dependencies

Version 1 modules are compiled in. Loading packaged or remote modules is deliberately
out of scope: it would need a trust policy and worker isolation, which is a different
problem from the one this release solves.

The lockfile is committed and CI runs `pnpm audit`.

## Reporting

Open a private security advisory on the repository rather than a public issue.
