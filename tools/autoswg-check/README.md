# autoswg-check

A standalone, standard-library-only Python script (3.8+) that checks the AutoSwg algorithm against a
pool's PoolMath history, without installing njsPC. Give it a PoolMath share code (or a saved JSON
file) and it re-runs a port of njsPC's calculation over the pool's FC readings, SWG entries and
liquid chlorine additions to answer:

* **How well would the algorithm have predicted each FC reading?** (projection accuracy)
* **Which settings would have predicted better?** Averaging window, daylight weighting, liquid
  chlorine credit and anomaly tolerance, each scored on the same readings with a 90% bootstrap
  range, so a setting is called better or worse only when the evidence supports it (what-if sweep).
* **What does the pool's consumption look like by month, and where does its SWG record start?**
  (dataset summary)
* **Which FC rises can't the SWG output and logged additions explain?** (anomalies)
* **Do the SWG entries agree with one cell rating, and with njsPC's setting?** (capacity)

It is a port of `controller/AutoSwgService.ts`, not the same code. Run it on a pool you also have in
njsPC and compare with the app's **Projection Accuracy** and **What-If Sweep** dialogs; if the numbers
agree, the port is faithful. Re-check whenever the algorithm changes.

## Quick start

1. You need **Python 3.8 or newer** (`python --version`). Nothing to `pip install`.
2. Get the pool's **PoolMath share code**: in the PoolMath app, share the pool and copy the link or the
   code (it looks like `tfp-123456`). The owner must have sharing turned on, and **should have agreed
   to you using their data**.
3. Download `autoswg_check.py` and run it:

       python autoswg_check.py tfp-123456 --tz America/New_York --lat 40.7 --lon -74.0

   The first run fetches the data (one request, which can take a few seconds), caches a sanitized
   copy in a `cache/` folder next to the script, and prints the reports. Later runs reuse the cache,
   so you can try different options without asking PoolMath again; add `--refresh` to re-fetch.
4. To keep results for comparing pools, add `--csv out/` (writes `accuracy.csv` and `whatif.csv`).

You can also point it at a saved copy of the share JSON instead of a code:

    python autoswg_check.py --json saved.json --tz America/New_York

## What it prints

