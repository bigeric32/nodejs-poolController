# AutoSwg quick guide

## What it is for

AutoSwg is a local, data-based helper for keeping your pool's FC near a target you set. It is built around two goals.

**1. Semi-automated changes that follow your PoolMath test logs while you are in town.** Test FC, log it in PoolMath, press
**Check Now** and then **Apply**. AutoSwg works out how much chlorine your pool really uses from your own log and sets the SWG %
that brings FC to the target. When the target period ends, the % returns by itself to the **maintenance %**, the level that just
holds FC steady (the "Return to the maintenance %" checkbox, which is off until you turn it on). You still test, log and
press Apply; there is nothing to babysit between tests and no arithmetic to do, and each new test in your log moves the plan.

**2. FC safety while you are on vacation, and a smooth return to steady state when you are back.** Raise the target and test
before you leave. While you are away, the SWG never runs below the maintenance % once your last test is 3 days old, and the
AutoSwg area of the dashboard raises an alert if the chlorinator is not producing, a planned step did not happen, njsPC was not
running, or the salt reading fell sharply (dilution from rain). When you are back, your first test sets the way to your usual
target and then back to the maintenance %, again without hand calculations. See "Vacation: before, during and after" below.

How it works: it runs on your own controller, reads your PoolMath log, works out how much chlorine your pool really uses, and
recommends the SWG % that keeps FC near the target. It also keeps extra detail locally (every recommendation and apply with
the numbers behind it, your SWG % changes, and a longer archive of your PoolMath history) and uses that to tune the
calculation to you and your pool's own behavior. When weather, bather load or sunlight change that usage, the next check
adjusts the % to follow it. You choose the target, you review each recommendation, and you press Apply.

## Where it came from

AutoSwg began as a way to make the vacation routine easier: raise the target before you leave, and bring it back down when you
return, without working out the SWG % by hand each time. It was also a way to see what was possible with a pool's own data run
locally on a Raspberry Pi, without depending on external tools such as AI, as a starting point as those capabilities mature,
while embracing the Trouble Free Pool methods and not diverging from them. You test FC and log it in PoolMath, you choose the
target FC the way those methods do, and AutoSwg only helps get the SWG to that target and hold it. It does not suggest a
different target or replace testing. The calculation runs on your own controller; the only outside input is your PoolMath log.
It has been checked closely on one pool so far, and "Method and evidence" says what that does and does not show, so you can judge
it for yours.

## What it needs from you

**FC tests must be logged in PoolMath, accurately.** AutoSwg has no other source for FC, so every test goes in
the PoolMath app, and a mistyped reading should be corrected there. The tool only works as designed when the FC
log is right. Also log any **liquid chlorine** you add, as "Liquid Chlorine".

**SWG % changes can be logged in either place.** When you apply a recommendation in AutoSwg, or the SWG % is
changed some other way while njsPC is running, AutoSwg records it in its own local log and uses that entry.
You can also log SWG changes in PoolMath, which covers anything the local log does not have, such as a change
made while njsPC was off. If both exist for the same change within an hour, the local one is used.

Turn on sharing for the pool in PoolMath and enter its share code in the AutoSwg settings.

**The minimum to start:** about three FC readings, with SWG entries covering them, within a 21-day period (the
Averaging Window). With less than that it tells you it cannot estimate your consumption yet. A few FC tests a
week is workable and daily is ideal, and more readings make the recommendation steadier.

## Day to day

1. Press **Check Now**. It shows a recommended SWG % and the reasons for it, and where the next FC test is likely to read
   (about 90% of the time). That range is wide on purpose. It is the variation to expect between a projection and the next test: part is the
   test itself, and part is real day-to-day differences in how much chlorine the pool uses (sun, rain, temperature,
   swimmers), which are hard to project without something like a personal weather station. A reading a little off the
   projection is expected and is not a reason to change settings.
