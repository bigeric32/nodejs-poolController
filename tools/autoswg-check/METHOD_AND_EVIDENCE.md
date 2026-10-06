# AutoSwg: method and evidence

This page is for anyone who wants to judge whether the approach is sound: the formulas, how the calculation is
scored, what was measured, what was tried and not adopted, and the known limits. The [quick guide](QUICK_GUIDE.md)
is the one to read to use it.

## Goal and status

AutoSwg has two goals. The first is semi-automated SWG changes that follow your PoolMath test logs while you are in town: you test
and log FC, press Check Now and Apply, and the % follows your tests and returns to the steady maintenance level on its own. The second
is FC safety while you are on vacation, and a smooth recovery to steady state when you are back: raise the target and test before
you leave, a floor at the maintenance % and dashboard alerts while you are away, and a way down (or up) to your usual target
from your first test when you return. It also began as a way to see what was possible with a pool's own data run locally on a
Raspberry Pi, without depending on external tools such as AI, as a starting point as those capabilities mature, while embracing
the Trouble Free Pool methods and not diverging from them. Everything here is plain arithmetic on your own controller; the only
outside input is your PoolMath log. It embraces those methods: FC is tested and logged in PoolMath, the target FC is the one you
choose the way those methods do, and nothing here proposes a different target or replaces testing. It only helps get the SWG to
the target and hold it. It is a helper that runs on your own controller: you set the target, you review each recommendation, and
you apply it. It does two things by itself, both optional and off until you turn them on: the return to the maintenance % when a
target period ends, and, while Away protection is turned on for a trip, the 12-hourly check that may raise the SWG % to make up
for dilution or an outage (only upward from the maintenance %, and the extra for dilution or an outage limited to a number of points you set). Away protection ends when you turn it off,
or by itself when a new FC reading is logged in PoolMath after it was turned on. PoolMath is also read at least once a day in
every mode, so that new tests, and the salt you add, are picked up without any check being run.

The evidence below comes from one pool, the author's (12,000 gallons, a salt chlorine generator, 114 FC readings
from June 2025 to October 2026, 61 of them scorable). That is enough to say the method works there and to find where it
is weak. It is not enough to say how well it works on yours. The Tune button and the standalone script run the same
checks on your history.

## The model

Notation: `f` is FC in ppm, readings `f1, f2, ...` taken at times `t1, t2, ...`.

**What happens between two readings.** `g` is what the SWG made (the logged % held for the logged run hours, converted to
ppm with the SWG rating and pool volume), `a` is liquid chlorine added (strength x volume / pool volume), and the
consumption is what is left over:

    c = g + a - (f2 - f1)

