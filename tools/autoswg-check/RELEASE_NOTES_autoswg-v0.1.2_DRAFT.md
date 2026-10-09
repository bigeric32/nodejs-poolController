# AutoSwg % - v0.1.2 (njsPC, dashPanel and REM)

DRAFT for review. Nothing here has been posted. Commit ids are the ones I expect to tag; they are confirmed at tag time.

This replaces `autoswg-v0.1.0` and `autoswg-v0.1.1` for everyone testing AutoSwg %. All three repos are tagged `autoswg-v0.1.2`, and
they need to be used together.

**AutoSwg % is a local, data-based helper for keeping your pool's FC near a target you set.** It runs on your own controller. It reads
your PoolMath log, works out how much chlorine your pool really uses, and recommends a percentage. It also keeps extra detail locally
(every recommendation and apply with the numbers behind it, your SWG % changes, and a longer archive of your PoolMath history) and uses
that to tune the calculation to you and your pool's own behavior. You choose the target, you review each recommendation, and you press
Apply. Start with `tools/autoswg-check/QUICK_GUIDE.md` in the njsPC repo; it has a one-page guide and an advanced section on how it
calculates.

It has two goals. The first is semi-automated SWG changes that follow your PoolMath test logs while you are in town: you test and log
FC, press Check Now and Apply, and the % follows your tests and returns to the steady maintenance level on its own. The second is FC
safety while you are on vacation, and a smooth recovery to steady state when you are back: raise the target and test before you leave,
a floor at the maintenance % and dashboard alerts while you are away, and a way down (or up) to your usual target from your first test
when you return. It also began as a way to see what was possible with a pool's own data run locally on a Raspberry Pi, without depending
on external tools such as AI, as a starting point as those capabilities mature, while embracing the Trouble Free Pool methods and not
diverging from them. It has been checked closely on one pool so far; `tools/autoswg-check/METHOD_AND_EVIDENCE.md` gives the formulas,
what was measured, what was tried and not adopted, and the known limits, so you can judge it for yours.

## What you need

- **A Nixie (virtual) controller setup.** It has been tested on one; it has not been tested against a chlorinator managed by a
  physical panel.
- **Node.js 22 or newer.**
- **A PoolMath account with sharing turned on for the pool**, and its share code (for example `tfp-123456`).
- **FC tests and every SWG % change logged in PoolMath.** FC must be in PoolMath and logged accurately; SWG changes can be logged there
  or made through AutoSwg, which keeps its own record. The minimum to start is about three FC readings with SWG entries covering them
  within 21 days. Run the defaults for a few weeks first: the tuning options appear on their own once there is
  enough history (see below).

## Getting the right versions

| Repo | Check out | Commit |
|---|---|---|
| `nodejs-poolController` (bigeric32 fork) | tag `autoswg-v0.1.2` | `5568553a` |
| `nodejs-poolController-dashPanel` (bigeric32 fork) | tag `autoswg-v0.1.2` | `b6a05b8` |
| `relayEquipmentManager` (bigeric32 fork) | tag `autoswg-v0.1.2` | `09bb1d5` |

```bash
git fetch --tags
git checkout autoswg-v0.1.2
npm ci
npm run build
```

Do that in each repo, then restart them (REM first, then njsPC, then dashPanel). In REM, the native hardware modules (`epoll`,
`i2c-bus`, `spi-device`, `@bratbit/onoff`) are built during `npm ci`; if npm reports their install scripts as blocked, run
`npm rebuild`. Coming from v0.1.0 or v0.1.1, your saved AutoSwg settings carry over, and settings that were renamed are migrated at
startup.

## 1. AutoSwg: what is new since v0.1.1

- **Better projection of where FC is now.** Only part of the modelled change since your last reading is applied (50% by default),
  fading to nothing for readings more than a few days old. Defaults: 21-day averaging window, 50% weighting, taper 3 to 8 days.
- **Readings at different times of day are prorated** by daylight, so a morning test and an evening test compare fairly.
- **Liquid chlorine you log in PoolMath is credited**, and odd FC rises the SWG and logged additions cannot explain are flagged and
  left out of the average.