2. Press **Apply** to send it to the chlorinator.
3. After the target period, the % returns to the **maintenance %**, the level that just holds FC steady, if
   "Return to the maintenance %" is checked (it is off until you turn it on). That is what makes it semi-automated: you test, log and
   press Apply, and the rest of the plan, including the step back, happens on its own.

## Vacation: before, during and after

**Before you leave**
1. Log an FC test the day you leave. A recent reading is the best starting point for everything below.
2. Raise **Target FC** by a ppm or two, with a short **Days to Target (FC below target)**, and press Check Now, then Apply.
   FC builds toward the higher target and then holds near it.

**While you are away**
* With your last test 3 days old or more, the SWG never runs below the maintenance %. A long absence runs at about the level
  that matches consumption, and running a little high is the safer miss. The card says when this applies.
* The AutoSwg area of the dashboard shows an alert for things no recommendation can fix: the chlorinator reports a fault
  (low flow, low salt, clean cell, communication lost and so on) or no output while the SWG is set above 0% during its scheduled run
  window; a planned step to the maintenance % did not happen; njsPC was not running for 25 minutes or more, so the pool equipment
  it controls was off (it says when the computer restarted, which points to a power loss, and shows once njsPC is running again);
  or none of the air, water or solar temperatures has changed for 15 minutes or more (the readings stopped arriving, so solar
  heating and the 24 hour water average are working from old values; this applies to sensors that report fractions of a degree,
  such as REM's). Alerts appear on the dashboard only: nothing is sent to a phone, so look at it, or reach it remotely if you have set that up.
* A sharp fall in the chlorinator's salt reading is noted in the recommendation: the pool was probably diluted by rain or a
  water change, and some of the FC lost may not be consumption. On its own, nothing is adjusted for it.
* **Away protection (optional, off until you turn it on for a trip).** In the settings, under "Vacation: Away protection",
  set your vacation **Target FC** (a normal 7 might become 10), check the box and **save the settings**: saving starts it. Log
  your last FC test before you save, because a test logged afterward ends it (see below). While it is on, AutoSwg checks
  PoolMath every 12 hours by itself and applies the SWG % that glides the projected FC up to your vacation target, after which
  the return to the maintenance % lets it coast. The glide is not limited. On top of that it may add chlorine to make up for FC
  lost to a sharp fall in the salt reading (dilution) or to an outage (njsPC was not running, so the equipment was off). That
  extra is limited: it adds at most the "Storm or outage adds at most" points you set (20 by default) to the % the plan
  would have used anyway, only when your last test is 3 days old or more, and one event acts for at most 3 days. The SWG % never
  goes below the maintenance %, and Away protection needs "Return to the maintenance %" so each boost ends by itself. Away
  protection takes over from Auto-Apply, the automatic check and auto tune while it is on: their settings are kept and shown
  grayed out, but they do not act. **It ends when you uncheck it and save, or by itself when a new FC reading is logged in
  PoolMath after you turned it on**, so if you forget to turn it off, your first test when you are back does it, and your other
  settings then apply again. A note on the card says when it is on. This is the one case, besides the return to the maintenance %,
  where AutoSwg changes the SWG % without you pressing Apply, and it only does so while you have turned it on.
* **What is recorded for looking back.** Every check while you are away is in Show History (what it recommended, what it
  applied, and the numbers behind them, including the projected FC with and without the storm and outage correction). When Away
  protection ends, one more record summarizes the period: the checks, the lowest and highest % applied, the outages, the alerts
  seen, the last check's projection and the reading that ended it. Alerts raised and cleared are also written to the njsPC log. Separately, in every mode and at all times,
  njsPC logs what the chlorinator actually did, one line an hour (the set %, the output it reported, minutes producing, any
  status other than OK, the salt reading, and whether it stopped reporting), kept for 18 months in `data/autoSwgOutputLog.jsonl`
  and available at `/state/autoSwg/output?days=30`. The summary written when Away protection ends includes it, so the
  hours the SWG really produced can be compared with what the plan assumed.
* None of this tests FC for you. Heavy rain, debris or an equipment failure can still lower it; the raised target is your margin.

**When you are back: recovery to steady state**
1. Test FC and log it. This ends Away protection, if you left it on, the next time AutoSwg reads PoolMath (a check, or
   the read it does at least once a day in every mode). Press Check Now to have it happen right away.
2. Set **Target FC** back to your usual level and press Check Now, then Apply.
3. If FC is above the target, the SWG is cut back (to 0% if need be) and consumption brings FC down over **Days to Target (FC
   above target)**, the gentle direction. If it is below, the SWG pushes up over **Days to Target (FC below target)**. When
   the period ends, the % returns to the maintenance %, if the checkbox is on, and you are at steady state with nothing more
   to adjust by hand.

## Start with the defaults

Run the defaults for about **three weeks**, testing FC regularly and keeping every SWG change logged (in
PoolMath, or locally by applying through AutoSwg), before you tune anything. If you have not been logging FC in
PoolMath yet, start now: there is no history to tune against until you have it. Tune (below) will tell you if
there are too few readings.

## The settings, in three groups

**Facts about your pool (set once):** Pool Volume, SWG Capacity (lbs/day), the run window (SWG Schedule, or
SWG Run Start/Stop) and Time Zone.

**What you want:**
* **Target FC**: the FC you want to hold.
* **Days to Target (above / below)**: how quickly to correct when FC is above or below the target. Above is
  gentle, since consumption does most of the work. Below is quicker, so you recover sooner.
* **Aim Above Target as the Last Test Ages** (0.15 ppm per day, at most 1 ppm; 0 = aim at the target itself): an old
  reading is a less certain place to start from, and FC a little high is the safer miss, so the SWG % that reaches the target is
  worked out for the target plus this many ppm for each day since the last test. It changes only that % (not the
  maintenance %, the target date or the projection).
* **Return to the maintenance % when the target period ends** (off until you turn it on): one of the two things AutoSwg
  does by itself (the other is Away protection, below), and only a convenience. A target period often ends between your FC tests, and the % you applied
  to reach the target would keep pushing FC past it (or leave it short) until you next test. With this checked, the
  SWG % goes back to the steady level on its own when each target period you start ends, to keep you from
  undershooting or overshooting your target in between. Turn it on once you are comfortable with how it behaves for
  your pool. Applying anything yourself, or changing the SWG % by hand, cancels the pending return. If the end of the target period falls while the
  SWG is off (before its run window starts or after it ends), nothing could change at that moment, so the return is set for one minute after the SWG next starts,
  and the pending step shows that time.

**Tuning options (leave alone at first):** these decide how much to trust the history.
* **Averaging Window** (21 days): how many days are used to estimate daily usage.
* **Projection Weighting** (50%), **Taper Weighting After** (3 days) and **Down to Zero At** (8 days): how much
  of the modelled change to apply between FC tests. The longer since your last test, the less it is trusted.
* **FC Anomaly Tolerance** (2 ppm), **Credit liquid chlorine** (on) and **Daytime Share** (automatic).
* **Adjust the burn for the water temperature** (off): moves the burn along a line fitted to your own burn rates against
  the water temperature logged with your FC tests, only when that line is clear. It did not improve the projection on the
  pool it was tried on (the water temperature barely changes within a 21-day window), so it is off; What-If Sweep scores it
  for yours once there are enough temperatures logged. Even when it is on, it moves the burn by at most 15% of the
  average, because a fit over a few weeks can mistake sunny days for warm water.

## Tuning, when you are ready

After the three weeks, open **Tuning options** and press **Tune**. It gives one recommendation, or tells you
the defaults look good. Apply it, then leave it alone for about 10 new FC readings before tuning again.
Tuning in a loop only makes the numbers look better. **How to Tune** has the details. The reports are
read-only.

**When the tuning options appear.** They are hidden until there is enough history to judge the calculation: at least 15
FC readings the reports can score, over at least 42 days with SWG history behind them (about two months at two tests a
week, sooner if you test more often). A note on the page shows how far along it is.

*Advanced:* the three minimums are `gateMinFcReadings` (15), `gateMinSwgEntries` (1) and `gateMinDays` (42) in the `autoSwg`
section of `poolConfig.json` (stop njsPC before editing it).

## Good habits and limits

* Test FC at about the same time of day, and correct a mistyped reading in PoolMath.
* Only the pool SWG % is managed, not the spa's.
* Only SWG output and liquid chlorine are credited. Other chlorine products (cal-hypo, dichlor, trichlor) are
  not, so projections run low after a dose of those.
* **Vacations:** see "Vacation: before, during and after" above. In short, log an FC test and raise the target the day you leave,
  and test and set the target back when you return.

---

# Advanced: how it calculates, and why the tuning options exist

You do not need this section to use AutoSwg. It is for anyone who wants to know what the numbers mean.

## How the recommendation is calculated

1. **What your SWG produced.** Each SWG entry in PoolMath (a % held for some run hours) is turned into ppm of
   FC for your pool volume, using the SWG Capacity (lbs/day at 100%).
2. **What your pool consumed.** Between two FC readings, consumption is the SWG output plus any liquid
   chlorine added, minus the change in FC. Averaged over the **Averaging Window**, that is your daily burn in
   ppm/day. Chlorine is lost mostly in daylight, so a partial day is weighted by the daylight share (about 56%
   in winter to 78% in summer, from your day length). See "Readings taken at different times of day" below.
3. **Where FC is now.** FC is only measured now and then, so the current value is projected from your last
   reading: last reading + weight x (SWG output since then - burn x time) + any liquid chlorine added since.
4. **The two numbers you see.** The **maintenance %** is the SWG % that just replaces the average burn, so FC
   holds steady. The **recommended %** is the % that moves the projected FC to the Target FC within the Days to
   Target window, so it sits above or below maintenance until the target is reached. If FC is far above target
   and even 0% would not bring it down in time, a new target's deadline is moved out to when consumption alone gets there.
   If FC is within the New Target Date Threshold of the target, the target is kept as it is and its deadline holds:
   close enough counts, and the SWG steps to the maintenance % at that time. If you have changed the **Target FC**
   since the last apply, Refresh and Apply (and the automatic check) start a new target instead: a changed target is a
   request for one.
   If even 100% cannot reach it, the report says how long it would take.
5. **Refresh: Adjust %** re-works the % with fresh PoolMath data against the same target date. It does not
   restart the countdown.

## Readings taken at different times of day

FC does not read the same all day. The SWG adds chlorine only while it runs, and sunlight uses it up mostly
in daylight, so a morning test and an afternoon test read differently even when nothing has changed. That
means two FC readings are rarely a whole number of "chlorine-use days" apart, and AutoSwg tries to allow for
it by prorating the time instead of counting clock hours:

* **Days of consumption, not clock days.** Every whole 24 hours counts as exactly one day, whatever time of day
  it starts. Only the leftover part is prorated, by when it falls. Daylight hours carry the daytime share of a
  day's chlorine loss (modelled as a curve that peaks at solar noon, about 56% in winter to 78% in summer,
  worked out from your sunrise, sunset and Time Zone). Night hours carry the rest. For example, a reading at
  8 am followed by one at 4 pm the next day is 32 hours: one whole day plus 8 daytime hours. On a spring day
  those 8 hours count as roughly 0.45 of a day, not the 0.33 the clock would give.
