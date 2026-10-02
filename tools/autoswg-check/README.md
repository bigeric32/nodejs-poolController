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
* **Projection accuracy:** for each reading, the algorithm re-run as of just before it with only the
  data logged by then, compared with what was measured. Error is `projected - measured` in ppm (positive
  means it projected too high). Shown as mean absolute error, RMSE, bias, the share within 1 and 2 ppm,
  and split by how long it had been since the previous reading.
* **What-if sweep:** the same scoring under other windows (7, 14, 21, 28, 42, 56 days), daylight
  weighting off, the chlorine credit toggled, and other anomaly tolerances. "Change" is the mean change
  in absolute error versus your current settings (negative is better) with a 90% range.
* **Anomalies:** FC rises beyond what the SWG output plus logged additions explain, at 1, 2 and 3 ppm.

## Options and tips

| option | what it does and how to choose it |
| --- | --- |
| `--tz America/New_York` | The pool's IANA time zone. Needed for daylight weighting and to place the SWG run window in local time. Without it everything is treated as UTC. On Windows the zone database may be missing: `pip install tzdata`, or use `--utc-offset -5` instead. |
| `--lat 40.7 --lon -74.0` | The pool's rough location, used to work out today's sunrise and sunset for the daylight weighting. 0.1 degrees is plenty. If the owner gave PoolMath a location the script uses it (rounded to 0.1 degrees); otherwise **without lat/lon the weighting is simply off**. In my test, turning it off made accuracy slightly worse, so it is worth giving. |
| `--swg-start 08:00` | Local time the SWG's daily run window starts (default 08:00). The run length comes from each PoolMath SWG entry (usually 12 hours). It only affects the part of a day since the last reading, so a rough value is fine; for a sunrise-to-sunset schedule use roughly sunrise. |
| `--window 21` | The averaging window the sweep treats as "current" (default 21 days). Leave it at the default for comparing pools; the sweep already shows the alternatives. |
| `--tolerance 2` | The FC anomaly tolerance in ppm (default 2; 0 turns the check off). Lower flags more intervals but also more ordinary test noise. |
| `--no-credit` | Don't credit liquid chlorine additions as FC added. Use it to see whether the credit helps for a given pool. |
| `--no-daylight` | Count time by the clock instead of weighting daylight. |
| `--daytime-share 0` | The daytime share of chlorine loss in percent. 0 (default) estimates it from the day length (about 56% in winter, 67% in spring/fall, 78% in summer). Only override it to test a theory. |
| `--gallons 12000` | Pool volume. Defaults to PoolMath's value; set it if that is wrong, because it scales the ppm credited for liquid chlorine. |
| `--days 365` | How far back to score readings (default 365). A shorter value focuses on recent behaviour; a longer one adds earlier seasons if the data goes back that far. |
| `--pool NAME` | Choose a pool when the account has several (default: the first). A part of the name is enough. |
| `--report` | `summary`, `accuracy`, `whatif`, `anomalies` or `all` (default). |
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