**Days of consumption.** Chlorine is lost mostly in daylight, so time is counted in "consumption days" `d`, not clock
days. Every whole 24 hours is exactly one day; only the leftover part is prorated, by where it falls on a daytime curve
(parabolic, from the day length, about 56% of a day's loss in daylight in winter to 78% in summer). Without sunrise and
sunset the clock is used.

**Burn rate.** The burn `b` (ppm/day) is the average of `c/d` over the intervals in the last 21 days, weighted by how
many consumption days of each interval fall inside the window (so it is total consumption over total days). Intervals
that start before the SWG record exists are left out, and so is an interval whose FC rose more than the SWG and logged
additions can explain by over 2 ppm (an unlogged addition or a mistyped reading). If the window holds fewer than 3
readings it is stretched back to the third most recent.

**Maintenance %.** With `C` the ppm/day the SWG makes at 100% over its run window:

    maintenance % = 100 * b / C

**Projected FC now.** From the last reading, `Delta` days ago:

    f_hat = f_last + w(Delta) * (G - b * D) + A

`G` is the SWG output since the last reading (only run-window hours that have passed), `D` the consumption days since,
`A` liquid chlorine added since (known, so counted in full). The weight `w` is 0.5 up to 3 days, then falls linearly to 0
at 8 days.

**Recommended % for a target.** To reach `target` in `T` days (above-target and below-target use separate windows):

    needed = (target + margin - f_hat) + b * T
    % = 100 * needed / (C * T)         limited to 0 to 100

where `margin = min(1 ppm, r * Delta)` is how far above the target to aim, growing with the age of the last reading at
`r` = 0.15 ppm/day by default (0 to aim at the target itself). It changes only this %.

**The deadline.** A target is kept (same FC, same date) while the projected FC stays within the new-target-date threshold
of it: close enough counts, and the SWG steps to the maintenance % at the date. If the FC strays further, a new target
and date are started. If consumption alone cannot bring a new target's FC down by its date, the date is moved out to when
it can. With the last reading 3 days old or more, the SWG is never held below the maintenance %.

**Where the next test is likely to read.** The projection plus or minus `1.97 * sqrt(s^2 + (0.1 * Delta)^2)`, where `s` is
the root-mean-square miss of the same weighted projection over every interval between two readings in the last 90 days
(1.8 ppm if there are fewer than 6). The `s` term includes the variation of the test itself and of real day-to-day consumption.

## How it reads in control terms

The pool is an integrator with a leak. FC rises with SWG output (limited to 0 to 100% of the run window, so the input
saturates) and falls with a burn that follows weather, bather load and sunlight, which is a slowly varying disturbance. The
sensor is a manual test: sparse (every few days) and delayed, and each reading is a snapshot of a pool whose consumption varies from day to day. There is no continuous feedback: the calculation
runs when someone asks, and the only thing that acts by itself is the optional return to the maintenance %.

* **Feedforward plus a glide.** The maintenance % is feedforward on the estimated disturbance. The recommended % is a
  finite-time move to the setpoint: "Run Periods to Target" is its gain, and a short window is a hard push. With sparse measurements that vary from reading to reading, a hard push amplifies that variation, so a longer window is the gentler choice.
* **A deadband.** The new-target-date threshold is hysteresis: inside it the old plan is held instead of chasing each reading.
* **A safe fallback.** When the last reading is stale the output is floored at the maintenance %. A long absence runs a little
  high, the safer miss, and not at 0% waiting for FC to glide down.
* **The projection weight stands in for an estimator.** The 0.5 and the taper to zero are an empirical shrinkage of the
  modelled change. A proper state estimator was tried (below) and did not beat it clearly enough to adopt.

## How it is scored

For each FC reading, the calculation is re-run as of a minute before it, using only data logged before it, with today's
settings, and the projection is compared with the measurement (a rolling-origin test, so nothing leaks from the
future). The error is projected minus measured.

* **Baseline.** "FC unchanged since the last reading", the bar any model must beat.
* **Reported:** mean absolute error, RMSE, bias with its standard error, how often the error was within 1 and 2 ppm,
  error by gap since the previous reading, how often the next-test range held, and how often the measured FC was more than
  1 ppm below or above the projection.
* **What-If Sweep.** Alternative settings are scored on the same readings. For each, the change in mean absolute error comes
  with a 90% bootstrap range, and it is called better or worse only when that range excludes zero.
* **Tune.** It needs at least 15 scorable readings, takes the best clearly better alternative, and asks you to wait for about
  10 new readings before tuning again, because every pass is scored on the same history.

## What was measured (the author's pool, data through 3 October 2026)

Default settings: window 21 days, weighting 0.5 with the 3 to 8 day taper, anomaly tolerance 2 ppm, liquid chlorine credited,
daylight weighting off in these runs (no sunrise and sunset in the saved data).

| Measure | Value |
|---|---|
| Readings scored | 61 |
| Mean absolute error | 1.29 ppm (baseline "FC unchanged": 1.36, so 5% better) |
| RMSE | 1.85 ppm |
| Bias | -0.28 +/- 0.24 ppm (not distinguishable from none) |
| Within 1 ppm / within 2 ppm | 54% / 80% |
| Mean absolute error by gap | under 2 days 1.20 (27), 2 to 5 days 1.23 (24), 5 to 14 days 1.65 (10) |
| Next-test range held | 92% (meant to be about 90%) |
| Measured more than 1 ppm below the projection | 18% |
| Measured more than 1 ppm above the projection | 28% |

The standalone script gives the same numbers to within rounding (59 readings, because it sets aside one SWG entry that
does not fit the pool's rating).

**What this says.** The miss is about 1.8 ppm RMS at every gap, and barely grows with the time since the last reading.
That is expected variation, and these data cannot separate its two sources. One is the test itself: each reading varies a
little, and a projection compared with the next reading carries the variation of both. The other is real day-to-day change
in how much chlorine the pool uses, from sun, rain, temperature and bather load, which is hard to project without local
weather data such as a personal weather station. Together they set a floor: the algorithm is only a little better than "FC
unchanged" because much of what either one misses is this variation, which no projection from the log alone can remove. It
is why the next-test range is wide, and why one reading a little off the projection is not a reason to change anything.

**What-If Sweep on the same readings.** Most alternatives are indistinguishable from the defaults (averaging windows of 14 to
56 days, other tapers, anomaly tolerances 0 to 3 ppm, a 75% weighting). Clearly worse: a 7 day window (+0.07 ppm), a
weighting of 25% (+0.06) and no model at all, weighting 0 (+0.13). One alternative, not crediting liquid chlorine, was
borderline better (-0.06, range -0.19 to 0.00), on a history with only three logged additions, so it is not read as real.

## Tried and not adopted

* **Water temperature in the burn.** A line of burn against water temperature, applied only when clear. Mean absolute error
  was 1.29 either way. In the latest window the slope was +0.07 ppm/day per degree, 0.3 standard errors from zero, and the
  temperature barely moved (80 to 85 F). It is in the app as an option, off by default; the What-If Sweep scores it for your
  pool. It may matter on a pool whose water temperature swings more within 21 days.
* **A Kalman-style estimator.** Smoothing the readings before projecting, with the reading variation and a process variation per
  day as parameters, over a grid of settings. The best setting improved mean absolute error by about 0.04 ppm, with a 90% range
  from -0.09 to +0.005 ppm, which includes zero. By the tool's own rule that is no clear difference, so the simpler
  weighting and taper stay.
* **An uncertainty estimate from the burn's own scatter.** A first version of the next-test range estimated the spread from
  the scatter of the interval burn rates minus an assumed test variation. It held only 76% of the time against a nominal 90%, and
  the readings it called most certain missed by the most. The shipped range uses how far the projection actually missed
  instead.
* **A time-of-day adjustment, and crediting solid chlorine (cal-hypo, dichlor).** Neither improved out-of-sample error on the
  histories checked, so neither is in. Solid chlorine is not credited, so a pool that doses it will see projections run low
  after each dose.
* **A shorter averaging window (14 days).** Compared with the 21 day default on the same readings, a 14 day window changed mean
  absolute error by +0.007 ppm overall (90% range -0.021 to +0.035) and by -0.018 in the shoulder months, March to May and
  September to November (range -0.046 to +0.008). Neither range excludes zero, and 7 days is clearly worse (+0.08). What a short
  window costs is steadier to measure: at two tests a week it holds a median of 3 intervals (sometimes 1) against 4, and the burn
  estimate moves about 40% more between checks (median 0.11 against 0.08 ppm/day). Weighting recent intervals more, over a 42 day
  window, gave no detectable edge either. A shorter window is a reasonable judgment call, since a longer one lags a rising burn in
  spring, but the data cannot settle it, so the default stays at 21 days. Tune only moves to a window that is clearly better, so it
  will not choose the shorter one for you; one idea is to accept a shorter window whenever it is not worse by more than a small
  margin (about +0.05 ppm in the paired comparison), which 14 days passes and 7 days fails.
* **Weather as an input to the burn: sunlight, air temperature, rain and cloud cover.** Daily values for the pool's area, set
  against the burn of each interval between two tests, explained 16 to 23% of it, but that is the season: the burn rises into summer
  and falls into winter, and the 21 day average already follows that. Against the swings around the average, which is all a new
  input could add, sunlight explained 2%, air temperature 3%, rain 0% and the three together 6%, and out of sample the fit was worse
  than no fit (-10%). So none of them is used.
* **Rain as events, and leaving out the intervals that had heavy rain.** Dilution by rain is an event, not a daily average, so rain
  was also tried as total rain per interval (no relationship, correlation +0.04) and by leaving the intervals with a 0.25, 0.5 or 1
  inch day out of the burn average. That made the projections worse (+0.04 to +0.14 ppm), most likely because the stormiest weeks are
  also the typical ones and are worth keeping. A first version of this test used only intervals of 10 days or less and so missed the
  longest, wettest stretches; the later tests used every interval.
* **A nearby personal weather station's rain gauge.** Sixteen months of its published daily rain were compared with the modeled
  data. The station totalled 2.4 times the modeled rain (170 against 70 inches), agreed with it day by day only 0.36, and reported
  single days of 7 to 9 inches where the model showed under 1.5. A gauge can read high for ordinary reasons (sprinkler spray, a
  miscalibrated bucket), so a third-party sensor needs quality control, such as a comparison with neighbors and radar, before its
  numbers are trusted. Using the salt tests as a tracer for dilution (intervals with no salt added), rain explained only about 8% of
  the salt change, with the gauge and the model about equal, and a rain based dilution credit improved the projection by 0.004 to
  0.013 ppm, about 1% of the error: detectable, not substantial.
* **Crediting dilution from the salt, CYA and CH tests.** Salt, CYA or CH stepped down 7 to 20% in stretches with 2.5 to 12 inches of
  rain, which is what rain plus water removal and refilling would do, so dilution is real on this pool. Treating the drop as water
  replaced, and crediting FC times that fraction the way liquid chlorine is credited, changed the projection error by -0.001 to
  -0.003 ppm. Salt, CYA and CH are tested too rarely to place a drop in time, the events sit in long gaps between tests, and nothing
  records a drawdown. Rough arithmetic suggests a 10% replacement at 10 ppm removes about 1 ppm of FC, which the calculation reads as
  consumption and so overstates the burn by roughly 0.2 to 0.3 ppm/day for up to a window length. That errs on the side of more
  chlorine, which is the safer miss, so it is left uncorrected for now.

## Why these were set aside: the general reasoning

* **A change has to earn its place out of sample.** It is scored on the same readings as the current settings, against a baseline,
  with a range that excludes zero. Plausible is not enough, and this page lists what failed that test as well as what passed.
* **Most effects here are smaller than the expected variation.** A projection misses the next reading by about 1.8 ppm either way,
  partly the test itself and partly real day to day consumption. An effect of a tenth of a ppm or less cannot be seen against
  that, so a small real effect and no effect look the same. The honest answer is then "not shown", not "absent".
* **A new input has to explain what the average does not.** The 21 day average already follows the seasons. Sunlight and
  temperature explain the seasons well and the swings around them hardly at all.
* **Errors that run high are safer than errors that run low.** A correction that lowers the estimated burn, such as a dilution credit,
  would make the SWG under-generate if it were applied wrongly. It therefore needs more proof than one that raises it, and an
  uncorrected overstatement is acceptable meanwhile.
* **A logged fact beats an inferred one.** A liquid chlorine entry is a fact. Dilution guessed from tests every ten days is not. The
  better path is a measured salt reading plus a logged water change, so the credit rests on two things that agree.
* **Check the instrument before trusting it.** The nearby gauge read 2.4 times the modeled rain. Data from a neighbor's sensor is
  only as good as that sensor.
* **Collect data before building on it.** Logging first and testing later costs little and risks nothing. One pool shows a case,
  not a rule, so what held here is a starting point for the next pool.
* **Where the data cannot decide, say so.** The averaging window is such a case. The default is the one that is easier to defend,
  and the alternative is written down with its evidence.

## Known limits

* **One pool of evidence.** The defaults were also checked on other pools' histories, but those results are not published
  here. Treat the numbers above as one case, and run Tune on yours.
* **The error metric is symmetric.** Mean absolute error treats a low and a high miss the same, while a pool owner may not.
  The report therefore also counts misses of more than 1 ppm each way, and the margin above the target is a separate, explicit
  setting.
* **Burn is a constant, not a function of FC.** Chlorine loss in sunlight is closer to proportional to the FC present than
  constant. Not tested.
* **Weather is not modelled.** Rain, UV, cloud and temperature change how much chlorine the pool uses from day to day, and
  the burn is a 21-day average, so it lags a change in season by about half a window. Daily weather was tried as an input and
  added nothing measurable on this pool (see above). Local measurements may do better than modeled data, but the one nearby
  gauge checked needed quality control first.
* **Water removal and refilling is not modelled.** It dilutes FC in a step the calculation reads as consumption, which
  overstates the burn for a while. When salt drops noticeably the recommendation says so; it does not adjust for it.
* **The daylight curve is an approximation,** using today's sunrise and sunset for every day in the window.
* **Expected variation is not removed.** Part is the test itself and part is real day-to-day consumption. Testing at a
  consistent time of day and correcting a mistyped reading in PoolMath help with the first.
* **Scores are on overlapping history.** Neighbouring windows share data, so the errors are correlated and the 90% ranges are
  probably a little too narrow. Picking the best of several variants flatters it (the winner's curse), which is why Tune waits
  for new readings before it tunes again.
* **Projection error is not tracking error.** These measures grade the forecast between tests, not whether FC stayed near
  your target. The target tracking table in Projection Accuracy fills in as applied targets reach their dates. A full
  closed-loop replay has not been done.
* **Only SWG output and liquid chlorine are credited.**

## What would change this

This is a starting point. As more capable methods, AI included, mature and can run locally, the scoring described above
is how to compare them with this baseline: a method is better only if it beats the current numbers on the same readings.

More pools with varied test times and enough SWG history, to see whether the defaults hold and whether the temperature
adjustment helps where the water temperature swings. For dilution, a local log of the chlorinator's own salt reading is kept now: the recommendation notes a drop of about 7% or more,
and counts salt you logged adding in PoolMath (the local archive is topped up from PoolMath's JSON feed about once a day, which
is also where salt additions and the extra numbers on new tests come from). The next steps are a logged water change with the
pool's surface area, with salt as the cross-check. Only once such a log has a few real events in it is a cautious,
off-by-default credit worth testing. Past a point, replacing the fixed weighting with an estimator that
weighs the model and the test by their uncertainty, and using the stored weather fields (or a personal weather station's data), are the next steps to try. The
standalone script makes either easy to test on a pool's history before it goes anywhere near the app.

## Reproduce it

* In the app: Settings > Chemistry > AutoSwg > Tuning options > Projection Accuracy, What-If Sweep or Tune.
* Standalone: `python autoswg_check.py <share code or --json file> --tz <your time zone> --report accuracy` (or `whatif`).
  See the [README](README.md).