* **Used in three places.** Each interval between two readings converts the chlorine consumed into ppm per
  day by dividing by its days of consumption. The edges of the Averaging Window count only the part of an
  interval that lies inside the window, prorated the same way. The projection from your last reading to now
  uses the days of consumption since then.
* **SWG output follows the run window.** The SWG output since the last reading counts only the run-window hours
  that have actually passed, so a check made at 10 am has not credited the afternoon yet.

This is an approximation. The curve uses today's sunrise and sunset for every day in the window, and it knows
nothing about clouds or shade. It also does not change what the pool reads at different times of day, so
tests at similar times of day compare best. The share is automatic, and the Daytime Share setting overrides it.
What-If Sweep includes a "Daylight weighting off" variant if you want to see what it adds on your pool.

## Why the tuning options are what they are

* **Averaging Window (21 days).** Long enough to smooth out a few days of unusual weather, short enough to
  follow the season. On the pools we checked, 21 to 56 days were indistinguishable and 7 to 14 trended worse.
* **Projection Weighting (50%) and the taper (3 to 8 days).** Between tests a reading varies by about a ppm (the
  test itself, plus day-to-day changes in consumption from sun, rain and temperature), and FC moves less than a model
  that trusts every number would predict. Applying only half the modelled
  change predicted better than all of it, and better than assuming FC had not changed. The model helps for
  gaps up to about five days and hurts beyond that, so the weight fades to zero by 8 days since the last test.
