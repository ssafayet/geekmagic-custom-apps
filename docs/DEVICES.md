# Device support

## Hardware verification status

**Only the GeekMagic SmallTV-PRO has been tested against real hardware.** Everything
else is implemented from documented endpoints and covered by simulator contract tests,
but has never been run against a physical unit.

| Profile                | Device                                      | Status                                                                                                              |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `stock-pro`            | SmallTV-PRO, stock firmware                 | **Verified** on `V3.4.88EN`. Detection, upload, album takeover, backup and restore were all exercised end to end.   |
| `stock-ultra`          | SmallTV Ultra, stock firmware               | **Unverified.** Implemented from the documented endpoints and the reference project; simulator contract tests only. |
| `sd-pro`               | Ultra-branded units running SD_PRO firmware | **Unverified.** Same basis as `stock-ultra`.                                                                        |
| `weather-clock-legacy` | Legacy weather clock                        | **Unverified**, and never written to by design — detected only so diagnostics can explain why it is unsupported.    |

What unverified means in practice: the request sequence matches the endpoints the
firmware is documented to expose and is asserted by contract tests, but nobody has
watched it drive the physical device. Detection, the SSRF guard and the refusal to
write to an unrecognised profile all apply regardless, so the realistic failure mode
for an unverified unit is an error in the UI — not a damaged display.

If you own one, the Diagnostics page generates a report containing the probe
transcript, model string and firmware version, with hostnames and coordinates removed.
That report is enough to confirm or correct an adapter, and is very welcome.

## Detection

Detection is read-only and runs in a fixed order, stopping at the first confident
match. Each step has a five-second timeout and the whole probe is capped at twenty
seconds.

| #   | Request              | Identifies                                                                                   |
| --- | -------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `GET /v.json`        | `m` containing `pro` → `stock-pro`; containing `ultra` → `stock-ultra`. Records `m` and `v`. |
| 2   | `GET /.sys/app.json` | Valid JSON → `stock-pro`                                                                     |
| 3   | `GET /app.json`      | Valid JSON → `stock-ultra`                                                                   |
| 4   | `GET /theme/list`    | JSON with a `themes` array → `sd-pro`                                                        |
| 5   | `GET /`              | `id="giflist"` **and** `action='/connect'` → `weather-clock-legacy`                          |
| 6   | —                    | Otherwise `unknown`; all writes disabled                                                     |

`pro` is checked before `ultra` because some PRO model strings contain both.

The full transcript — path, status, outcome, duration — is kept and shown in the UI,
and is included in the diagnostics export with network identifiers removed.

Results are cached and re-checked on an explicit probe, after repeated protocol
errors, and at startup. If the profile changes, the adapter is swapped and the change
is recorded in the audit log.

## Profiles

### `stock-ultra`

| Operation    | Request                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| Upload       | `POST /doUpload?dir=/image/`, multipart field `file`, filename `dashboard.jpg` |
| Theme        | `GET /set?theme=3`                                                             |
| Select image | `GET /set?img=/image/dashboard.jpg`                                            |
| State        | `GET /app.json`                                                                |
| Brightness   | `GET /set?brt={0-100}`                                                         |

Some builds answer `FAIL` to image selection even though they have replaced the
displayed file. The adapter checks device state, records a warning, and keeps going.
Re-uploading on every cycle in response to a cosmetic `FAIL` would write to flash
thousands of times a day for no benefit.

### `stock-pro`

| Operation      | Request                                               |
| -------------- | ----------------------------------------------------- |
| Upload         | `POST /doUpload?dir=/image/`, multipart field `file`  |
| Theme          | `GET /set?theme=4`                                    |
| State          | `GET /.sys/app.json`, falling back to `GET /app.json` |
| Album settings | `GET /set?i_i=1&gif_loop=1&autoplay=1`                |
| Album listing  | `GET /filelist?dir=/image/`                           |
| Delete         | `GET /delete?file={encoded}`                          |

Theme and album settings are written once, not every cycle.

**Upload disconnects are normal.** This firmware frequently drops the connection after
storing the file. A dropped connection is treated as success **only** once the file is
confirmed present in the listing; otherwise it raises `DEVICE_UPLOAD_UNVERIFIED`.

**Managed album.** Picture mode is a slideshow, so deterministic output requires the
managed image to be the only file present. The order is fixed:

