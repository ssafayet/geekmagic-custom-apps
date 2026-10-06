# Built-in modules

Four modules ship in this release. All are ordinary `AppModule` implementations with
no privileged access to the server — see [MODULES.md](MODULES.md) for the contract they
are written against.

---

## Claude Usage

| Overview page                                                                 | On the display                                                        |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ![The Claude Usage panel on the Overview page](images/claude-usage-panel.png) | ![Claude Usage on a SmallTV-PRO](images/smalltv-pro-claude-usage.jpg) |

The `stale` badge on the right is the module refusing to imply freshness it does not
have: past **Mark data stale after** (30 minutes by default) the last real reading stays
on screen with the badge, rather than blanking or falling back to zero.

Subscription usage and API usage are **different products**, and this module keeps them
clearly separated rather than blending them into one number.

| Source                     | What you need                                                                                  | What you see                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Local Claude Code          | A signed-in Claude Code on the same machine; the status-line bridge for live updates or Docker | 5-hour and 7-day used percentage, and reset times |
| Anthropic organization API | A credential authorized for usage reporting                                                    | Tokens, requests and cost over a window you pick  |

The **Source** setting is `Auto`, `Local Claude Code`, or `Organization usage API`.
`Auto` prefers the local bridge and can optionally fall back to the API credential when
Claude Code has been quiet.

### Why your API key may not work

An ordinary API key that can call Claude is usually **not** authorized for organization
usage reporting; those are separate scopes. The UI says so precisely — including which
check failed — rather than reporting a vague error. Use the **Test credential** action
on the settings page to confirm before relying on it.

### The status-line bridge

When the server runs as you, it reads the limits from the Claude Code CLI every few
minutes with no setup at all. The status-line bridge makes them live — forwarded on
every request — and is the only route when the server runs in Docker or under another
account, since those cannot see your Claude Code. Install it with:

```bash
pnpm bridge:install
```

Its guarantees in brief — your existing status line keeps working and is restored
byte-for-byte on uninstall, no credentials are ever read, no prompt content is
collected, and it never breaks Claude Code even when the server is down. The full
design, the exact payload fields, and recovery steps are in
[CLAUDE-BRIDGE.md](CLAUDE-BRIDGE.md).

Usage appears after Claude Code makes its next request. Until then the display honestly
says _waiting_, never zero.

---

## ADS-B Monitor

| Overview page                                                                  | On the display                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| ![The ADS-B Monitor panel on the Overview page](images/adsb-monitor-panel.png) | ![ADS-B Monitor on a SmallTV-PRO](images/smalltv-pro-adsb.jpg) |

The header reads `NEARBY` or `OVERHEAD`. Operator and route come from a second source,
so they appear only when the callsign resolved, and the footer credits `adsbdb` only on the
frames that actually used it — which is why the photo credits `adsb.fi` alone.

Shows the nearest or currently overhead aircraft around a location you configure, with
distance, altitude, speed and bearing.

### Providers

The provider sits behind an interface, so a local `readsb` receiver or a licensed feed
can be added later without touching selection or rendering.

The module runs as a single instance. The provider is a setting inside it, not a reason
to add the module twice.