* **FC Anomaly Tolerance (2 ppm).** An FC rise the SWG output and logged additions cannot explain, by more than
  this, usually means unlogged chlorine or a mistyped reading. That interval is left out of the average.
* **Credit liquid chlorine (on).** Otherwise the rise from a dose is counted as SWG output and the burn comes
  out too low.
* **Daytime Share (automatic).** Override only to test a theory.

## What the tuning tools do

* **Projection Accuracy** re-runs the calculation as of each past FC reading, using only what was known then,
  and compares its projection with the next reading. It shows the average error in ppm, how often it was
  within 1 and 2 ppm, and the same score for "FC unchanged since the last reading", which is the bar to beat.
  It also shows the bias with its uncertainty, how often the next-test range held, and how often the measured FC was
  more than 1 ppm below or above the projection. It also suggests a weighting and taper.
* **What-If Sweep** scores alternative settings on those same readings. Each has a 90% range, and a setting is
  called better or worse only when that range excludes zero. Anything smaller than about a tenth of a ppm is noise.
* **Tune** runs both and gives one recommendation, the window first. It looks further back when your last year
  has too few readings, and says so when there are too few to judge. It asks before tuning again too soon.
* **Backward-looking.** All of them score history, so a change shows up in the results only as new readings
  arrive. Tuning again on the same history makes the numbers look better without the pool predicting any better.
  That is why Tune waits for about 10 new readings.