- **Up to 18 months of PoolMath history** are kept locally and used by the reports.
- **A long gap between FC tests is safe.** When the last FC reading is 3 or more days old, AutoSwg never recommends less than the
  maintenance %, so a trip runs at about the level that matches consumption instead of holding the SWG at 0% while it waits for FC
  to drift down. Running a little high is the safer miss.
  A target whose FC is within the New Target Date Threshold of the target keeps its deadline, and the SWG steps to the maintenance %
  then; only a replaced target has its deadline moved out when consumption alone has to bring FC down.
- **The tuning tools appear when there is enough history.** Tune (one recommendation at a time), Projection Accuracy, What-If Sweep and
  How to Tune show once there are at least 15 FC readings the reports can score, over at least 42 days with SWG history behind them. Until
  then a note on the AutoSwg page shows how far along it is.
- **Where the next FC test is likely to read.** Each check shows a range (about 90%) beside the projected FC. It is the variation to
  expect between a projection and the next test: part is the test itself and part is real day-to-day differences in consumption (sun,
  rain, temperature), which are hard to project without something like a personal weather station.
- **Aim above the target as the last test ages.** A new setting, 0.15 ppm per day by default (at most 1 ppm, 0 to turn it off), raises
  the aim of the % that reaches the target as your last FC reading gets older. FC a little high is the safer miss. It does not change
  the maintenance %, the target date or the projection.
- **More in Projection Accuracy.** The bias with its uncertainty, how often the range held, and how often the measured FC was more than
  1 ppm below or above the projection.
- **An optional water temperature adjustment of the burn** (off by default; it did not improve the projection on the pool it was tried
  on). What-If Sweep scores it for yours once there are enough temperatures logged.
- **A method and evidence page** (`tools/autoswg-check/METHOD_AND_EVIDENCE.md`).
- **Alerts in the AutoSwg area of the dashboard for an SWG that is not holding FC.** The chlorinator reports a fault, or no output while
  the SWG is set above 0%, during its scheduled run window; a planned step to the maintenance % did not happen; or njsPC was not running
  for 25 minutes or more, so the pool equipment it controls was off (it says when the computer restarted, which points to a power loss);
  or none of the air, water or solar temperatures has changed for 15 minutes or more (sensors that report fractions of a degree), which
  means the readings stopped arriving. Nothing is sent to a phone; the alerts are on the dashboard.
- **A note when the chlorinator's salt reading falls sharply,** which usually means the pool was diluted by rain or a water change, so
  some of the FC lost may not be consumption. The reading is also logged locally, once an hour, and salt additions you log in PoolMath
  are counted. On its own, nothing is adjusted for it.
- **Away protection, for trips (any mode, off until you turn it on).** Set the vacation target, check the box and save to start it. While
  it is on, AutoSwg checks PoolMath every 12 hours and may raise the SWG % to make up for FC lost to a sharp fall in the salt reading
  (dilution) or an outage (njsPC not running, so the equipment was off). It applies the glide up to the vacation target you set (not limited) and never goes below the maintenance %; the extra for
  dilution or an outage is limited to a number of points you set (20 by default), acts only when the last FC test is 3 or
  more days old, and one event acts for at most 3 days. It requires "Return to the maintenance %" so each boost ends by itself. It takes
  over from Auto-Apply, the automatic check and auto tune while it is on (their settings are kept, grayed out). It ends when you uncheck
  it and save, or by itself when a new FC reading is logged in PoolMath after it was turned on. This is not a replacement for testing.
- **The chlorinator's actual output is logged, hour by hour, at all times** (every mode, inside the run window or not), kept for 18 months:
  the set %, the output it reported, the minutes it was producing, any status other than OK, the salt reading and whether it stopped
  reporting. It changes no calculation; it is the record of whether the SWG made what the plan assumed, and a summary of it is written when
  Away protection ends.
- **The red "automatic change exceeded threshold" banner is only for the periodic automatic check.** With Auto-Apply on, a button you press (Check Now,
  Refresh, Refresh and Apply) is your own action: it applies at once and never raises the banner, whatever the size of the change. The banner, for changes
  nobody asked for at that moment, now has a Dismiss button.
- **Changing the Target FC starts a new target.** Refresh and Apply and the automatic check used to stay on course for the previous apply's target
  whenever the projected FC was within the New Target Date Threshold of the new one, so a changed Target FC was ignored and the pending step kept
  naming the old target. A Target FC that differs from the last apply's now starts a new target (Refresh: Adjust % still stays on the in-flight one).
