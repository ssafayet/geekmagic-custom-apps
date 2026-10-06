# Security model

> **Reporting a vulnerability:** use
> [Report a vulnerability](https://github.com/ssafayet/geekmagic-custom-apps/security/advisories/new)
> on the repository's Security tab, not a public issue. You will get a reply there.

Local-first by default: the server binds to `127.0.0.1`, needs no account, and sends
nothing anywhere except the providers a module declares.

## Exposure and authentication

Binding beyond loopback, or configuring a reverse proxy (`GCA_TRUST_PROXY` or
`GCA_PUBLIC_BASE_URL`), is what turns authentication on. A same-machine proxy connects
over loopback, so the bind address alone cannot say who reaches the app. When on:

- A single administrator password, hashed with Argon2id.
- **Default-deny**: every route under `/api/` needs a session unless it is explicitly
  marked public (health, auth state, login, logout, password). The decision uses the
  route the router matched, never the raw URL, so an alternative spelling such as
  `/%61pi/v1/devices` cannot skip it.
- Session in an HTTP-only, `SameSite=Strict` cookie, marked `Secure` whenever the
  request arrived over HTTPS (directly, or per a trusted proxy's `X-Forwarded-Proto`).
- Double-submit CSRF: a readable cookie whose value must be echoed in the
  `x-gca-csrf` header on every state-changing request, compared in constant time.
- Password routes are rate-limited per address (10 a minute), and at most two
  Argon2 hashes run at once, so the login route cannot be used to pin the CPU.
- Unauthenticated health checks get `{ "status": "ok" }` and nothing else.

The **first** password needs a one-time setup code, printed in the startup log and
written owner-only to `setup-token` in the data directory. Without it, whoever reached
a fresh exposed server first could claim it. The code is deleted once used. Every
later change requires the current password and signs out every session.

`GCA_AUTH_REQUIRED=false` on a non-loopback bind is allowed, because a container
publishing `127.0.0.1:3210` has no other way to say so, but it is logged as an error.

## DNS rebinding and cross-origin requests

These controls apply in every mode, including unauthenticated loopback, where they are
what stands between a web page you happen to visit and full control of the app.

- **Host allowlist.** Requests are answered only for `localhost`, IP literals,
  single-label names, names under private-only suffixes (`.local`, `.lan`, `.home`,
  `.home.arpa`, `.internal`, `.localdomain`), the `GCA_PUBLIC_BASE_URL` host and
  `GCA_ALLOWED_HOSTS`. A rebinding page cannot change the Host its browser sends, and
  that Host names the attacker's domain; it gets `421`.
- **Origin check.** A write whose `Origin` names another site, or is the opaque
  `null`, is refused. Clients that send no Origin (curl, the bridge) are not a
  browser steered by some other page and rely on the remaining controls.
- **JSON only.** There is no `text/plain` parser, so the one body type a cross-site
  form or `no-cors` fetch can send without a preflight is refused with `415`.
- **Headers.** A strict same-origin Content-Security-Policy with `frame-ancestors
'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and `Cache-Control:
no-store` on API responses.

## Proxies and client addresses

`GCA_TRUST_PROXY` names the hops allowed to set `X-Forwarded-*`: `true` means a proxy
on this machine (loopback), otherwise a list of addresses or CIDRs. It never trusts
every hop, which would let any client choose its own `request.ip` — the address the
bridge source check and the rate limits key on.

For anything beyond a trusted LAN, put the app behind a reverse proxy with TLS.

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

ADS-B and Weather coordinates are treated as sensitive:

- The settings page states plainly that they are sent to the provider on every poll.
- Logs get a value rounded to one decimal place (~11 km).
- They are module settings, not secrets, so they are stored as plain JSON in
  `app.db`. Treat a copy of the database as revealing the configured location.
- The diagnostics export excludes coordinates and hostnames entirely, and shows you
  the full contents before you download anything.
- The airline and route lookup sends only the callsign of an aircraft already on
  screen, to a different host, with no coordinates attached. It is a switch on the
  settings page. See
  [BUILT-IN-MODULES.md](BUILT-IN-MODULES.md#airline-and-route).
- Weather sends its coordinates to Open-Meteo. AirGradient never receives them: a
  monitor is read by its location ID, and the nearest-monitor search downloads the
  public list and measures distance locally.

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
- Device backup filenames come from the display's own listing. They are stripped of
  traversal by the adapter and checked again where they are written, so a file can
  only ever land inside its backup directory.
- The frame model is semantic. There is no path by which a module or provider can
  introduce HTML or JavaScript into the render pipeline.

## Dependencies

Version 1 modules are compiled in. Loading packaged or remote modules is deliberately
out of scope: it would need a trust policy and worker isolation, which is a different
problem from the one this release solves.

The lockfile is committed and CI runs `pnpm audit`.
