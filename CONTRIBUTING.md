# Contributing

Thanks for helping. The most useful contribution right now is a **device report**
from any display other than a SmallTV-PRO on `V3.4.88EN` — only that one has been
tested on real hardware.

## Reporting a device

Open the **Diagnostics** page, review the report it shows (it excludes hostnames,
coordinates and credentials), download it, and attach it to a
[device report](https://github.com/ssafayet/geekmagic-custom-apps/issues/new?template=device-report.yml).
That is usually enough to confirm or fix an adapter.

## Bugs and ideas

Use the [issue templates](https://github.com/ssafayet/geekmagic-custom-apps/issues/new/choose).
Security problems go to a
[private advisory](https://github.com/ssafayet/geekmagic-custom-apps/security/advisories/new),
never a public issue.

## Code

Setup, layout, tests and working without hardware are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Before opening a pull request:

```bash
pnpm format && pnpm typecheck && pnpm test
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat(adsb): …`, `fix(core): …`) and explain why in the body. New modules are written
against the SDK in [docs/MODULES.md](docs/MODULES.md); new device adapters against
[docs/DEVICES.md](docs/DEVICES.md).

Keep personal data out of commits: real coordinates, device IPs and hostnames belong
in your local `.env` or data directory, never in a test fixture or screenshot.
