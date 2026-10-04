# AutoSwg quick guide

## What it is for

You choose an FC target for your pool. AutoSwg reads your PoolMath log, works out how much chlorine your pool
really uses, and recommends the SWG % that keeps FC near the target. When weather, bather load or sunlight
change that usage, the next check adjusts the % to follow it. Your part is to set the target once, keep the
PoolMath log up to date, and apply the recommendation.

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

1. Press **Check Now**. It shows a recommended SWG % and the reasons for it.
2. Press **Apply** to send it to the chlorinator.
3. After the target period, the % steps back to the **maintenance %** (if "Step to maintenance %" is on), the
   level that just holds FC steady.

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
* **Step to maintenance %**: return to the steady level once the target period ends.

**Tuning options (leave alone at first):** these decide how much to trust the history.
* **Averaging Window** (21 days): how many days are used to estimate daily usage.
* **Projection Weighting** (50%), **Taper Weighting After** (3 days) and **Down to Zero At** (8 days): how much
  of the modelled change to apply between FC tests. The longer since your last test, the less it is trusted.
* **FC Anomaly Tolerance** (2 ppm), **Credit liquid chlorine** (on) and **Daytime Share** (automatic).

## Tuning, when you are ready

After the three weeks, open **Tuning options** and press **Tune**. It gives one recommendation, or tells you
the defaults look good. Apply it, then leave it alone for about 10 new FC readings before tuning again.
Tuning in a loop only makes the numbers look better. **How to Tune** has the details. The reports are
read-only.

## Good habits and limits

* Test FC at about the same time of day, and correct a mistyped reading in PoolMath.
* Only the pool SWG % is managed, not the spa's.
* Only SWG output and liquid chlorine are credited. Other chlorine products (cal-hypo, dichlor, trichlor) are
  not, so projections run low after a dose of those.
* **Before a trip:** log an FC test the day you leave. With no new reading for 3 days or more, AutoSwg never
  runs the SWG below the maintenance % (it would otherwise hold it at 0% waiting for FC to glide down, and keep
  moving that date out), so a long absence runs at about the level that matches consumption. Running a little
  high is the safer miss. The card says when this applies.

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
   and even 0% would not bring it down in time, the deadline is moved out to when consumption alone gets there.
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
* **Projection Weighting (50%) and the taper (3 to 8 days).** FC tests are good to about a ppm, and between
  tests FC moves less than a model that trusts every number would predict. Applying only half the modelled
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
  It also suggests a weighting and taper.
* **What-If Sweep** scores alternative settings on those same readings. Each has a 90% range, and a setting is
  called better or worse only when that range excludes zero. Anything smaller than about a tenth of a ppm is noise.
* **Tune** runs both and gives one recommendation, the window first. It looks further back when your last year
  has too few readings, and says so when there are too few to judge. It asks before tuning again too soon.
* **Backward-looking.** All of them score history, so a change shows up in the results only as new readings
  arrive. Tuning again on the same history makes the numbers look better without the pool predicting any better.
  That is why Tune waits for about 10 new readings.

The standalone script in this folder (see the README) runs the same reports on any pool's PoolMath history
without installing njsPC.