## What was looked at and set aside

Several ideas were tested on one pool's history and not adopted. The reasons are in [Method and evidence](METHOD_AND_EVIDENCE.md),
with the numbers.

* **A shorter averaging window (14 days).** Not clearly better or worse than 21 days, and it makes the burn estimate noisier, so the
  default stays.
* **Water temperature in the burn.** No gain on the pool it was tried on; it is an option, off by default.
* **A state estimator (a Kalman-style filter).** About 0.04 ppm better, within the noise, so the simpler weighting and taper stay.
* **Sunlight, air temperature and rain as inputs.** They follow the seasons, which the 21 day average already does, and added nothing
  to the swings around it.
* **A nearby weather station's rain.** Its gauge read far higher than the modeled rain and needs quality control before it can be
  trusted; a rain based dilution credit improved the projection by about 1%.
* **Crediting dilution from water changes.** Dilution is real (salt and CYA step down after long wet spells) but unlogged, so it
  cannot be credited reliably yet. A drop in the chlorinator's salt reading is noted in the recommendation for now.

Why these were set aside, in short:
* A change has to beat the current numbers on the same readings, with a range that excludes zero.
* The expected variation between a projection and the next test (the test itself plus real day to day consumption) is larger than
  most of these effects, so a small real effect cannot be told from none.
* A correction that lowers the estimated burn needs more proof than one that raises it, because running a little high is the safer
  miss.
* A logged fact (a liquid chlorine dose, a water change) is better than a guess from sparse tests.

The standalone script in this folder (see the README) runs the same reports on any pool's PoolMath history
without installing njsPC. **[Method and evidence](METHOD_AND_EVIDENCE.md)** gives the formulas, how the calculation is
scored, what was measured on one pool, what was tried and not adopted, and the known limits.
