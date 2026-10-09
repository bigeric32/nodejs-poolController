# AutoSwg guide (DRAFT)

Part 1 says what AutoSwg is for and how to use it. Part 2 is for anyone who wants to understand it after seeing how it is used:
how the numbers are made, what protects the pool when something goes wrong, and how it was tested. Part 3 is for coders. The
non-standard modes (the trip runbook first) are in [MODES.md](MODES.md). The evidence behind the method is in [Method and evidence](METHOD_AND_EVIDENCE.md).

---

# Part 1. What it is for and how to use it

## What AutoSwg is for

AutoSwg helps you run a saltwater pool the Trouble Free Pool (TFP) way. It embraces those methods and does not replace them: you
choose your target FC as the TFP methods describe, you test FC, and you log it in PoolMath. What AutoSwg adds is the part that is
tedious by hand: setting the SWG % so that FC follows your target more closely, using your own test log and your own pool's
chlorine use. When sun, rain or swimmers change how fast chlorine is used, the next test in your log moves the plan.

It is built for two things:

1. **Closer to the FC you want, with less guesswork.** Test and log as usual, press **Check Now**, read the recommendation and
   press **Apply**. AutoSwg sets the SWG % that brings FC to your target, then returns it to the **maintenance %**, the level that
   just holds FC steady. It is semi-automated: you still test, log and press Apply.
2. **Vacations of moderate length with less worry.** Before you go, raise the target and turn on Away protection. While you are
   away, the SWG never drops below what your pool normally uses, the dashboard raises an alert if something stops the chlorinator
   making chlorine, and the plan allows for dilution from heavy rain and for a power outage. When you are back, your first test
   takes FC back to steady state. It is meant for a week or two away, not for replacing testing on a long trip. See
   [MODES.md](MODES.md) for the runbook.

AutoSwg does not suggest a different target, does not replace testing, and has no connection to or endorsement from the TFP
community. It runs on your own controller. The only outside input is your PoolMath log.

## Where it came from

AutoSwg began as a way to make the vacation routine easier: raise the target before you leave, and bring it back down when you
return, without working out the SWG % by hand each time. It was also a way to see what was possible with a pool's own data run
locally on a Raspberry Pi, without depending on external tools such as AI, as a starting point as those capabilities mature,
while embracing the TFP methods and not diverging from them. It has been checked closely on one pool so far, and
[Method and evidence](METHOD_AND_EVIDENCE.md) says what that does and does not show, so you can judge it for yours.

## About this fork

AutoSwg lives in a separate fork of nodejs-poolController (njsPC) and its dashPanel. The defect fixes and the general enhancements
made along the way, the ones that are not part of AutoSwg, will be submitted to the original projects as their owners have time
to look at them. This will remain a separate fork for at least some period of time, so the fixes are here first. AutoSwg itself is
in this fork only. Part 3 lists the defects that have been reported and where.

## What it needs from you

**FC tests must be logged in PoolMath, accurately.** AutoSwg has no other source for FC, so every test goes in the PoolMath app,
and a mistyped reading should be corrected there. Log any **liquid chlorine** you add as "Liquid Chlorine".

**SWG % changes can be logged in either place.** When you apply a recommendation in AutoSwg, or the SWG % is changed some other
way while njsPC is running, AutoSwg records it in its own local log and uses that entry. You can also log SWG changes in
PoolMath, which covers anything the local log does not have, such as a change made while njsPC was off. If both exist for the same
change within an hour, the local one is used.

Turn on sharing for the pool in PoolMath and enter its share code in the AutoSwg settings.

**The minimum to start:** about three FC readings, with SWG entries covering them, within a 21-day period (the Averaging Window).
With less than that it tells you it cannot estimate your consumption yet. A few FC tests a week is workable and daily is ideal.

## Setting it up

Run the defaults for about **three weeks**, testing FC regularly and keeping every SWG change logged, before you tune anything.
The settings come in three groups.

**Facts about your pool (set once):** Pool Volume, SWG Capacity (lbs/day at 100%), the run window (the SWG Schedule, or SWG Run
Start and Stop) and Time Zone. Best practice is to point AutoSwg at the SWG's schedule, so the run window always matches when the
SWG really runs.

**What you want:**