| Provider                                                         | Account  | Constraint                                                                     | Carries registration and type |
| ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ | ----------------------------- |
| [adsb.fi](https://github.com/adsbfi/opendata) (default)          | None     | Roughly one request per second; coverage depends on volunteer feeders near you | Yes                           |
| [OpenSky Network](https://openskynetwork.github.io/opensky-api/) | Optional | A **daily** request budget, not a per-second rate limit                        | No                            |

Pick adsb.fi first. It is free, needs no account, and returns richer data. Switch to
OpenSky when volunteer coverage near you is thin — in parts of South Asia, for example,
adsb.fi returns nothing where OpenSky returns traffic.

**OpenSky's budget is the binding constraint.** It bills per request and resets daily,
so the poll interval — not a rate limit — decides whether a deployment runs out by
lunchtime:

| Credentials          | Daily requests | Slowest safe poll |
| -------------------- | -------------- | ----------------- |
| Anonymous            | ~400           | ~238 s            |
| Client ID and secret | ~4,000         | ~24 s             |

Settings validation refuses a poll interval that would exhaust the budget, and says why,
instead of letting the module fail silently halfway through the day. Credentials are
optional, stored in the encrypted vault like any other module secret, and entered as
`openSkyClientId` / `openSkyClientSecret` on the settings page.

OpenSky state vectors carry no registration or aircraft type, so those fields stay
absent rather than being guessed. The settings page warns about this before you switch.

### Airline and route

An aircraft broadcasts a callsign. It does not broadcast who operates it or where it is
going, so neither adsb.fi nor OpenSky can return those. The **Airline and route** switch
(on by default) resolves them from the callsign against
[adsbdb](https://www.adsbdb.com/), which needs no account, and the panel then shows the
operator under the callsign and `LHR → JFK` under the speed.

It resolves for scheduled airline traffic and not for general aviation, which has no
published schedule — `N172SP` has no route and never will. A callsign with no answer
simply shows nothing, the same as a missing altitude.

Lookups are kept cheap on purpose, because the API is free and shared:

- Only the aircraft actually on screen are looked up, never the whole sky.
- At most three new callsigns per poll.
- Answers are cached for a day, and a "no route" answer for six hours, so a flight
  circling overhead costs one request rather than one per poll.
- The cache survives a restart, and a rate-limit response pauses lookups for five
  minutes rather than retrying into it.

Turn the switch off and the panel shows only what the aircraft itself transmits.

### Behaviour

- **Overhead uses hysteresis.** An aircraft becomes overhead at the enter radius and
  stays overhead until it passes the larger exit radius, so one drifting along the
  boundary cannot flap the display back and forth.
- **Absent data stays absent.** A missing altitude renders as `—`, never `0 ft`.
- **An empty sky is healthy**, not an error. The **Test location** action distinguishes
  "the provider worked and there is nothing up there" from "the provider failed".
- **Overhead traffic can interrupt the playlist**, subject to a per-device cooldown.
  See [ARCHITECTURE.md](ARCHITECTURE.md#attention-interruption).
- **Nothing is invented.** Airline and route are not in the broadcast, so they are
  either resolved from a named second source or left off the panel. Neither is ever
  guessed from the callsign prefix.

### Privacy

Your coordinates are sent to the provider on every poll. The settings page says so at
the point of entry, the values are stored locally, and they are rounded before they
reach any log or diagnostics export. See
[SECURITY.md](SECURITY.md#location-privacy).

With **Airline and route** on, the callsign of each aircraft being displayed is also
sent to `api.adsbdb.com`. That is the whole request: no coordinates, no device identity,
nothing that ties the callsign to you beyond the network connection itself. A callsign
is public information already broadcast in the clear by the aircraft. Turn the switch
off to keep every outbound request going to the ADS-B provider alone.

---

## Weather

Current conditions for one location: temperature, condition, feels-like, today's high
and low, humidity, wind speed and direction, air quality, and a fourth reading you pick
(UV index by default; pressure, gusts, dew point, precipitation or cloud cover). It has
two views for **Display order**:

| View               | Shows                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| Current conditions | The temperature hero, the condition glyph and a two-by-two grid of readings   |
| Air quality        | US AQI with its category, PM2.5, and CO₂ and TVOC from an AirGradient monitor |

The module is not a singleton: a second city is a second instance.

### Sources

| What          | Source                                                                                   | Account   | Updates          |
| ------------- | ---------------------------------------------------------------------------------------- | --------- | ---------------- |
| Weather       | [Open-Meteo forecast API](https://open-meteo.com/en/docs)                                | None      | Every 15 minutes |
| Air (default) | [Open-Meteo air quality API](https://open-meteo.com/en/docs/air-quality-api), CAMS model | None      | Hourly           |
| Air, your own | [AirGradient cloud API](https://api.airgradient.com/public/docs/api/v1/)                 | API token | As it reports    |
| Air, public   | AirGradient's public map, by location ID                                                 | None      | As it reports    |

Open-Meteo is free for **non-commercial** use below 10,000 calls a day. It needs no key,
covers the whole planet and has a ready "current conditions" block, which is why it is
the source. A ten-minute poll costs about 290 calls a day for weather and air together.
Its data is CC BY 4.0, so every frame that uses it credits it in the footer.

**Your own AirGradient monitor.** In the AirGradient dashboard, open the place settings,
turn on API access under **Connectivity**, and paste the token into the settings page.
It is stored in the encrypted vault like any module secret. Leave **Location ID** empty
to use the first monitor on the account, or press **Test location and source** to list
them all with their IDs. The panel header then shows the monitor's own name, such as
`Living room`.

**A public monitor.** Choose _Public AirGradient monitor_ and press **Test location and
source**: it lists the five nearest public monitors that are reporting, with distance
and current AQI. Put one of the IDs in **Location ID**. No account is needed. The search
downloads the whole public list (about 1.5 MB), so it runs only from that button, never
on a poll.

### How the AQI is worked out

- **Open-Meteo** reports the US AQI itself: the highest of six pollutant sub-indices,
  with particulates averaged over 24 hours.
- **AirGradient** reports PM2.5 in µg/m³ only, so the module computes the US AQI from
  it using the EPA's 2024 breakpoints (Good ends at 9.0 µg/m³). It reads
  `pm02_corrected` when AirGradient publishes it — turn on the EPA correction for your
  place to get it — and the raw reading otherwise. The breakpoints are defined for a
  24-hour average, so applying them to a current reading is the same approximation
  every consumer air display makes. The tile is labelled `AQI · sensor` so the two are
  never confused.

Indoor monitors measure indoor air. That is often what you want on a desk display, but
it is not the outdoor index, and the module does not pretend otherwise.

### Behaviour

- **Absent data stays absent.** A variable the model did not report renders as `—`.
- **Air quality never takes the weather down.** If AirGradient or the air-quality API
  fails, the temperature keeps updating, the AQI tile shows `—`, health reads
  _degraded_, and the air view says what failed.
- **Old readings are not shown as current.** A failed poll keeps the last reading with
  a `stale` badge after 30 minutes (or three poll intervals), and replaces it with
  _Weather offline_ after three hours. An AirGradient monitor that stopped reporting
  keeps its last value in the cloud forever, so the reading's own timestamp is checked:
  past two hours the air view says _Monitor not reporting_.
- **A moved location starts clean.** Each reading remembers the coordinates and source
  it was fetched for. After you change either, a restored snapshot from before is
  dropped rather than shown under the new label.
- **Units are a display choice.** Readings are fetched and stored in metric, and
  converted when drawn, so changing units never needs a refetch.
- **With air quality off**, the AQI tile is replaced by another reading, and the air
  view yields its playlist slot to current conditions.

### Privacy

Your coordinates go to Open-Meteo on every poll, and the settings page says so. They
never go to AirGradient: your own monitor is read through your token, a public one by
its ID, and the nearest-monitor search measures distances on this machine. Coordinates
are rounded before they reach any log, as for ADS-B. See
[SECURITY.md](SECURITY.md#location-privacy).

---

## Calendar

Your next meeting, from a calendar's secret iCal link, and a reminder before it starts.

| View         | Shows                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Next meeting | A countdown (`in 1h 25m`, `Thu 11:00`), the title, time and room or call service, and what comes after. During a meeting, `ends in 20 min`. |
| Reminder     | Interrupts the display before a meeting: `in 9 min`, in amber. Not a playlist item.                                                         |

Add one instance per calendar; work and personal are two links, so two instances.

### Getting the link

| Provider                | Where                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Google Calendar         | Settings → your calendar → **Integrate calendar** → _Secret address in iCal format_ |
| Outlook / Microsoft 365 | Settings → Calendar → **Shared calendars** → _Publish a calendar_ → the ICS link    |
| iCloud                  | Calendar app → share the calendar → **Public Calendar** → copy the `webcal://` link |
| Fastmail, Proton        | The calendar's sharing settings → the iCal / ICS link                               |

Add the module first, then paste the link into **Calendar link**. Until one is saved, the
display shows _Add your calendar_. Press **Test calendar link**: it reads the link on
screen, before saving, and lists the next few meetings. Work accounts sometimes have
publishing turned off by an administrator; the test says so when the provider refuses.

Links are accepted only from those providers' calendar hosts. Allowing any URL would make
this a fetch-anything permission, which is a separate decision from adding a calendar.

### Reminders

**Remind me** sets the lead time: 10 minutes by default, from 1 to 60. **Reminder stays**
chooses what happens then:

- **Until the meeting starts** (default) — the countdown holds the display and the
  playlist resumes when the meeting begins. The scheduler holds any interruption for at
  most ten minutes, so a longer lead time returns to the playlist early; the settings
  page warns about this.
- **For one minute** — shows once, then the playlist carries on.

How it works, and why:

- **Reminders are punctual even with a slow poll.** The feed is read every five minutes
  (configurable), but reminders are checked against the cached meetings every 15
  seconds, so a reminder is at most 15 seconds late, not five minutes.
- **A reminder only reaches displays whose playlist includes the calendar.** That is
  how every interruption in this app works: a module cannot take over a display it was
  not given.
- **It survives the per-device cooldown.** If another interruption ended a moment ago,
  the first attempt is dropped; the module asks again on each check, so the reminder
  appears within 30 seconds at worst.
- **It keeps working offline.** If the link stops answering, reminders continue from the
  meetings already read, for up to a day.
- **One at a time.** When two meetings start together, the reminder is for the sooner;
  the next one is reminded once the first starts.

### How fresh is it?

The display asks; the provider does not push. A meeting added in your calendar appears
after the next check — **and** after the provider refreshes the link, which some do less
often than every few minutes. If a meeting added at short notice matters, press
**Test calendar link** after adding one and see how long it takes to appear; that
measures your provider rather than guessing at it.

### What is shown and what is left out

- **Recurring meetings** are expanded properly: daily and weekly rules, skipped dates,
  and single occurrences moved or cancelled, in the time zone the meeting was created
  in. Times are shown in the app's time zone (Settings).
- **All-day entries are left out** — holidays and out-of-office blocks are not meetings.
- **Cancelled meetings are left out.**
- **Declined meetings are left out** if you fill in **Your email**. It is matched against
  the attendee list in the feed on this machine and sent nowhere. Not every provider
  includes attendees in the link (Outlook's published calendars often do not).
- **Where:** a room if the meeting has one; otherwise the call service read from its
  links — Google Meet, Teams, Zoom, Webex and others.
