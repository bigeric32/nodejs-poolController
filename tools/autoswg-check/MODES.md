# AutoSwg modes (DRAFT)

AutoSwg has a standard way of working and a few modes on top of it. Standard is the one in the quick guide: you test FC, log it in
PoolMath, press **Check Now**, read the recommendation and press **Apply**. This page covers the modes that act without that
routine. Away protection comes first, because it is the one you will use before a trip.

How the modes relate (the one on top wins):

| Mode | What it does | Paused by |
|---|---|---|
| Away protection | Uses the Vacation Target FC, holds the SWG at no less than the maintenance %, checks PoolMath on its own | nothing |
| Auto-Apply and the automatic check | Applies each recommendation without review, and re-checks PoolMath every "Check Every" hours | Away protection |
| Auto tune | Applies the Tune recommendation by itself once you have applied some yourself | Away protection |

Their settings are kept, shown grayed out, while Away protection is on, and act again when it ends.

## Away protection: a runbook for a trip

**What it is for.** A trip of a week or two. You raise the target before you go, and AutoSwg keeps FC safe while nobody is
testing: the SWG never drops below what the pool normally uses, it allows for dilution from heavy rain and for a power outage,
and the dashboard raises an alert if something stops the chlorinator making chlorine. When you are back, your first test takes
FC back to steady state. It does not replace testing, and it is not meant for a long absence.

### Before you leave

**Before you go, set your vacation target and turn on Away protection.** In order:

1. **Log your last FC test in PoolMath, then turn Away protection on.** A test logged after you turn it on ends it (see "When you
   are back"), so test first.
2. **Check the settings** under "Vacation: Away protection" and above it:
   * **Return to the maintenance % when the target period ends** must be checked. Away protection needs it, so each boost ends
     by itself. If it is off, Away protection stays off and the status line under the checkbox says so.
   * **Vacation Target FC**: the FC to aim for while you are away, higher than your normal Target FC so FC is a little high when
     you are back (a normal 8 might go with a vacation target of 10). Your normal Target FC is not changed.
   * **Storm or outage adds at most**: how many points a storm or outage may add to the SWG % the plan would have used (20 by
     default).
3. **Check "Away protection: keep FC safe while I am away" and save the settings.** Saving starts it, and the first check runs within
   a few seconds. You should see:
   * an **Away Mode Active** badge on the home panel, with the vacation target;
   * a blue note on the home panel saying what the first check did to the SWG % (it is never below the maintenance % while
     Away protection is on, so it may rise at once);
   * the calculation details saying that the target in force is the vacation target, not your normal one.
4. **Do a dry run before a real vacation.** It is a best practice to do a dry run of this before a real vacation, to be sure you are
   comfortable with it. A few days before you go, turn it on, check those three things, then uncheck it and save and check that the plan
   goes back to your normal target and the badge disappears.
5. **Before you leave the house:** make sure you can see the dashboard from outside your network, and note the SWG's own setting
   (the number it falls back to if njsPC cannot reach it).

### While you are away

* AutoSwg checks PoolMath every "Check Every" hours (12 by default) on its own and applies what it finds, with these limits:
  * The glide up to the vacation target is not limited.
  * The SWG % is never below the maintenance %.
  * A storm (a sharp fall in the chlorinator's salt reading) or an outage (njsPC was not running, so the equipment was off) may
    add chlorine, but only when your last test is 3 days old or more, by at most the points set above, and one event acts for
    at most 3 days.
  * Each boost ends by itself when its target period does, returning to the maintenance %.
* **What shows on the dashboard** (look at it once or twice a day):
  * the Away Mode Active badge and the Auto SWG status;
  * a red or orange alert for what the SWG cannot fix by itself: the chlorinator has not answered for 5 minutes while it should
    have power, a bad chlorinator status or no output in its run window, a planned step that did not happen, a stale or failed
    check, temperatures that stopped changing, an SWG run window that looks wrong, or a stretch when njsPC was not running;
  * the red "automatic change exceeded threshold" banner when an unattended check moved the SWG % by the warning threshold or
    more (10 points by default). Open the status popup to see why, then press Dismiss.

### When you are back

1. **Test FC and log it in PoolMath.** The next time AutoSwg reads PoolMath (a check, or the read it makes at least once a day)
   it ends Away protection by itself. Or press Check Now, or uncheck the box and save.
2. **The plan then uses your normal Target FC again and recalculates** against it, using the Run Periods setting for FC above or
   below the target. The SWG % is set for that, then returns to the maintenance % when the target period ends.
3. The notes about the end of Away protection clear at the next apply after that one.

### Things to know

* The vacation target is a separate setting, so your normal Target FC is never changed or lost.
* If you forget to turn it off, your first test when you are back ends it.
* Away protection acts for you only while it is on. Auto-Apply, the automatic check and auto tune do not act while it is on.

## Auto-Apply and the automatic check

(To be written.)

## Auto tune

(To be written.)

## Storm and outage response

(To be written.)