* **Target FC**: the FC you want to hold.
* **Run Periods (days) to Target (FC above target / FC below target)**: how quickly to correct. One run period is one run
  window of the SWG, counted in on-time only. They move in half steps and are never below 0.5. Above target is gentle, since
  consumption does most of the work. Below is quicker, so you recover sooner.
* **Keep FC at the target through the night** (on).
* **Aim Above Target as the Last Test Ages** (0.15 ppm per day, at most 1 ppm).
* **Return to the maintenance % when the target period ends** (off until you turn it on).

**Tuning options (leave alone at first):** Averaging Window, Projection Weighting, the taper, FC Anomaly Tolerance, crediting
liquid chlorine, Night Burn vs Day and the water-temperature adjustment. Part 2 says what each one is for.

## Day to day

1. Test FC and log it in PoolMath, at about the same time of day.
2. Press **Check Now**. It shows a recommended SWG % and the reasons for it, and where the next FC test is likely to read (about
   90% of the time). That range is wide on purpose: part of it is the test itself and part is real day-to-day differences in how
   much chlorine the pool uses (sun, rain, temperature, swimmers). A reading a little off the projection is expected and is not a
   reason to change settings.
3. Press **Apply** to send it to the chlorinator.
4. After the target period, the % returns to the maintenance %, if "Return to the maintenance %" is checked.

## Made easier to use

A number of changes were made so that it is clear what AutoSwg is doing and why, and so that you can check it at a glance.

**On the home panel (the Auto SWG block under the chlorinator)**
* One fact to a line: the % last applied and when, the pending step with its date and time, and when the next automatic check is due.
* Click it for the **Automatic SWG % Status** popup, a wide window with the notes in order and the calculation details expanded.
* Plain colored notes, so you can tell a problem from a note at a glance: red or orange for alerts, blue for information (a target
  that was moved, a change made by Away protection).
* An **Away Mode Active** badge, with the vacation target, while Away protection is on.

**On the settings page**
* The results come in the order you want to read them: the latest calculation first, then what is applied, the pending step and
  the next check, then the calculation details, which open and close and remember which you chose.
* A one-line statement under the run times of what the SWG can make per day at 100% over its run window.
* **Run Periods (days) to Target** in half steps, a **Vacation Target FC** next to Away protection, and tooltips that show the
  live values (for example, the vacation target and the normal target).
* **Check Now: New Target** and **Refresh and Apply** side by side, and the page refreshes itself when a newer calculation is made.
* **Display History** and downloads of the history for looking back.
* The notes explain themselves: why a deadline was kept or moved, what the aim above the target covers, and what Away protection
  did to the % when you turned it on or off.

**Elsewhere in this fork** (not part of AutoSwg, but made along the way)
* Sunrise and sunset times, and schedule offsets, shown with the schedules.
* A chlorinator **Details** view that shows the last message of each kind and when it was last heard, which is how a stalled
  chlorinator link shows up.
* A 24 hour average water temperature on the body card, and a note on the card saying why solar heating is waiting to start.
* A tidier body card (narrower heat settings, a larger temperature and on/off box).

## The rules you live with

These are the rules AutoSwg follows. Each one is named, so the settings and notes can point back to it. Part 2 says how the
numbers behind each are made.

**R1. Targets and deadlines.**
* A new target has a deadline: the moment the SWG has been on for the number of run periods you set, counted from now. A run
  window already underway counts for what is left of it.
* If FC is far above the target and even 0% would not bring it down by then, the deadline moves out to when consumption alone
  gets there. The SWG then stays at 0% until that time.
* If FC is within the **New Target Date Threshold** of the target, a refresh keeps the deadline already in force. Close enough
  counts. A change to the target in force, a Check Now, or FC straying further than the threshold starts a new target instead.
* If even 100% cannot reach the target, the report says so, how long it would take, and what to try first: a longer SWG run
  window, then longer run periods or a lower target.
* **Keep FC at the target through the night.** The target is a floor, and FC is lowest just before the SWG starts. When the
  deadline falls where no SWG run lies before the next start, the plan aims a little higher at the deadline (typically 0.1 to
  0.4 ppm) so FC is still at or above the target at that next start. The calculation says by how much.