- **The "even at 100%" warning suggests extending the SWG hours.** When 100% cannot reach the target within the run periods to target, the warning now says how many
  SWG hours a day would (for example about 13 hours a day against 7.8 now) before you change the target, or that even 24 hours would not.
- **Smaller corrections.** The water temperature adjustment may move the burn by at most 15% (it was 30%). A target date that was moved out because FC is
  above the target now follows the same day and night weighting as the projection, a couple of hours earlier than plain clock days. The history record of an
  apply now shows the step that apply set (not the previous one), and its previous SWG % is the last applied one (it read 0 right after a restart).
- **A pending step that would fall while the SWG is off waits for it.** When the target period ends outside the SWG's run window, the return to the
  maintenance % is set for one minute after the SWG next starts (the new % first matters then), and the pending step shows that time.
- **"Days to Target" is now "Run Periods to Target".** One run period is one SWG run window, counted in on-time, in half steps (0.5 at least). The deadline is the moment the
  SWG has been on for that many run windows from now, and the plan counts exactly that production and the day/night-weighted consumption up to then. A saved number
  carries over as it is (1 day is 1 period). A pending step that would fall while the SWG is off shows both times.
- **The plan keeps FC at the target through the night.** The target is a floor, and FC is lowest just before the SWG starts. When the deadline falls where no SWG
  run lies before the next start, the plan aims a little higher at the deadline (typically 0.1 to 0.4 ppm) so the overnight low stays at the target. A checkbox
  ("Keep FC at the target through the night", on) turns it off. A target period that holds no SWG run time now says so instead of quietly keeping the maintenance %.
- **Night Burn vs Day (0.5), a new tuning setting.** How much chlorine the pool uses at night compared with the same hour of daylight (0.5 is the usual figure
  for a well-kept pool). It replaces the fixed day-length model behind the daytime share (about 66% against 68% at your day length). Tune scores 0.25, 0.75 and 1
  and says plainly when the history cannot tell them apart.
- **PoolMath is read at least once a day, in every mode,** so new tests and logged salt additions are picked up even when no check is run.
- **Vacation guidance** in the quick guide: before, during and after, including how the first test after you return takes FC back to
  steady state.
- **Return to the maintenance %, as a checkbox.** "Return to the maintenance % when the target period ends" (off until you check it) is the
  one of the two things AutoSwg does by itself (the other is Away protection, above), and only a convenience: a target period often ends between your FC tests, and when it does the SWG %
  goes back to the steady level that just holds FC, to keep you from undershooting or overshooting your target in between. Applying
  anything yourself, or changing the SWG % by hand, cancels the pending return.
- **Show History** records every apply with what triggered it (Check Now, a reviewed Apply, Refresh: Adjust %, or the step to the
  maintenance level), whether the target date was kept or replaced, how far FC was from the target, and every change you make to
  the AutoSwg settings. History downloads (CSV and JSON) include these and leave out your share code.
- **Settings screen:** the Save button enables only when something changed, and a Tune or report that saves settings tells you what
  it saved.
- **Chlorinator communications recover by themselves.** A message queued while the RS485 port was being reset (the 10 second inactivity reset) could be left
  waiting forever, which stopped njsPC polling the chlorinator until a restart; the queue now restarts when the port reopens. A chlorinator poll that stalls
  for 30 seconds resets the port and starts over, logs a SEVERE error and posts a dashPanel message, and a dashboard alert is raised when a powered chlorinator
  has not answered for 5 minutes. A change to the Run Periods to Target alone now starts a new target, as a changed Target FC does.
- **A wrong SWG schedule is flagged.** AutoSwg takes the SWG run window from the schedule it follows, and a start set against the wrong sun event gave a ~20 hour window
  that skewed every figure without any sign. A dashboard alert now appears when the window is longer than 16 or shorter than 1 hour, or when the schedule is missing or disabled.
- **Getting started and limits** are in the quick guide: only SWG output and liquid chlorine are credited, so other chlorine products
  (cal-hypo, dichlor, trichlor) are not; only the pool SWG % is managed.

## What else is in this tag: the other four groups

The tag also carries changes that are not part of AutoSwg itself. They are grouped by how AutoSwg relates to them, so each can be
reviewed, and proposed upstream as its own pull request, on its own. (The AutoSwg changes themselves are the group above.)

