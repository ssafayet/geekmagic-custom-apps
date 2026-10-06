# Architecture

## Package layout

Dependencies point one way: routes → services → core → (database, renderer, device-core).
Nothing points back up, and module packages depend only on the SDK and `shared`.

```
apps/
  server/                  Fastify process, routes, composition root
  web/                     React management UI
packages/
  shared/                  Error codes, DTOs, time, geo, redaction
  module-sdk/              The module contract. Modules depend on this and `shared`.
  secrets/                 AES-256-GCM vault and master key handling
  database/                SQLite schema, migrations, repositories
  renderer/                Frame model → SVG → 240×240 JPEG, bundled fonts
  device-core/             SSRF guard, transport, detection, adapters, upload queue
  core/                    Registry, runtime manager, scheduler, device manager
  module-claude-usage/
  module-adsb-monitor/
  module-weather/
  module-calendar/
tools/
  claude-statusline-bridge/  Host-side bridge CLI
  scripts/                   Fixture rendering helper
```

Module packages must not import server internals, database tables or device adapters.
That constraint is what makes a module portable across releases.

## Data flow

```
                 ┌──────────────┐
  provider  ───► │ module       │ refresh(reason, signal) → snapshot
  or bridge      │ runtime      │ getFrames(ctx)          → frame drafts
                 └──────┬───────┘
                        │  semantic frames, never pixels
                 ┌──────▼───────┐
                 │ scheduler    │ rotation, dwell, attention interruption
                 └──────┬───────┘
                 ┌──────▼───────┐
                 │ renderer     │ SVG → resvg 480×480 → sharp Lanczos → JPEG + SHA-256
                 └──────┬───────┘
                 ┌──────▼───────┐
                 │ upload queue │ coalesce, suppress unchanged, space out, retry
                 └──────┬───────┘
                 ┌──────▼───────┐
                 │ adapter      │ the only code that speaks to firmware
                 └──────────────┘
```

## Refresh and rotation are separate

A refresh fetches data and produces a snapshot. Rotation reuses whatever snapshot
exists. Switching screens therefore never triggers a network call — without this
split, a 20-second rotation would become a 20-second poll.

Both run on one 1-second tick:

- **Refresh jobs** — one per module instance, bounded by the manifest's refresh range,
  jittered, single-flight (a concurrent request coalesces into the in-flight run), and
  backed off when a module keeps failing.
- **Device schedules** — one per active device, holding the playlist, the current
  index, the dwell deadline, and any active interruption.

The tick is injectable (`now`), and `tick()` is public, so scheduler behaviour is
tested deterministically without timers.

## Attention interruption

When ADS-B sees an aircraft cross the overhead threshold, or a meeting comes within its
reminder lead time, the module raises an attention event with a de-duplication key. The scheduler then:

1. Interrupts only devices whose playlist already contains that module.
2. Honours a per-device cooldown so a stream of aircraft cannot thrash the display.
3. Holds the frame while the key stays active, and for a minimum hold after release.
4. Resumes the interrupted playlist item with a **full dwell**, so the item the
   interruption displaced is actually shown rather than skipped.
5. Drops the interruption if the attention view has nothing to render, rather than
   pinning the module's ordinary view on screen.

## Three independent write protections

They compose, and all three matter:

| Protection                  | Prevents                                    |
| --------------------------- | ------------------------------------------- |
| Frame fingerprint           | Re-rendering identical content              |
| SHA-256 of encoded bytes    | Re-uploading identical bytes                |
| Minimum interval per device | Writing to flash more often than configured |

A fingerprint hashes only visible content — `validUntil` is excluded — so a frame whose
expiry moves but whose content is identical still suppresses the upload.

## Module isolation

The SDK's guarantees are enforced in `packages/core`, not merely documented:

| Guarantee                          | Where                                 |
| ---------------------------------- | ------------------------------------- |
| HTTP restricted to declared hosts  | `PermissionScopedHttpClient`          |
| Only its own declared secrets      | `InstanceScopedSecrets`               |
| Timeout and abort on every refresh | `ModuleRuntimeManager.performRefresh` |
| Crash barrier with backoff         | `consecutiveFailures` → `backoffMs`   |
| Size-capped, validated snapshots   | `SnapshotRepository.put`              |
| Host services by permission only   | `ModuleRuntimeManager.createContext`  |

## Persistence

SQLite via `better-sqlite3` with numbered migrations applied inside transactions and a
pre-migration file copy. Repositories return typed records; the `Store` facade is the
only entry point, and modules never see it.

**Why no ORM:** hand-written SQL behind typed repositories. The repository boundary is
what the rest of the system depends on, the schema is small and stable, and leaving
out an ORM removes a layer between the code and the queries it runs.

## Rendering

**Why resvg rather than Sharp for SVG:** Sharp rasterizes SVG through librsvg, which
resolves fonts through system fontconfig — so output depends on what fonts the host
happens to have. This uses `@resvg/resvg-js` with explicitly loaded bundled font files
for rasterization, and keeps Sharp for the Lanczos downsample and JPEG encode. A
container renders byte-identically to a laptop, which is what makes the visual
regression suite meaningful.

Text is measured with the same font files that get rasterized, so ellipsis and
shrink-to-fit decisions match what is actually drawn. Measurement is best-effort:
remote strings can contain glyphs that fail to decode, and a layout hint must never be
able to crash a render.