**R2. The step back to the maintenance %.**
* When a target period ends, the % returns to the maintenance %, if the checkbox is on. This stops the % you applied to reach the
  target from pushing FC past it until your next test.
* If the end falls while the SWG is off, the step is set for one minute after it next starts, and the pending step shows both
  times.
* Changing the SWG % by hand, or applying anything yourself, cancels the pending step.

**R3. Safety first: a little high is the safer miss.**
* With your last test 3 days old or more, the SWG never runs below the maintenance %.
* The aim rises a little above the target as the last test ages (0.15 ppm per day, at most 1 ppm).
* A correction that would lower the estimated burn needs more proof than one that raises it, and the water-temperature
  adjustment is capped at 15% of the average.
* Only SWG output and liquid chlorine are credited. Other chlorine products are not, so projections run low after a dose of those.

**R4. What AutoSwg tells you.** The AutoSwg area of the dashboard shows alerts for things no recommendation can fix:
* the chlorinator has not answered njsPC for 5 minutes while it should have power (the SWG's power is the SWG schedule's relay,
  so it is silent by design outside its run window);
* the chlorinator reports a fault, or no output while set above 0%, during its run window (for 30 and 45 minutes);
* a planned step did not happen, or an automatic check is overdue or failed;
* njsPC was not running for 25 minutes or more, so the equipment it controls was off;
* none of the temperatures has changed for 15 minutes (the readings stopped arriving);
* the SWG run window read from the schedule looks wrong (over 16 or under 1 hour a day), or the schedule is missing or disabled.

A sharp fall in the salt reading is noted in the recommendation (dilution from rain or a water change). Alerts appear on the
dashboard only: nothing is sent to a phone, so look at it or reach it remotely.

**R5. What is recorded.**
* Every recommendation and apply, with the numbers behind it, and every change to the settings: Show History.
* What the chlorinator actually did, one line an hour, in every mode: `data/autoSwgOutputLog.jsonl`, kept for 18 months.
* The chlorinator's salt reading, and an archive of your PoolMath history.

## Vacations

See [MODES.md](MODES.md). In short: log a test, set the Vacation Target FC, turn on Away protection, and do a dry run beforehand.

## Good habits and limits

* Test FC at about the same time of day, and correct a mistyped reading in PoolMath.
* Only the pool SWG % is managed, not the spa's.
* Do a dry run of anything new, such as Away protection, before you rely on it.
* None of this tests FC for you. Heavy rain, debris or an equipment failure can still lower it.

---

# Part 2. How it works

You do not need this part to use AutoSwg. It is for anyone who wants to understand it after seeing how it is used.

## Overview in plain words

AutoSwg works out how much chlorine your pool actually uses from your own log: what FC did between tests, minus what the SWG
made. From that daily use it works out two numbers: the **maintenance %** (the SWG setting that just replaces it) and the
**recommended %** (the setting that moves FC to your target by the deadline). Between tests it projects where FC probably is now,
but it trusts that projection less the older your last test is. Everything else in the guide is a rule about when to use which
number, plus protections for when something goes wrong.

## The SWG calculations

1. **What your SWG produced.** Each SWG entry (a % held for some run hours) is turned into ppm of FC for your pool volume, using
   the SWG Capacity. For a 12,000 gallon pool with a 1.47 lb/day cell, 100% for 24 hours makes about 14.7 ppm, so 100% over a
   7.67 hour run window makes about 4.69 ppm per day.
2. **What your pool consumed.** Between two FC readings, consumption is the SWG output plus any liquid chlorine added, minus the
   change in FC. Averaged over the Averaging Window (21 days), that is your daily burn in ppm per day. Chlorine is lost mostly in
   daylight, so a part of a day is weighted by the daylight share: every whole 24 hours counts as one day, and only the leftover
   is prorated.
3. **Where FC is now.** FC is only measured now and then, so the current value is projected from your last reading: the last
   reading plus a weight times (SWG output since then minus burn times time), plus any liquid chlorine added since. The weight
   is 0.5 for 3 days and falls to 0 by 8 days.
4. **The two numbers you see.** The maintenance % is the burn divided by what 100% makes: with a burn of 1.10 ppm per day and
   4.69 ppm per day at 100%, that is 23.4%. The recommended % is what moves the projected FC to the target at the deadline.