* **Dataset:** FC readings, SWG entries, liquid chlorine additions, CYA readings, pool volume, the date
  the SWG record starts (readings before it can't be used) and whether daylight weighting is on.
* **Consumption by month:** day-weighted FC consumption, the SWG output, and the median FC for each
  month with a complete SWG record. Look for the seasonal swing and for months with no data.
* **SWG capacity agreement:** PoolMath credits each SWG entry with `% x rated lbs/day x hours/24`, so
  the rating each entry implies should be steady. The report shows the implied rating by period (a
  step is a cell swap or a changed rating setting; PoolMath keeps each entry's own credit, so history
  stays consistent), compares the latest one with njsPC's rating if you pass `--njspc-lbs`, and flags
  entries that don't fit their period (which the other reports then ignore). For each odd entry it also checks which credit the FC
  readings support, because a credit that disagrees with the rating can still be the right one
  (the % or run hours entered may not reflect what actually ran).
* **Projection accuracy:** for each reading, the algorithm re-run as of just before it with only the
  data logged by then, compared with what was measured. Error is `projected - measured` in ppm (positive
  means it projected too high). Shown as mean absolute error, RMSE, bias, the share within 1 and 2 ppm,
  and split by how long it had been since the previous reading. It also prints a **baseline**, the
  error of "FC is what it was at the last reading" with no model at all, so you can see whether the
  algorithm adds anything, and the **projection weighting** that would have scored best on those
  readings (with a suggestion shrunk toward 50% for small samples).
* **What-if sweep:** the same scoring under other windows (7, 14, 21, 28, 42, 56 days), daylight
  weighting off, the chlorine credit toggled, and other anomaly tolerances. "Change" is the mean change
  in absolute error versus your current settings (negative is better) with a 90% range.
* **Anomalies:** FC rises beyond what the SWG output plus logged additions explain, at 1, 2 and 3 ppm.

## Screening pools to test on

To find out which pools are worth checking the algorithm on, give `--screen` any number of share codes:

    python autoswg_check.py --screen tfp-111111 tfp-222222 tfp-333333

It makes one polite request per pool (with a pause between them, `--screen-pause`, default 10 s; cached
afterwards) and prints one line each:

    share code     gallons  FC (1yr)   SWG  adds scorable    median   odd  last  verdict
    tfp-111111       12000  113 (82)    27     3    60/60       2.6     1     0  GOOD
    tfp-222222       20300  153 (20)    26    10    13/91       7.0     3     4  usable (most of the data is older than a year)
    tfp-333333       16000  314 (38)     0     1      0/0       5.7     0     5  no SWG logged: consumption cannot be derived

* **FC (1yr)**: FC readings in total, and in the last year.
* **SWG / adds**: SWG % entries logged and liquid chlorine additions.
* **scorable**: FC readings with enough SWG-covered history behind them to be checked, in the last year and in
  all. The in-app Tune needs about 15, and looks further back when the last year has fewer than 30.
* **odd SWG**: SWG entries ignored as not fitting the pool's own rating (see the capacity report).
* **verdict**: `GOOD` (30 or more scorable readings, 15 or more in the last year), `usable` (plenty, but mostly older),
  `marginal`, `too sparse`, `too few FC readings`, `stale` (no FC reading for over 120 days), `no SWG logged` (consumption
  can't be derived), or `unavailable` (the link can't be read or sharing is off). Add `--csv DIR` to keep the table as
  `screen.csv`.

A good test pool logs SWG % changes promptly, tests FC at least weekly, and has some history since the SWG entries
began. Then run the full reports on the ones that screen well. As always, only use data from pools whose owners have
agreed.

## Using the in-app reports: Projection Accuracy and What-If Sweep

dashPanel has the same two reports for your own pool, under **Settings > Chemistry > AutoSwg > Tuning
options** (click "Tuning options" to expand it). This script gives you the same numbers for any pool, and
is the way to try a setting on someone else's history first.

### The quick way: the Tune button

Press **Tune** (in Tuning options). It checks your *saved* settings against your FC history and gives
**one** recommendation, or says your settings look good:

1. Apply the recommendation. If it was an **averaging window** change, press Tune once more (the window
   interacts with the weighting and taper, so those are judged after it), then stop.
2. Leave it alone for about 10 new FC readings, then check the "Since you changed" line in Projection
   Accuracy.
3. Don't tune in a loop: every pass is scored on the same history, so it makes the numbers look better
   without the real accuracy improving.

Tune is built from the two reports below, which open from its dialog (**Projection Accuracy** and
**What-If Sweep**) if you want the detail. The rest of this section explains them.

### What each one answers

* **Projection Accuracy** answers *how well do the projections match what I measured?* For every recent FC
  reading it re-runs the calculation as of just before that reading, with only the data logged by then and
  your **current** settings, and compares the projected FC with the measured one.
* **What-If Sweep** answers *would different settings have done better?* It re-scores the same readings
  under other averaging windows, projection weightings and tapers, the chlorine credit toggled, and other
  anomaly tolerances, and shows how each compares with your settings.

Both are backward looking, but re-scoring is instant: change a setting, reopen a report, and the whole
history is scored under the new setting. You don't have to wait for new readings to see the effect (but see
"Checking it on new readings" below, because that effect is partly flattering).

### A suggested routine

1. **Open Projection Accuracy for a baseline.** Read these first:
   * *Readings scored*: aim for 30 or more. With fewer, everything below is rough.
   * *Mean absolute error*: how far off the projection typically is. Around 1.2 to 1.6 ppm is normal,
     because an FC test is only good to about a ppm.
   * *Baseline "FC unchanged since the last reading"*: the error of predicting no change at all. The
     algorithm should beat it; if it is *worse*, the projection between tests is adding noise, and the
     weighting and taper below are the fix.
   * *By time since the previous reading*: errors usually jump for gaps over about 5 days. That is the
     reason for the taper, and the reason to test more often.
2. **Read the suggested weighting.** The dialog shows the weighting and taper that would have scored best on
   your readings, pulled toward the middle because a few dozen readings is a small sample, with an
   **Apply** button.
