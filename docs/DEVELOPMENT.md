# Development

## Prerequisites

- Node.js 22.11 or newer
- pnpm 10 (`corepack enable` is enough)

No hardware is required to develop, test or review this project. See
[Working without hardware](#working-without-hardware).

## Layout

A pnpm workspace. Dependencies point one way: routes → services → core → (database,
renderer, device-core), and module packages depend only on the SDK. The full map is in
[ARCHITECTURE.md](ARCHITECTURE.md#package-layout).

## Everyday commands

```bash
pnpm install
pnpm build                      # tsc -b plus the Vite build
pnpm typecheck                  # tsc -b across the workspace
pnpm test                       # unit, contract, integration and visual suites
pnpm test:watch
pnpm test:ui                    # web project only
pnpm format                     # prettier --write .
pnpm format:check               # what CI runs
pnpm clean                      # removes dist and tsbuildinfo together
```

Run the API and the UI dev server side by side:

```bash
pnpm dev       # Fastify on :3210, restarts on change
pnpm dev:web   # Vite on :5173, proxies /api to :3210
```

`pnpm clean` exists because a stale `tsconfig.tsbuildinfo` makes `tsc -b` believe the
output is current and emit nothing. If a build looks impossibly fast and wrong, clean
first.

## Working without hardware

**Rendering.** Output is deterministic — fonts are bundled and loaded explicitly rather
than resolved through system fontconfig — so a container renders byte-identically to a
laptop. That is what makes the visual regression suite meaningful, and it means a
failing render test is a real regression rather than an environment difference.

```bash
pnpm exec tsx --conditions=development tools/scripts/render-fixtures.mts
open test-artifacts/frames
```

**Devices.** `packages/device-core/test/simulator` is a fake GeekMagic server that
reproduces the firmware quirks that matter, including a PRO that drops the upload
connection after storing the file and an Ultra that answers `FAIL` to image selection.
Contract tests assert exact method, path, multipart field name, filename and operation
order against it, so adapters are verifiable in CI.

The simulator is not a substitute for a real unit. Only the SmallTV-PRO has been
confirmed against physical hardware — see
[DEVICES.md](DEVICES.md#hardware-verification-status).

## Tests

`vitest run` covers everything. The suites are:

| Suite             | Lives in                                | Asserts                                               |
| ----------------- | --------------------------------------- | ----------------------------------------------------- |
| Unit              | each package's `test/`                  | Pure logic: geo, time, redaction, selection, settings |
| Contract          | `packages/device-core/test`             | Exact wire behaviour against the simulator            |
| Integration       | `apps/server/test`                      | Routes, auth, CSRF, end-to-end module → frame flow    |
| Visual regression | `packages/renderer/test/visual.test.ts` | Rendered frames byte-for-byte                         |

The scheduler takes an injectable `now` and exposes a public `tick()`, so timing
behaviour is tested deterministically without fake timers.

## Adding things

- **A module** — [MODULES.md](MODULES.md). Register it in
  `packages/core/src/registry.ts`; the UI form, validation, secret handling and actions
  are generated from the declaration, and there is no module-specific code in the UI.
- **A device adapter** — [DEVICES.md](DEVICES.md#adding-an-adapter). Six steps, ending
  with a simulator profile and contract tests.

## Before opening a pull request

```bash
pnpm format:check && pnpm typecheck && pnpm build && pnpm test
```

That is exactly what CI runs, across Node 22 and 24, plus a `pnpm audit --prod` and a
Docker image build that smoke-tests the running container.

Please do not commit anything from a real device: probe transcripts, LAN addresses,
coordinates or a populated `data/` directory. The ignore rules cover the usual cases —
including throwaway `_*.ts` scratch scripts — but they cannot catch a pasted address in
a test fixture.