### 2. Needed by AutoSwg, and not yet in the owners' repositories

AutoSwg reads your SWG schedule's run window and today's sunrise and sunset, so it relies on these njsPC fixes (issue
`tagyoureit/nodejs-poolController#1247`):

- the heliotrope (sunrise and sunset) is initialized and synced at start-up;
- a schedule that ends at sunset no longer takes tomorrow's sunset;
- a failed schedule window calculation is no longer cached.

The project owner has a branch for these (`feature/schedule-execution-hybrid`) that is not merged yet; if it lands, these drop out of
this tag.

### 3. Bug fixes AutoSwg does not need, recommended

These fix start-up and schedule behavior that AutoSwg runs alongside. The pool runs better with them; AutoSwg works without them.

- Nixie relays are re-triggered after a restart (#1247): the saved on/off state of circuits, features and bodies is cleared at boot on a
  Nixie controller, so a schedule that is still active turns its relay back on. SIGTERM handling is the owner's own change, which this
  tag uses as is.
- A schedule's heat setpoint is no longer re-pushed on every restart (#1247).
- The saved on/off state of the virtual circuits (solar, heater, freeze) is cleared at boot on a Nixie controller, so a stale "on"
  no longer drives a relay for a few seconds after a restart.
- Dependency updates in all three repos, which clear most of the reported vulnerabilities (one in `ip` through `node-ssdp` remains,
  as its fix is a breaking upgrade). REM's lockfile carries a newer `nan`, which Node 22 needs to build its hardware modules.
- REM: the relay-shutdown and SIGTERM fixes are the project owner's, from `rstrouse/relayEquipmentManager` master
  (#124); this tag adds only the dependency updates and the script approvals above. The earlier `fix/relay-shutdown` branch is
  superseded.

### 4. Enhancements AutoSwg does not need, recommended, related to AutoSwg

These show what AutoSwg is working from or doing.

- The RS485 diagnostic view records commands sent to the chlorinator, including Nixie's own (#1250), and dashPanel has a Details
  popup of the latest RS485 messages for the chlorinator. It is where a change of the SWG % shows up on the wire.
- dashPanel shows today's sunrise and sunset beside the Schedules title, and the sunrise and sunset offsets of a schedule: the
  times AutoSwg's daylight weighting and run window come from.

### 5. Other fixes and enhancements, recommended, not related to AutoSwg

These are solar heating changes. They are in the tag because they have been in use alongside it.

- Solar: a stale reheat guard is cleared at boot, and the water temperature is truncated for the on/off decision (#1248).
- The Cool Point option appears in the heat mode list for solar heaters with nocturnal cooling (#1249), and dashPanel has a Nocturnal
  Cooling toggle in the heat settings popup.

**Not in this tag.** More solar work and a water temperature display change are on their own branches, to be proposed as separate pull
requests, and are not part of `autoswg-v0.1.2`: the solar settle delay and hysteresis with a solar log and its analysis tool, the
Solar Controls and the "why solar is waiting" note on the body card, a 24 hour average water temperature on each body card, and a fix
that sends one command at a time per Nixie heater.

## Known limitations

- Only SWG output and liquid chlorine are credited as chlorine added.
- The evidence for the calculation comes from one pool; the method and evidence page says what that does and does not show.
- Relays controlled by REM switch off when REM stops cleanly, including during a restart.
- A REM restart while njsPC is running can make several relays flicker briefly (`rstrouse/relayEquipmentManager#126`).
- Both njsPC and REM were built and tested on one setup (a Raspberry Pi, Node 22).

## Reporting what you find

Please send, rather than your share code or raw readings: the Tune result or the Projection Accuracy numbers, your Show History
download (the JSON and CSV leave out the share code), and the njsPC log lines around anything unexpected. Say what controller and
SWG model you have.

---

## Text to add to the older releases (replaces nothing; one line at the top of each)

For `autoswg-v0.1.0` and `autoswg-v0.1.1`:

> **Update:** this release is superseded by `autoswg-v0.1.2`, which covers njsPC, dashPanel and REM. The REM branch named below,
> `fix/relay-shutdown`, is no longer needed: its fix is in the REM project's master and in the `autoswg-v0.1.2` REM tag.