3. **Open What-If Sweep to see what else would help.** Each row is a set of alternative settings:
   * *Change* is the mean change in absolute error versus your current settings (negative is better), with
     a 90% range. A row is called **better** or **worse** only when that range excludes zero. "No clear
     difference" is a normal, honest answer.
   * Differences under about **0.1 ppm** are too small to tell apart with a few dozen readings.
   * Work in this order: the **averaging window** (usually the biggest effect), then the **projection
     weighting and taper**. Leave daylight weighting, the chlorine credit and the anomaly tolerance alone
     unless they are clearly better.
4. **Apply one improvement at a time.** Press **Apply** on a "better" row, or on the accuracy suggestion. It
   saves just those settings, and they take effect the next time you Check or Refresh. Applying several
   rows at once makes it impossible to tell which one helped.
5. **Check it on new readings.** See the next section.

### Checking it on new readings

A setting chosen from a report is tuned on the same readings the report scores, so its improvement is
somewhat flattering. The honest test is readings that arrive *after* you changed it. When a tuning setting
changes, the accuracy dialog adds a line such as:

> Since you changed the tuning settings (10/9, 12:30): 8 new readings, mean error 1.12 ppm (the "unchanged"
> baseline over the same readings: 1.50 ppm).

* Treat it as meaningful from about **10 new readings**; with fewer it jumps around.
* If the new readings are no better than the "unchanged" baseline after about 15, press **Reset Tuning to
  Defaults** (in Tuning options), Save, and don't chase it further.

### How often to do this

* After the **first few weeks** of readings, and again when conditions change: a new season, a cell swap, a
  change in how often you test, or a CYA change.
* **Not after every reading.** Each reading adds noise, and re-tuning on noise makes the projections worse.
  The defaults are reasonable for most pools.
* Keep the data healthy first. The reports are only as good as the PoolMath log: log SWG % changes
  promptly, log liquid chlorine as "Liquid Chlorine", and correct a mistyped reading. The anomaly note
  and the SWG rating warning in dashPanel point at the usual problems.

### What the reports do not measure

* They grade the **forecast between tests**, which is the hardest test, not whether the recommended SWG % kept FC
  near your target. The target tracking section of Projection Accuracy covers that, and fills in as your
  applies reach their deadlines.
* They read the PoolMath share page, so they cover what that page lists. This script reads the longer
  history and can score further back.
* Scoring uses today's run window and sunrise and sunset for past days.

## Options and tips

| option | what it does and how to choose it |
| --- | --- |
| `--tz America/New_York` | The pool's IANA time zone. Needed for daylight weighting and to place the SWG run window in local time. Without it everything is treated as UTC. On Windows the zone database may be missing: `pip install tzdata`, or use `--utc-offset -5` instead. |
| `--lat 40.7 --lon -74.0` | The pool's rough location, used to work out today's sunrise and sunset for the daylight weighting. 0.1 degrees is plenty. If the owner gave PoolMath a location the script uses it (rounded to 0.1 degrees); otherwise **without lat/lon the weighting is simply off**. In my test, turning it off made accuracy slightly worse, so it is worth giving. |
| `--swg-start 08:00` | Local time the SWG's daily run window starts (default 08:00). The run length comes from each PoolMath SWG entry (usually 12 hours). It only affects the part of a day since the last reading, so a rough value is fine; for a sunrise-to-sunset schedule use roughly sunrise. |
| `--window 21` | The averaging window the sweep treats as "current" (default 21 days). Leave it at the default for comparing pools; the sweep already shows the alternatives. |
| `--tolerance 2` | The FC anomaly tolerance in ppm (default 2; 0 turns the check off). Lower flags more intervals but also more ordinary test noise. |
| `--weight 0.5` (alias `--damping`) | The projection weighting: how much of the modelled FC change since the last reading (SWG output minus consumption) to apply, from 0 to 1 (default 0.5, matching the app; 1 = all of it, 0 = start from the last reading unchanged). FC usually moves less between tests than the model expects, so a value below 1 usually predicts better; the accuracy report suggests one and the what-if sweep scores 0, 25, 50, 75 and 100%. |
| `--taper-start 3 --taper-end 8` | A gap-aware taper on the projection weighting: full weight until the last reading is `--taper-start` days old, then falling in a straight line to zero at `--taper-end` days (defaults 3 and 8, matching the app; `--taper-end 0` turns it off). The model helps for gaps under about 5 days and hurts beyond, which is why the taper is on by default. The accuracy report suggests values; the what-if sweep scores a few combinations. |
| `--no-credit` | Don't credit liquid chlorine additions as FC added. Use it to see whether the credit helps for a given pool. |
| `--no-daylight` | Count time by the clock instead of weighting daylight. |
| `--daytime-share 0` | The daytime share of chlorine loss in percent. 0 (default) estimates it from the day length (about 56% in winter, 67% in spring/fall, 78% in summer). Only override it to test a theory. |
| `--gallons 12000` | Pool volume. Defaults to PoolMath's value; set it if that is wrong, because it scales the ppm credited for liquid chlorine. |
| `--days 365` | How far back to score readings (default 365). A shorter value focuses on recent behaviour; a longer one adds earlier seasons if the data goes back that far. |
| `--pool NAME` | Choose a pool when the account has several (default: the first). A part of the name is enough. |
| `--report` | `summary`, `capacity`, `accuracy`, `whatif`, `anomalies` or `all` (default). |
| `--njspc-lbs 1.47` | njsPC's AutoSwg SWG rating (lbs/day), so the capacity report can compare it with what PoolMath's entries imply. A mismatch shifts both the recommended % and the SWG output njsPC logs locally. |
| `--keep-odd-swg` | By default the script **flags and ignores** SWG entries that don't fit the pool's own rating (for example a one-day entry whose credit disagrees with the rest): the intervals that depend on such an entry are left out of the averages and the scoring, and the capacity report lists them. This puts them back in. |
| `--include-uncovered` | Also score readings from before the SWG record starts. Not recommended: with no SWG output on record, consumption comes out wrong. |
| `--cache DIR`, `--refresh` | Where the sanitized data is cached, and re-fetch instead of using it. |

