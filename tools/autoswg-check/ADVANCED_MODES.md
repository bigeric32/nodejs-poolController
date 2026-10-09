# AutoSwg advanced modes (DRAFT)

**Use at your own risk.** Every mode above standard changes the chlorinator and the AutoSwg settings without anyone reviewing the change
first. They are meant for the author and for people who have read the code. Most owners do not need them.

The [guide](GUIDE.md) covers the standard way of working: you test FC, log it in PoolMath, press **Check Now**, read the recommendation
and press **Apply**. The "Vacations: Away protection" section of the [guide](GUIDE.md) covers Away protection, the one extra mode that is for everyone. This page covers
everything above those two.

## The mode ladder

The mode is a setting named `mode`. It is not on the settings screen. Set it in `poolConfig.json` (stop njsPC first) or through the config
API.

| Mode | What it adds |
|---|---|
| `standard` (the default) | Nothing on its own, except the optional return to the maintenance % and Away protection |
| `advanced` | **Auto-Apply Recommendations** and **Also check PoolMath automatically** become available |
| `automatic` | Advanced, plus **auto tune** and its automatic apply, and the **storm and outage response** setting |
| `developer` | Automatic, without the history gate and the accepted-Tune requirement, so every feature is available on any pool |

A pool that already had Auto-Apply or the automatic check turned on when this was added stays in `advanced`.

**What has to be true before they appear.** Besides the mode, the unattended features (Auto-Apply and the automatic check) need enough
history for the tuning tools to judge: at least 15 scorable FC readings, at least 1 SWG entry, and at least 42 days (the settings
`gateMinFcReadings`, `gateMinSwgEntries` and `gateMinDays`), and a **Tune that was run and accepted** (applied, or accepted as "your
settings look good"). Auto tune needs the automatic mode on top of that. `developer` skips the history and Tune requirements.

**When Away protection is on**, everything on this page is paused: the settings are kept, shown grayed out, and they act again when
Away protection ends. Away protection does its own checks while it is on.

## Auto-Apply Recommendations

* **What it does.** Applies a recommendation as soon as one is produced, with no review: from the **Refresh and Apply** button (which
  replaces **Refresh: Adjust %** while it is on), from **Check Now** (which then applies at once), and from the automatic check.
* **Check Now: New Target** stays available and always starts a new target from today's settings.
* **Refresh and Apply** re-reads PoolMath and decides between staying on the target already in force and starting a new one:
  * If projected FC is within the **New Target Date Threshold** of the target (1 ppm by default), the deadline already in force is kept
    ("close enough counts"), and the SWG steps to the maintenance % at that time.
  * If it has strayed further, or the target in force has changed since the last apply (including a different Vacation Target FC), a
    new target starts.
  * If a kept deadline is much longer than your Run Periods setting (it was pushed out earlier because consumption alone needed
    longer), the calculation details say so. **Check Now** starts over.
* **Warning Threshold** (10 points by default). When an unattended check moves the SWG % by at least this many points, the home panel
  shows a red "automatic change exceeded threshold" banner until you press Dismiss. Checks you start yourself (Check Now, Refresh and
  Apply, or turning Away protection on or off) never raise it.

## The automatic check

* Needs Auto-Apply. It re-reads PoolMath every **Check Every** hours (12 by default), optionally pinned to a time of day with
  **Starting At** when the interval is under 24 hours, and applies the result the same way Refresh and Apply does.
* Without it, Auto-Apply works only when you press a button.
* An alert is raised when a check has not run for more than twice the interval plus an hour, or when the last check failed.
* In every mode, PoolMath is also read at least once a day, so new tests, and the salt you add, are picked up without a check being run.

## Auto tune

* Needs the automatic mode. It runs **Tune** by itself after a number of new FC readings (10 by default).
* **Apply the Tune recommendation automatically** is a separate checkbox. It applies a recommendation only after you have applied a
  number of Tune recommendations yourself (2 by default), and only when all of these hold:
  * at least 30 scorable readings and 90 days of FC and SWG history behind the Tune;
  * the expected drop in the average error is at least 0.05 ppm;
  * the newest FC reading is no more than 14 days old;
  * the calculation beats "FC unchanged";
  * the same recommendation has come up on 2 automatic runs in a row.
* The settings page shows how many Tune recommendations you have applied and what the last automatic run did.

## Storm and outage response

* Away protection uses this response while it is on. In the automatic mode you can also turn it on by itself, as **Storm and outage
  response**. It needs **Return to the maintenance %**, so each boost ends by itself.
* It acts only when your last FC test is **3 days old or more**, when an unlogged loss is most likely:
  * **Dilution:** a fall in the chlorinator's salt reading of at least 7% and at least 150 ppm, less 2% for the noise in the reading
    (it moves in steps of 50 to 100 ppm), is taken as dilution from rain or a water change. It acts when that comes to at least
    0.2 ppm of FC.
  * **Outage:** time when njsPC was not running (found at start-up, 25 minutes or more) loses the SWG output it would have made inside
    its run window. It acts when that comes to at least 0.3 ppm.
* **What it does.** It lowers the projected FC by the estimated loss, which raises the SWG %, but by no more than **Storm or outage
  adds at most** points (20 by default) over the % the plan would have used without it. One event acts for at most **3 days**.
* It never lowers the SWG % below the maintenance %, and it does not limit the glide to a target you set.

## What is logged

Every apply, including each automatic one, is in Show History with what triggered it (a button, the automatic check, a step, auto tune)
and the numbers behind it. Settings changes are logged too, including changes made by auto tune.

## Dry-run checklist

Do each on a quiet day, with FC tested and logged, before relying on it.

* **Auto-Apply:** press Refresh and Apply twice. The first applies at once. The second, with nothing new in PoolMath, says there is
  nothing to refresh. Press Check Now: New Target and confirm it starts a new target.
* **The automatic check:** set Check Every to 1 hour with Starting At blank, save, and watch the log and the home panel for the next
  check. Put your settings back afterward.
* **The warning banner:** move the Warning Threshold down to 1 point, let an automatic check move the % by that much, and confirm the
  red banner appears and Dismiss clears it. Put the threshold back.
* **Auto tune:** leave automatic apply off at first and read what the automatic run reports.
* **The storm and outage response:** it needs a stale last reading, so it is easiest to see with Away protection on. See the
  "Vacations: Away protection" section of the [guide](GUIDE.md).
