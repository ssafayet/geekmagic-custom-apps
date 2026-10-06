# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] — unreleased

The first public release.

### Modules

- **Claude Usage** — Claude Code subscription limits from a local session, through the
  status-line bridge, a timed push or the local CLI; or Anthropic organization API
  tokens and cost.
- **ADS-B Monitor** — the nearest or overhead aircraft from adsb.fi or OpenSky, with the
  operator and route behind the callsign from adsbdb.
- **Weather** — conditions from Open-Meteo, with air quality from Open-Meteo or an
  AirGradient monitor.
- **Calendar** — the next meeting from a secret iCal link, with a reminder that
  interrupts the display before it starts.

### Server, UI and devices

- A local server that renders module frames to 240×240 JPEGs and pushes only changed
  frames to stock GeekMagic firmware over its own HTTP API.
- Firmware detection before any write; SmallTV-PRO verified on hardware, other
  profiles verified against a firmware simulator.
- A browser UI with a setup guide, display order, previews, diagnostics and an
  exportable device report.
- Loopback by default, a login whenever the UI is reachable from elsewhere, DNS-rebinding
  and SSRF guards, and secrets encrypted at rest.

### Deployment

- Native installs with launchd and systemd recipes, and `docker compose up` with no
  required configuration.
- `tools/claude-bridge.sh`, so Claude Usage works with the server in Docker and no Node
  or pnpm on the host.