## What it needs from a pool

* **FC test readings.** A few a week is workable and daily is ideal. Gaps matter: scoring is noticeably
  worse across gaps of five days or more.
* **SWG entries in PoolMath** (the chlorine generator log entries). Consumption is almost entirely the
  SWG output, so **readings from before the first SWG entry can't be used**. The summary tells you where
  the usable history starts, and a pool that logs every SWG % change is far more useful than one that
  doesn't.
* **Liquid chlorine additions** logged as "Liquid Chlorine" with the right strength. Other chlorine
  products aren't recognized yet.

## Reading the results

* **Sample size.** Aim for 30 or more scored readings. With fewer, the ranges are wide and most
  comparisons come out "no clear difference", which is a normal and honest answer.
* **Small differences.** Differences under about 0.1 ppm are too small to separate with a few dozen
  readings. Look for settings that are "better" with a range that clearly excludes zero, and ideally
  that repeat across pools.
* **Context.** A mean absolute error around 1.5 ppm is typical because FC test kits are only good to
  about a ppm; the algorithm can't beat that noise.
* **Odd rows.** If one reading's error is huge, check the anomalies report: it is often a mistyped
  reading or an unlogged addition.

## Troubleshooting

* **HTTP 429 / "rate limiting".** PoolMath allows about one request a minute. The script waits (the
  server's Retry-After, or about 70 seconds) and retries up to four times, then stops and tells you; if
  that happens, wait a few minutes. If PoolMath refuses a large request it pauses about a minute before
  trying a smaller one. Cached data avoids new requests, so you only wait on the first run for a pool.
* **"no SWG entries".** The pool doesn't log SWG runs in PoolMath, so consumption can't be derived.
* **"too few readings scorable".** Not enough readings with SWG history behind them yet.
* **`could not load time zone`.** On Windows run `pip install tzdata`, or pass `--utc-offset`.
* **Several pools in one account.** Pass `--pool` with the pool's name.

## Data and etiquette

PoolMath's share endpoint (`https://api.poolmathapp.com/share/<code>.json?recentLogs=N`) is
undocumented and rate limited. The script makes one request per run and caches a sanitized copy under
`cache/` (numbers and timestamps only: no contact fields, address, notes or log ids; the pool's display
name and its latitude/longitude rounded to 0.1 degrees are kept). `cache/` is ignored by git.
**Only use data from pools whose owners have agreed.**