**A worked example** (this pool, Oct 9): projected FC 9.48 ppm, target 8, a deadline two run periods away (1.48 days of
consumption, burn 1.10 ppm per day) and a 0.63 ppm aim above the target at the deadline so FC is still at 8 when the SWG next
starts. FC needs to end 0.63 ppm above 8, so it has to fall 0.85 ppm, while consumption will take 1.63 ppm: the SWG must make
0.78 ppm. Two run windows at 100% would make 9.35 ppm. So the recommended % is 0.78 / 9.35, about 8.3%. After the deadline the
plan steps to the maintenance 23%.

**Readings at different times of day.** FC does not read the same all day, so two readings are rarely a whole number of
"chlorine-use days" apart. AutoSwg prorates the leftover part of a day by where it falls on a daylight curve (about 56% of a
day's loss in daylight in winter, 78% in summer), and counts SWG output only for run-window hours that have passed. It is an
approximation, and tests at similar times of day compare best.

## Protections designed in

AutoSwg is built so that its failures are small and visible, and so that when it is unsure it errs toward FC a little high.

* **A projection that fades.** The more time since your last test, the less of the model is applied, down to none by 8 days.
* **A floor when readings are old.** After 3 days without a test, the SWG never runs below the maintenance %.
* **A margin that grows with age.** The aim rises above the target by 0.15 ppm per day since the last test, to at most 1 ppm.
* **Bad data is left out.** An FC rise the SWG and logged additions cannot explain by more than the tolerance (usually an
  unlogged addition or a mistyped reading) is left out of the average, and the report says so.
* **Timing is counted in SWG on-time**, so a deadline can never fall in a stretch when the SWG cannot act, and the step back to
  the maintenance % is moved to one minute after the SWG next starts when it would fall while the SWG is off.
* **Nothing changes the SWG % without a clear path.** Only Apply, the step back to the maintenance %, and the optional modes set
  the %. A manual change by hand cancels a pending step.
* **Watching the equipment.** The alerts in R4 cover the chlorinator, the schedule that powers it, the checks, outages and the
  temperature feed.
* **Recording what actually happened.** The hourly output log lets the output the SWG really made be compared with what the plan
  assumed.
* **Recovery by itself.** If the polling of the chlorinator stalls, njsPC limits that cycle to 30 seconds, resets the serial
  port, logs a severe error and posts a message, then polls again.
* **Away protection** has its own limits (see [MODES.md](MODES.md)): a floor at the maintenance %, a cap on the storm and outage
  extra, a 3-day limit on any one event, an end on the first new FC reading, and a return to your normal target.

## How it was tested

The calculation was scored on history, and the protections were exercised against real failures and checked on the live system.

* **Scored on history.** The calculation is re-run as of each past FC reading, using only what was known then, and compared with
  the next reading, on 61 scorable readings from this pool, against the baseline "FC unchanged". The numbers are in
  [Method and evidence](METHOD_AND_EVIDENCE.md).
* **Checked independently.** The run-period deadline rule and the overnight floor were checked against simulations built apart
  from the code.
* **Dry runs on the live pool.** Restart behavior (the schedule turns the SWG relay on), the SWG % reaching the chlorinator after
  a setpoint change, a serial port reset in the middle of a poll, the SWG relay going off and on again, and Away protection on
  and off with its target, notes and badge.
* **Real failures, studied from the logs.** Each is below with what was found and what was added.

| Failure | What was found | Protection added |
|---|---|---|
| Overnight Wi-Fi loss (Oct 4) | The link to the relay manager dropped, its relay latches expired, and the pump stopped | The relay manager link runs on the same machine; Wi-Fi locked to 2.4 GHz; a watchdog restarts networking and reboots if it stays down |
| Temperatures stopped changing (Oct 6) | The sensor feed went over a network link that dropped | The feed uses the local link; an alert when no temperature changes for 15 minutes |
| The SWG stopped being controlled (Oct 7) | A poll message queued while the serial port was reset was never sent, so polling stopped for good and the SWG ran at its own setting | The queue restarts when the port reopens; a 30 second limit per poll cycle that resets the port; an alert when a powered chlorinator is silent for 5 minutes |
| njsPC froze for 12 seconds (Oct 7) | The whole process stopped, the pump and SWG relays dropped for a few seconds, and the SWG power cycled | Traced to a likely SD card write stall; high-endurance SD card and lower logging; the stalled-poll recovery above |
| SWG schedule start set against sunset (Oct 8) | The run window AutoSwg read was about 20 hours, which skews every figure | An alert when the window is over 16 or under 1 hour, or the schedule is missing or disabled |
| An unlogged rise in FC (Oct 6 to 7) | 3.3 ppm that the SWG could not have made, since nothing ran overnight | Logged as a liquid chlorine entry so the burn is not understated; the anomaly check flags such rises |

## Resilience defects found and reported

Several resilience defects were found during this testing. Each was reported to the owner of the code involved, with a fix or an
analysis. The details, including the logs and the discussion, are in the issue logs of the original repositories:
[nodejs-poolController issues](https://github.com/tagyoureit/nodejs-poolController/issues) and
[Relay Equipment Manager issues](https://github.com/rstrouse/relayEquipmentManager/issues). A list with the status of each is in
Part 3, for coders.

## The tuning calculations

* **Averaging Window (21 days).** Long enough to smooth a few days of unusual weather, short enough to follow the season. On the
  pools checked, 21 to 56 days were indistinguishable and 7 to 14 trended worse.
* **Projection Weighting (50%) and the taper (3 to 8 days).** Between tests a reading varies by about a ppm, and FC moves less
  than a model that trusted every number would predict. Applying half the modelled change predicted better than all of it, and
  better than assuming FC had not changed. The model helps for gaps up to about five days and hurts beyond that.
* **FC Anomaly Tolerance (2 ppm), Credit liquid chlorine (on).** Without the credit, the rise from a dose would be counted as
  SWG output and the burn would come out too low.
* **Night Burn vs Day (0.5), Daytime Share (automatic).** How much of a day's consumption falls in daylight.
* **Adjust the burn for the water temperature (off).** Did not improve the projection on the pool it was tried on, so it is an
  option, capped at 15%.

**The tools.** **Projection Accuracy** re-runs the calculation as of each past reading and shows the average error, how often it
was within 1 and 2 ppm, and the same for "FC unchanged". **What-If Sweep** scores alternative settings on the same readings, and
calls one better or worse only when its 90% range excludes zero. **Tune** runs both and gives one recommendation. All of them
score history, so a change shows only as new readings arrive; that is why Tune waits for about 10 new readings before tuning again.
The tuning options appear only after at least 15 scorable FC readings over at least 42 days.

**What was tried and set aside:** a shorter window, water temperature in the burn, a state estimator, sunlight, air temperature
and rain as inputs, a nearby weather station, and crediting dilution from water changes. A change has to beat the current numbers
on the same readings with a range that excludes zero, and the variation between a projection and the next test is larger than
most of these effects. The reasons and numbers are in [Method and evidence](METHOD_AND_EVIDENCE.md).

## Settings reference

| Setting | Default | What it feeds |
|---|---|---|
| Pool Volume | 12000 gal | Capacity and every ppm figure |
| SWG Capacity | 1.45 lbs/day | Capacity (R1, the maintenance %) |
| Target FC | 9.0 ppm | The target (R1) |
| Run Periods to Target, above / below | 3 / 1 | The deadline (R1) |
| Keep FC at the target through the night | on | The overnight aim (R1) |
| Aim Above Target as the Last Test Ages | 0.15 ppm per day, at most 1 | The margin (R3) |
| Return to the maintenance % | off | The step (R2) |
| New Target Date Threshold | 1 ppm | Kept or new target (R1) |
| Averaging Window | 21 days | The burn |
| Projection Weighting, taper | 0.5, 3 to 8 days | The projection |
| FC Anomaly Tolerance | 2 ppm | Data left out |
| Credit liquid chlorine | on | The burn |
| Night Burn vs Day | 0.5 | Daylight share |
| Adjust the burn for the water temperature | off | The burn |
| Vacation Target FC, Storm or outage adds at most | normal target plus 2, 20 points | Away protection ([MODES.md](MODES.md)) |

---

# Part 3. For coders

Where the code is, what was found and fixed along the way, and how to check your own changes. You do not need this to use AutoSwg.

## Resilience defects reported to the original repositories

Found during this testing and reported with a fix or an analysis. Status as of Oct 9, 2026. The full discussion of each is in the
issue log of its repository. The defect fixes and the general enhancements will be submitted to the original projects, as noted in
"About this fork" above; until then they are in this fork.

| Where | Defect | Status |
|---|---|---|
| [njsPC #1247](https://github.com/tagyoureit/nodejs-poolController/issues/1247) | Sunrise and sunset schedules do not work correctly after a restart | The owner has a fix on a feature branch; testing pending |
| [njsPC #1248](https://github.com/tagyoureit/nodejs-poolController/issues/1248) | The solar heater fails to resume after a restart and can shut off early near the setpoint | The owner has a related fix on that branch; testing pending |
| [njsPC #1249](https://github.com/tagyoureit/nodejs-poolController/issues/1249) | The Cool Point option does not appear in the heat mode picklist | Fixed and merged |
| [Relay Equipment Manager #124](https://github.com/rstrouse/relayEquipmentManager/issues/124) | Relays are not turned off on a clean shutdown | Fixed and merged, with a SIGTERM handler |
| [Relay Equipment Manager #125](https://github.com/rstrouse/relayEquipmentManager/issues/125) | The SSDP server fails on hosts with more than one network interface | Fixed; verified here with a second interface |
| [Relay Equipment Manager #126](https://github.com/rstrouse/relayEquipmentManager/issues/126) | Relays flicker when REM restarts while njsPC is running (unserialized read-modify-write) | Fixed by the owner; confirmation pending |
| [njsPC #1250](https://github.com/tagyoureit/nodejs-poolController/issues/1250) | The chlorinator RS485 diagnostic view misses commands sent to it | Closed by the owner; kept in this fork |

## Found and fixed in this fork, not yet submitted upstream

* **The stalled chlorinator poll.** A message queued while the serial port is reset (the 10 second inactivity reset) is left in
  the queue and nothing restarts the queue, so the poll waits for it forever and no further poll is scheduled. Fixed in
  `controller/comms/Comms.ts` (the queue restarts when the port reopens) and `controller/nixie/chemistry/Chlorinator.ts` (a 30
  second limit on a poll cycle, which resets the port, logs a severe error and posts a message).
* **Duplicate "turn on" commands to a solar heater.** `syncHeaterStates()` sends a command on every pass while a heater should be
  on, with no check for one already in flight. A fix that allows one command in flight per heater is on `fix/heater-command-inflight`;
  a report is drafted.

## Where the AutoSwg code is

| File | What is in it |
|---|---|
| `controller/AutoSwgService.ts` | The calculation (`computeRecommendation`): capacity, burn, projection, targets and deadlines, the overnight floor |
| `controller/AutoSwgWatch.ts` | The alerts and their thresholds |
| `controller/AutoSwgHistory.ts`, `AutoSwgOutputLog.ts`, `AutoSwgAutoTune.ts` | History and the logged settings, the hourly output log, auto tune |
| `controller/Equipment.ts` (class `AutoSwg`) | The settings, their defaults, and the Away protection status |
| `controller/State.ts` (class `AutoSwgState`) | The saved calculation and apply state shown on the dashboard |
| `web/services/state/State.ts` | The flows: Check Now, apply, the step, the automatic check, Away protection, the alert watch |
| `web/services/config/Config.ts` | The settings routes |
| dashPanel `scripts/config/autoSwg.js`, `scripts/chemistry.js` | The settings page, the home panel and the status popup |
| `tools/autoswg-check/` | The standalone script and these documents |

## Checking changes

* **Behavior.** `python autoswg_check.py <share code> --report accuracy` (or `whatif`) re-runs the calculation on a pool's
  PoolMath history without njsPC. See the [README](README.md).
* **Build.** njsPC is TypeScript: `npm run build`. dashPanel is plain browser JavaScript with no build step; a syntax error shows
  only as a browser console error, so load each changed script in a browser before pushing.
* **On the pool.** Do a dry run on the real system, as in [MODES.md](MODES.md), and read the njsPC log for lines that begin
  `AutoSwg:`, `SEVERE` and `Inactivity timeout`.