1. Explicit consent, against the exact list of files that would be removed.
2. Download every file, record size and SHA-256.
3. Upload `dashboard.jpg`.
4. Verify it appears in the listing.
5. Only then delete the others.
6. Apply album settings and theme 4.
7. Ask the user to open the Picture app once on the device.

If the backup fails, nothing is deleted. Restore re-uploads each file after verifying
its checksum, reports per-file failures, and turns managed mode off.

That last manual step is real. This project does not pretend it can reliably drive the
PRO's on-device menu.

### `sd-pro`

Some Ultra-branded units run a different photo-slideshow API. Product names alone do
not identify firmware, which is why this is a separate adapter.

| Operation      | Request                                        |
| -------------- | ---------------------------------------------- |
| State          | `GET /config`                                  |
| Upload         | `POST /photo/upload`, multipart field `file`   |
| Photo listing  | `GET /photo/list`                              |
| Toggle photo   | `GET /photo/toggle?name={name}&state={0\|1}`   |
| Photo interval | `GET /photo/interval?val=1`                    |
| Theme listing  | `GET /theme/list`                              |
| Toggle theme   | `GET /theme/toggle?id={id}&state={0\|1}`       |
| Active theme   | `GET /api/set?key=theme&value=2`               |
| Brightness     | `GET /api/set?key=lcd_brightness&value={2-99}` |

Brightness clamps to 2–99, not 0–100. Entering managed mode records which photos and
themes were enabled beforehand so exiting can restore them.

### `weather-clock-legacy` and `unknown`

Both use an adapter whose every mutating call throws. `unknown` raises
`DEVICE_PROFILE_UNKNOWN`, the legacy profile raises `DEVICE_PROFILE_UNSUPPORTED`, and
both are reported at HTTP 409 with the message intact so the UI can explain the
situation rather than showing a generic server error.

## Network safety

Device URLs are server-side requests, so `packages/device-core/src/address-guard.ts`
is an SSRF boundary:

- Only private IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `100.64/10`) and IPv6 ULA/link-local are allowed by default.
- Loopback, unspecified and multicast are refused. Even an explicit `allowPublic`
  escape hatch will not permit unspecified or multicast.
- DNS is resolved and the resulting literal address is what the socket connects to, so
  a name that re-resolves between check and connect cannot slip through.
- Redirects are never followed — undici does not add the redirect interceptor, so a
  3xx arrives as an ordinary non-OK response.
- Response bodies, file listings and backup downloads are size-capped.
- Every path component taken from a device response is percent-encoded before it goes
  back in a query string, and raw device HTML is never shown in the UI.

## Malformed firmware responses

SmallTV-PRO firmware `V3.4.88EN` emits a duplicated `Content-Length` header on
`/filelist`:

```
Content-Length: 1133
Content-Length: 1133
```

Node's parser and undici both reject that outright, and they are right to: conflicting
`Content-Length` headers are a classic request-smuggling vector. Here the values agree
and match the body exactly, so the firmware is merely sloppy rather than ambiguous —
but without tolerating it, every album operation on a real PRO fails: listing,
verification, backup and pruning.

`packages/device-core/src/lenient-http.ts` is a deliberately narrow fallback for that
case. It engages only after the primary transport reports this specific quirk, accepts
duplicate `Content-Length` **only** when every value is identical, rejects conflicting
values, keeps the same byte cap and timeout as the primary transport, and does not
implement redirects at all.

## Discovery

Optional, never automatic. It enumerates private IPv4 interfaces, asks which subnet to
scan, refuses anything broader than `/24`, probes at most 16 hosts concurrently with a
one-second timeout, and is cancellable. Manual entry always remains available because
discovery can be blocked by VLANs, firewalls or unusual netmasks.

## Adding an adapter

1. Add the profile id to `DEVICE_PROFILES` in `packages/shared/src/api-types.ts`.
2. Describe what it can do in `packages/device-core/src/capabilities.ts`.
3. Add a detection step in `detection.ts`, in the right order.
4. Implement `DeviceAdapter` in `packages/device-core/src/adapters/`.
5. Register it in the `createAdapter` factory.
6. Add a simulator profile and contract tests.

Contract tests assert exact method, path, multipart field name, filename and operation
order, so no hardware is needed in CI. Model the firmware's awkward behaviour
explicitly — the simulator already has profiles for an upload that disconnects and a
selection that answers `FAIL`.

If you have an unsupported unit, generate a report from the Diagnostics page. It
contains the probe transcript, model string and firmware version, and excludes
hostnames and coordinates.
