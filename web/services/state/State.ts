/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022.  
Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import * as express from "express";
import * as os from "os";
import * as extend from "extend";

import { state, ICircuitState, LightGroupState, ICircuitGroupState, ChemicalDoseState, ChlorinatorState } from "../../../controller/State";
import { sys } from "../../../controller/Equipment";
import { utils } from '../../../controller/Constants';
import { logger } from "../../../logger/Logger";
import { DataLogger } from "../../../logger/DataLogger";
import { conn } from "../../../controller/comms/Comms";
import { config } from "../../../config/Config";

import { ServiceParameterError } from "../../../controller/Errors";
import { buildCombinedHistory, buildProjectionAccuracy, buildTune, buildWhatIfSweep, computeRecommendation, computeSwgCapacity, formatLocalDateTime, minutesToHHMM, nextScheduledCheck } from "../../../controller/AutoSwgService";
import type { AutoSwgParams, PageReadings } from "../../../controller/AutoSwgService";
import { appendTuneHistory, markLastTuneApplied, markLastTuneHeld, readTuneHistory } from "../../../controller/AutoSwgTuneHistory";
import type { TuneResult } from "../../../controller/AutoSwgService";
import { evaluateAutoTuneApply } from "../../../controller/AutoSwgAutoTune";
import { getAutoSwgReadiness } from "../../../controller/AutoSwgReadiness";
import { saltHistory, stormEventStatus } from "../../../controller/AutoSwgSaltHistory";
import { AutoSwgWatch, inRunWindow, minutesOfDayIn } from "../../../controller/AutoSwgWatch";
import { outputLog } from "../../../controller/AutoSwgOutputLog";
import type { SaltAddition } from "../../../controller/AutoSwgSaltHistory";
import { appendAutoSwgHistory, logAutoSwgSettingChanges, readAutoSwgHistory, snapshotAutoSwgSettings, toLocalSwgEntries, AutoSwgApplyTrigger, AUTO_SWG_ALGORITHM_VERSION } from "../../../controller/AutoSwgHistory";
import { archivedChlorineAdditions, archivedCyaReadings, archivedFcReadings, archivedSaltAdditions, archivedSwgEvents, archivedWaterTemps, saltAdditionPpm, topUpPoolMathArchive, isPoolMathArchiveCurrent, poolMathArchiveSummary, refreshPoolMathArchiveFromPage, syncPoolMathArchive } from "../../../controller/AutoSwgPoolMathArchive";

// 'HH:MM' wall-clock time of `dt` in `timeZone`.
function formatHHMMInZone(dt: Date, timeZone: string): string {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    const parts: any = {};
    for (const p of dtf.formatToParts(dt)) parts[p.type] = p.value;
    return `${parts.hour}:${parts.minute}`;
}

// Prefer the actual configured schedule's run window over the hand-typed
// swgStartTime/swgStopTime fields, so the capacity calculation can't silently drift
// out of sync with when the pump/SWG really runs. The pump is guaranteed to run at
// least as long as the SWG schedule, so the schedule's start/end times are the more
// reliable source of truth when one is configured (see AutoSwg.scheduleId in
// controller/Equipment.ts).
//
// For a sunrise/sunset-based schedule, the schedule's own startTime/endTime config
// fields are just static minutes-of-day (whatever sunrise/sunset happened to be when
// the schedule was last saved) -- the actual daily run window is recalculated by
// ScheduleTime.calcSchedule() (see controller/State.ts) from the day's real sunrise/
// sunset. Prefer that live, already-calculated window so the capacity/duty-cycle math
// tracks the real (seasonally shifting) window instead of drifting away from it; fall
// back to the static minutes only if today's window hasn't been calculated yet.
// When the step to the maintenance % should happen. At the end of the target period, unless that falls while the SWG is off (outside its run window): then
// nothing could change at that moment, so the step is set for one minute after the SWG next starts, when the new % first matters and while it is running, and
// the displayed time says so. A window that runs past midnight is left alone.
function autoSwgStepTime(target: Date): Date {
    try {
        let cfg = sys.autoSwg, win = resolveAutoSwgRunWindow(cfg);
        let toMin = (s: string) => { let m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN; };
        let a = toMin(win.swgStartTime), b = toMin(win.swgStopTime);
        if (isNaN(a) || isNaN(b) || b <= a) return target;
        let t = minutesOfDayIn(cfg.timezone, target.getTime());
        if (t >= a && t < b) return target;
        let wait = t < a ? (a + 1 - t) : (1440 - t + a + 1);
        return new Date(target.getTime() + Math.max(wait, 0) * 60000);
    }
    catch (err) { return target; }
}

// The run window the calculation will use (a selected schedule's own window wins over the typed times) and how many ppm/day the SWG makes in it at its
// 100% setting. For the settings page; it changes nothing.
export function autoSwgRunWindowInfo() {
    try {
        let cfg = sys.autoSwg;
        let win = resolveAutoSwgRunWindow(cfg);
        let cap = computeSwgCapacity({ gallons: cfg.gallons, swgLbsPerDay: cfg.swgLbsPerDay, swgStartTime: win.swgStartTime, swgStopTime: win.swgStopTime });
        return { start: win.swgStartTime, stop: win.swgStopTime, hours: cap.hours, ppmPerDayAtFull: cap.ppmPerDayAtFull, note: win.scheduleNote };
    }
    catch (err) { return undefined; }
}

function resolveAutoSwgRunWindow(cfg: typeof sys.autoSwg): { swgStartTime: string; swgStopTime: string; scheduleNote?: string } {
    let swgStartTime = cfg.swgStartTime;
    let swgStopTime = cfg.swgStopTime;
    let scheduleNote: string;
    if (cfg.scheduleId >= 0) {
        let sched = sys.schedules.toArray().find(s => s.id === cfg.scheduleId);
        if (sched && !sched.disabled) {
            let ssched = state.schedules.getItemById(sched.id, false);
            // Force today's window to be (re)calculated now rather than trusting the
            // periodic status-check timer to have already refreshed it recently --
            // calcSchedule() is a no-op if it's already current for today.
            ssched.scheduleTime.calcSchedule(state.time, sched);
            let calcStart = ssched.scheduleTime.startTime;
            let calcEnd = ssched.scheduleTime.endTime;
            if (calcStart && calcEnd && calcEnd.getTime() > calcStart.getTime()) {
                swgStartTime = formatHHMMInZone(calcStart, cfg.timezone);
                swgStopTime = formatHHMMInZone(calcEnd, cfg.timezone);
                scheduleNote = `Run window ${swgStartTime}-${swgStopTime} taken from today's calculated window for schedule #${sched.id} (circuit ${sched.circuit}).`;
            }
            else if (typeof sched.startTime === 'number' && typeof sched.endTime === 'number' && sched.endTime > sched.startTime) {
                swgStartTime = minutesToHHMM(sched.startTime);
                swgStopTime = minutesToHHMM(sched.endTime);
                scheduleNote = `Run window ${swgStartTime}-${swgStopTime} taken from schedule #${sched.id}'s configured (not yet recalculated) times (circuit ${sched.circuit}).`;
            }
            else {
                scheduleNote = `Configured schedule #${cfg.scheduleId} has no calculable run window -- falling back to the manually-entered run window (${swgStartTime}-${swgStopTime}).`;
            }
        }
        else {
            scheduleNote = `Configured schedule #${cfg.scheduleId} is missing or disabled -- falling back to the manually-entered run window (${swgStartTime}-${swgStopTime}).`;
        }
    }
    return { swgStartTime, swgStopTime, scheduleNote };
}

// Set just before the AutoSwg apply route changes the setpoint, so the change it
// causes (which the setpoint hook below would otherwise see, possibly again when
// the panel echoes it back) isn't also logged as a manual one.
let autoSwgApplyInFlight: { pct: number; at: number } | undefined;
// Set when the settings are saved with Away protection newly turned on or off: the first automatic apply after it is something you just did on purpose, so it
// is not flagged as an unreviewed change (the red banner) and is explained in a plain note instead.
let autoSwgAwayToggle: { at: number; on: boolean } | undefined;
export function noteAutoSwgAwayToggled(on: boolean) { autoSwgAwayToggle = { at: Date.now(), on: on }; }
const AUTO_SWG_APPLY_ECHO_MS = 2 * 60 * 1000;

// Logs a change to the AutoSwg chlorinator's pool setpoint that didn't come from
// the apply route (API, socket, MQTT, or a panel message).
function logManualSwgChange(previousPct: number, pct: number) {
    try {
        let cfg = sys.autoSwg;
        let win = resolveAutoSwgRunWindow(cfg);
        let capacity: { ppmPerDayAtFull: number; hours: number };
        try { capacity = computeSwgCapacity({ gallons: cfg.gallons, swgLbsPerDay: cfg.swgLbsPerDay, swgStartTime: win.swgStartTime, swgStopTime: win.swgStopTime }); }
        catch (err) { logger.warn(`AutoSwg: logging a manual SWG % change without a ppm/day figure: ${err.message}`); }
        appendAutoSwgHistory({
            source: 'manual',
            appliedAt: new Date().toISOString(),
            appliedPct: pct,
            previousPct: previousPct,
            ppmPerDay: capacity && isFinite(capacity.ppmPerDayAtFull) ? Math.round(capacity.ppmPerDayAtFull * pct) / 100 : undefined,
            hrs: capacity ? capacity.hours : undefined,
            inputs: {
                gallons: cfg.gallons,
                swgLbsPerDay: cfg.swgLbsPerDay,
                swgStartTime: win.swgStartTime,
                swgStopTime: win.swgStopTime,
                timezone: cfg.timezone,
                runWindowNote: win.scheduleNote,
            },
        });
    }
    catch (err) { logger.error(`AutoSwg: SWG % changed to ${pct}% but could not write the history log: ${err.message}`); }
}

// Clears every field a Check Now (/recommend) sets, leaving lastApplied*/step* untouched.
// Used both by /state/autoSwg/cancel (an explicit dismiss) and by a manual setpoint change
// (which makes the preview stale -- its "current %" input no longer holds, and its
// recommendation was passed over), so the calculation screen doesn't keep showing a
// no-longer-relevant preview alongside the "what's actually running now" status.
function clearAutoSwgCalculation() {
    state.autoSwg.pending = false;
    state.autoSwg.lastCheckedAt = undefined;
    state.autoSwg.currentPct = undefined;
    state.autoSwg.recommendedPct = undefined;
    state.autoSwg.maintenancePct = undefined;
    state.autoSwg.avgConsumptionPpmPerDay = undefined;
    state.autoSwg.avgConsumptionSummary = undefined;
    state.autoSwg.avgWindowStart = undefined;
    state.autoSwg.avgWindowEnd = undefined;
    state.autoSwg.projectedCurrentFc = undefined;
    state.autoSwg.details = undefined;
    state.autoSwg.rationale = undefined;
    state.autoSwg.targetWarning = undefined;
    state.autoSwg.targetInfo = undefined;
    state.autoSwg.staleFcNote = undefined;
    state.autoSwg.saltNote = undefined;
    state.autoSwg.fcAnomalyNote = undefined;
    state.autoSwg.ratingNote = undefined;
    state.autoSwg.error = undefined;
}

// Automatic step: after applying a % that differs from maintenance (catching up toward
// targetFc from below, or backing off toward it from above), move to the maintenance %
// once the target period has passed -- the direction depends on which side of maintenance the
// applied % was on. The due time and % live in state.autoSwg (persisted); this timer is
// re-armed from them at startup.
const AUTO_SWG_STEP_MIN_DELAY_MS = 60 * 1000;
const AUTO_SWG_STEP_RETRY_MS = 5 * 60 * 1000;
const AUTO_SWG_TIMER_MAX_MS = 2 * 24 * 60 * 60 * 1000;
let autoSwgStepTimer: NodeJS.Timeout | undefined;

function clearAutoSwgStep() {
    if (autoSwgStepTimer) clearTimeout(autoSwgStepTimer);
    autoSwgStepTimer = undefined;
    if (state.autoSwg.stepAt || typeof state.autoSwg.stepPct !== 'undefined') {
        state.autoSwg.stepAt = undefined;
        state.autoSwg.stepPct = undefined;
        state.autoSwg.emitEquipmentChange();
    }
}

function armAutoSwgStep(minDelayMs: number = 0) {
    if (autoSwgStepTimer) clearTimeout(autoSwgStepTimer);
    autoSwgStepTimer = undefined;
    let at = state.autoSwg.stepAt ? new Date(state.autoSwg.stepAt).getTime() : NaN;
    if (isNaN(at) || typeof state.autoSwg.stepPct !== 'number') return;
    // Wake at least every couple of days so a long target window never overflows setTimeout.
    let delay = Math.min(Math.max(at - Date.now(), minDelayMs), AUTO_SWG_TIMER_MAX_MS);
    autoSwgStepTimer = setTimeout(() => { runAutoSwgStep().catch(err => logger.error(`AutoSwg: step failed: ${err.message}`)); }, delay);
}

async function runAutoSwgStep() {
    autoSwgStepTimer = undefined;
    let at = state.autoSwg.stepAt ? new Date(state.autoSwg.stepAt).getTime() : NaN;
    let pct = state.autoSwg.stepPct;
    if (isNaN(at) || typeof pct !== 'number') return;
    if (!sys.autoSwg.autoStepEnabled) { clearAutoSwgStep(); return; }
    if (Date.now() < at) { armAutoSwgStep(); return; }
    let cfg = sys.autoSwg;
    if (cfg.chlorinatorId < 0) { clearAutoSwgStep(); return; }
    let previous = state.autoSwg.currentPct;
    let direction = pct > previous ? 'up' : 'down';
    autoSwgApplyInFlight = { pct: pct, at: Date.now() };
    try { await sys.board.chlorinator.setChlorAsync({ id: cfg.chlorinatorId, poolSetpoint: pct }); }
    catch (err) {
        autoSwgApplyInFlight = undefined;
        logger.error(`AutoSwg: step ${direction} to ${pct}% failed (${err.message}); retrying in ${AUTO_SWG_STEP_RETRY_MS / 60000} minutes.`);
        armAutoSwgStep(AUTO_SWG_STEP_RETRY_MS);
        return;
    }
    logger.info(`AutoSwg: stepped SWG ${direction} to the maintenance ${pct}% now that the target period has ended.`);
    // A step is an apply too: the notes about the end of Away protection have done their job by now.
    state.autoSwg.awayChangeNote = undefined;
    if (!cfg.awayActive && cfg.awayEndedNote) cfg.clearAwayEnded();
    state.autoSwg.lastAppliedAt = new Date().toISOString();
    state.autoSwg.lastAppliedPct = pct;
    state.autoSwg.currentPct = pct;
    // This step has no calculation of its own (it's just moving to the already-known
    // maintenance %), so give it its own one-line explanation rather than leaving whatever
    // rationale happened to be sitting there from an unrelated, possibly much older check.
    state.autoSwg.lastAppliedRationale = [`Automatically stepped ${direction} to the maintenance ${pct}% now that the target period ended (from ${previous}%).`];
    // The original glide-to-target completed (that's what this step is) -- there's no
    // longer an in-flight deadline to refine toward, just steady maintenance.
    let completedTargetDate = state.autoSwg.lastAppliedTargetDate;
    state.autoSwg.lastAppliedTargetDate = undefined;
    state.autoSwg.lastAppliedTargetWarning = undefined;
    state.autoSwg.lastAppliedTargetInfo = undefined;
    state.autoSwg.lastAppliedStaleFcNote = undefined;
    state.autoSwg.lastAppliedFcAnomalyNote = undefined;
    state.autoSwg.lastAppliedRatingNote = undefined;
    try {
        let win = resolveAutoSwgRunWindow(cfg);
        let capacity: { ppmPerDayAtFull: number; hours: number };
        try { capacity = computeSwgCapacity({ gallons: cfg.gallons, swgLbsPerDay: cfg.swgLbsPerDay, swgStartTime: win.swgStartTime, swgStopTime: win.swgStopTime }); }
        catch (err) { logger.warn(`AutoSwg: logging the step without a ppm/day figure: ${err.message}`); }
        appendAutoSwgHistory({
            source: 'auto',
            trigger: 'step',
            appliedAt: state.autoSwg.lastAppliedAt,
            appliedPct: pct,
            recommendedPct: pct,
            previousPct: previous,
            ppmPerDay: capacity && isFinite(capacity.ppmPerDayAtFull) ? Math.round(capacity.ppmPerDayAtFull * pct) / 100 : undefined,
            hrs: capacity ? capacity.hours : undefined,
            inputs: { gallons: cfg.gallons, swgLbsPerDay: cfg.swgLbsPerDay, swgStartTime: win.swgStartTime, swgStopTime: win.swgStopTime, timezone: cfg.timezone, runWindowNote: win.scheduleNote },
            outputs: { autoStep: true, direction: direction, targetFc: state.autoSwg.lastAppliedTargetFc, targetDate: completedTargetDate },
        });
    }
    catch (err) { logger.error(`AutoSwg: stepped ${direction} to ${pct}% but could not write the history log: ${err.message}`); }
    clearAutoSwgStep();
}

// What a recommendation run should aim at:
//  'new'    -- a new target from today's configured FC, in the above/below days window
//              that applies (Check Now: starts a fresh target and deadline)
//  'refine' -- stay on course for the in-flight target no matter what (Refresh: re-works
//              the % against the original FC and deadline with fresh PoolMath data)
//  'auto'   -- either, decided by where the projected FC is: more than the configured
//              new-target-date threshold from the target FC starts a new target date, otherwise it
//              refreshes the in-flight one (Refresh and Apply, and the periodic check)
type AutoSwgCheckMode = 'new' | 'refine' | 'auto';

// Runs a Check Now-style recommendation against the configured PoolMath page and
// populates state.autoSwg with the result -- shared by every way of asking for one, and by
// the fully-automatic mode's periodic check, so they can't drift apart.
// Today's sunrise and sunset as 'HH:MM' in `timeZone`, for weighting consumption by daylight;
// empty (so time is counted by the clock) when the controller's location isn't set up.
function autoSwgSunTimes(timeZone: string): { sunrise?: string; sunset?: string } {
    try {
        if (state.heliotrope.isValid && state.heliotrope.sunrise && state.heliotrope.sunset) {
            return { sunrise: formatHHMMInZone(state.heliotrope.sunrise, timeZone), sunset: formatHHMMInZone(state.heliotrope.sunset, timeZone) };
        }
    }
    catch (err) { logger.warn(`AutoSwg: could not read today's sunrise/sunset: ${err.message}`); }
    return {};
}

// Rounds an HH:MM time of day to the nearest 10 minutes, so a real change to the run window counts but the minute or two a
// sunrise or sunset based window drifts each day does not. Anything else (for example '7am') is used as it is.
function windowKeyTime(t: string): string {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m) return String(t || '');
    const mins = Math.round((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 10) * 10;
    return `${Math.floor(mins / 60) % 24}:${mins % 60}`;
}
// The settings that decide what a calculation aims at or how it computes (see
// lastAppliedSettingsKey): changing any of them changes the number a Refresh would give,
// so it shouldn't be skipped for want of a new FC reading. That includes the run window the
// calculation uses, whether typed in or taken from the selected SWG schedule, to the nearest 10
// minutes: editing the schedule counts, the daily drift of a sunrise or sunset based window does not.
// What the calculation says about Away protection: while it is on, the vacation target and what it goes back to; for three days after it ended, what ending it did.
function autoSwgAwayParams(cfg: typeof sys.autoSwg): { active: boolean; normalTargetFc?: number; endedNote?: string } {
    if (cfg.awayActive) return { active: true, normalTargetFc: cfg.targetFc };
    const endedAt = cfg.awayEndedAt ? new Date(cfg.awayEndedAt).getTime() : NaN;
    if (cfg.awayEndedNote && !isNaN(endedAt) && Date.now() - endedAt < 3 * 86400000) return { active: false, endedNote: cfg.awayEndedNote };
    return { active: false };
}
function autoSwgSettingsKey(): string {
    let cfg = sys.autoSwg;
    let start = cfg.swgStartTime, stop = cfg.swgStopTime;
    try { const win = resolveAutoSwgRunWindow(cfg); start = win.swgStartTime; stop = win.swgStopTime; }
    catch (err) { /* the typed-in window is the fallback */ }
    return [
        cfg.effectiveTargetFc, cfg.targetPeriodsAbove, cfg.targetPeriodsBelow, cfg.newTargetDateThresholdPpm,
        cfg.windowDays, cfg.gallons, cfg.swgLbsPerDay, cfg.timezone, cfg.daytimeLossSharePct, cfg.creditChlorineAdditions, cfg.fcAnomalyTolerancePpm, cfg.projectionWeight, cfg.projectionTaperStartDays, cfg.projectionTaperEndDays, cfg.overshootPpmPerDay, cfg.protectOvernightLow, cfg.nightBurnRatio, cfg.burnTempAdjust, cfg.stormResponseEnabled, cfg.stormMaxExtraPct, cfg.awayStatus,
        cfg.shareCode, cfg.poolName, cfg.scheduleId, windowKeyTime(start), windowKeyTime(stop)
    ].join('|');
}

// Resolves to a skip message (and changes nothing) when a Refresh has no new FC reading to
// work from, otherwise undefined.
async function runAutoSwgRecommendation(mode: AutoSwgCheckMode, extraRationaleNote?: string): Promise<string | undefined> {
    let cfg = sys.autoSwg;
    if (!cfg.shareCode) throw new ServiceParameterError('AutoSwg is not configured: shareCode is required.', 'autoSwg', 'shareCode', cfg.shareCode);
    // The in-flight target (the last apply's FC and deadline), if there's one still ahead.
    let inFlight: { targetFc: number; targetDate: Date; strayPpm: number } | undefined;
    let targetChangeNote: string | undefined;
    if (mode !== 'new') {
        let at = state.autoSwg.lastAppliedTargetDate ? new Date(state.autoSwg.lastAppliedTargetDate).getTime() : NaN;
        if (mode === 'refine') {
            if (!state.autoSwg.lastAppliedTargetDate) throw new ServiceParameterError('There is no in-flight AutoSwg target to refine toward -- apply a recommendation first.', 'autoSwg', 'lastAppliedTargetDate', state.autoSwg.lastAppliedTargetDate);
            // With no pending step to clear it (auto-step off), a deadline can pass and
            // linger -- there's nothing left to re-aim at, and a non-positive window would
            // quietly degrade to the maintenance % rather than say so.
            if (isNaN(at) || at <= Date.now()) throw new ServiceParameterError('The target date of the last AutoSwg apply has already passed, so there is nothing left to refine toward -- run Check Now to start a new target.', 'autoSwg', 'lastAppliedTargetDate', state.autoSwg.lastAppliedTargetDate);
        }
        // A Target FC changed since the last apply is a request for a new target: staying on course for the old one would ignore what you just set (and
        // the pending step would keep naming the old target). Refine is the explicit "stay on the in-flight target" and keeps it.
        let lastTarget = state.autoSwg.lastAppliedTargetFc;
        let lastPeriods = state.autoSwg.lastAppliedPeriodsKey;
        if (mode === 'auto' && typeof lastTarget === 'number' && Math.abs(cfg.effectiveTargetFc - lastTarget) > 1e-9) {
            targetChangeNote = `The target in force changed from ${lastTarget} to ${cfg.effectiveTargetFc} ppm since the last apply${cfg.awayActive ? ' (the vacation target, with Away protection on)' : ''}, so this starts a new target instead of staying on course for the old one.`;
        }
        else if (mode === 'auto' && typeof lastPeriods === 'string' && lastPeriods !== `${cfg.targetPeriodsAbove}|${cfg.targetPeriodsBelow}`) {
            targetChangeNote = `The Run Periods to Target were changed (above|below: ${lastPeriods.replace('|', ' | ')} to ${cfg.targetPeriodsAbove} | ${cfg.targetPeriodsBelow}) since the last apply, so this starts a new target instead of staying on course for the old one.`;
        }
        else if (!isNaN(at) && at > Date.now() && typeof state.autoSwg.lastAppliedTargetFc === 'number') {
            inFlight = { targetFc: state.autoSwg.lastAppliedTargetFc, targetDate: new Date(at), strayPpm: mode === 'refine' ? Infinity : cfg.newTargetDateThresholdPpm };
        }
    }
    let { swgStartTime, swgStopTime, scheduleNote } = resolveAutoSwgRunWindow(cfg);
    let sunTimes = autoSwgSunTimes(cfg.timezone);
    let chlorRecord = sys.chlorinators.toArray().find(c => c.id === cfg.chlorinatorId);
    let schlor = chlorRecord ? state.chlorinators.getItemById(chlorRecord.id, false) : undefined;
    // The storm response: whether it may act on a salt drop now (it must be on, the return to the maintenance % must be on so the extra ends by
    // itself, and one event may only keep the SWG raised for stormMaxDays; see stormEventStatus).
    let saltDrop = saltHistory.recentDrop(Date.now(), autoSwgSaltAdditions());
    let storm: { apply: boolean; maxExtraPct: number } | undefined;
    let stormNewEvent = false;
    let stormOutages: { from: string; to: string }[] | undefined;
    if ((cfg.stormResponseEnabled || cfg.awayActive) && cfg.autoStepEnabled) {
        storm = { apply: true, maxExtraPct: cfg.stormMaxExtraPct };
        if (saltDrop) {
            let ev = stormEventStatus(state.autoSwg.stormStartedAt, state.autoSwg.stormStartPct, saltDrop.pct, cfg.stormMaxDays);
            storm.apply = ev.apply;
            stormNewEvent = ev.newEvent;
        }
        // Outages (njsPC not running) from the last stormMaxDays days: a shortfall the response makes up for that long, like a dilution event.
        let since = Date.now() - cfg.stormMaxDays * 86400000;
        stormOutages = (state.autoSwg.outages || []).filter(o => o && new Date(o.to).getTime() >= since).map(o => ({ from: o.from, to: o.to }));
    }
    let result = await computeRecommendation({
        shareCode: cfg.shareCode,
        poolName: cfg.poolName || undefined,
        gallons: cfg.gallons,
        swgLbsPerDay: cfg.swgLbsPerDay,
        swgStartTime: swgStartTime,
        swgStopTime: swgStopTime,
        timezone: cfg.timezone,
        windowDays: cfg.windowDays,
        targetFc: cfg.effectiveTargetFc,
        targetPeriodsAbove: cfg.targetPeriodsAbove,
        targetPeriodsBelow: cfg.targetPeriodsBelow,
        away: autoSwgAwayParams(cfg),
        inFlight: inFlight,
        sunriseTime: sunTimes.sunrise,
        sunsetTime: sunTimes.sunset,
        daytimeSharePct: cfg.daytimeLossSharePct,
        nightBurnRatio: cfg.nightBurnRatio,
        creditChlorineAdditions: cfg.creditChlorineAdditions,
        fcAnomalyTolerancePpm: cfg.fcAnomalyTolerancePpm,
        projectionWeight: cfg.projectionWeight,
        projectionTaperStartDays: cfg.projectionTaperStartDays,
        projectionTaperEndDays: cfg.projectionTaperEndDays,
        overshootPpmPerDay: cfg.overshootPpmPerDay,
        troughFloor: cfg.protectOvernightLow,
        burnTempAdjust: cfg.burnTempAdjust,
        saltDrop: saltDrop,
        storm: storm,
        outages: stormOutages,
    }, undefined, toLocalSwgEntries(readAutoSwgHistory()), refreshAutoSwgArchiveFromPage);
    // Away protection ends by itself when an FC reading logged in PoolMath after it was turned on shows up: the test you take when you are back, or any test
    // while you are away. Everything it was holding back (Auto-Apply and the rest) acts again from here, on a fresh reading.
    // When ending Away protection put the Target FC back, this calculation was made against the vacation target: do it again against the target now in force,
    // so what is shown and applied is what the restored target calls for.
    if (endAwayOnNewReading(result.mostRecentFc)) return await runAutoSwgRecommendation(mode, extraRationaleNote);
    // A Refresh works from fresh PoolMath data; if the data it read (readings, additions, SWG entries)
    // is exactly what the last apply used -- the newest FC reading is the very one it was based on,
    // and nothing was added, edited or deleted -- there is nothing new and re-running would only restate
    // the same number (or nudge it with extrapolation). Leave everything as it is. Check Now
    // ('new') always runs -- it's the explicit "start over" and also picks up config changes.
    if (mode !== 'new' && inFlight && state.autoSwg.lastAppliedFcAt && result.mostRecentFc && result.mostRecentFc.ts === state.autoSwg.lastAppliedFcAt && state.autoSwg.lastAppliedSettingsKey === autoSwgSettingsKey() && state.autoSwg.lastAppliedDataKey === result.dataKey) {
        return `No new FC reading in PoolMath since ${formatLocalDateTime(new Date(result.mostRecentFc.ts), cfg.timezone)}; nothing to refresh.`;
    }
    if (targetChangeNote) result.rationale.unshift(targetChangeNote);
    if (extraRationaleNote) result.rationale.unshift(extraRationaleNote);
    if (scheduleNote) result.rationale.unshift(scheduleNote);
    state.autoSwg.lastCheckedAt = new Date().toISOString();
    // What this specific calculation was actually aiming for -- a new target (today's
    // configured FC, with a deadline in the above/below window that applied, counted from
    // now), or, when it stayed on course, the in-flight target's original FC and the
    // exact original deadline. Either way, applyAutoSwgRecommendation() uses exactly this
    // pair rather than re-deriving anything from live config at apply time.
    state.autoSwg.pendingTargetFc = result.targetFcUsed;
    state.autoSwg.pendingTargetDate = result.targetDateUsed;
    state.autoSwg.pendingPeriodsKey = `${cfg.targetPeriodsAbove}|${cfg.targetPeriodsBelow}`;
    state.autoSwg.targetWarning = result.targetWarning;
    state.autoSwg.targetInfo = result.targetInfo;
    state.autoSwg.staleFcNote = result.staleFcNote;
    state.autoSwg.fcAnomalyNote = result.fcAnomalyNote;
    state.autoSwg.ratingNote = result.ratingNote;
    state.autoSwg.currentPct = schlor ? schlor.targetOutput : result.currentPct;
    // recommendedPct is what Apply sends to the chlorinator, so it needs to be
    // the duty cycle that actually reaches targetFc within the target window -- not
    // just the one that treads water at the current level. Plain steady-state
    // "match demand" is kept as maintenancePct for context only (it's also
    // still spelled out in the rationale text below).
    state.autoSwg.recommendedPct = result.recommendedPctForTarget;
    state.autoSwg.maintenancePct = result.recommendedPct;
    state.autoSwg.avgConsumptionPpmPerDay = result.avgConsumptionPpmPerDay;
    state.autoSwg.avgConsumptionSummary = result.avgConsumptionSummary;
    state.autoSwg.avgWindowStart = result.avgWindowStart;
    state.autoSwg.avgWindowEnd = result.avgWindowEnd;
    state.autoSwg.projectedCurrentFc = result.projectedCurrentFc;
    state.autoSwg.saltNote = result.saltNote;
    if (result.stormApplied && saltDrop && stormNewEvent) {
        // the first time the response acts on an event, note when and how deep the drop was, so it cannot run on for longer than stormMaxDays
        state.autoSwg.stormEventKey = saltDrop.fromAt;
        state.autoSwg.stormStartedAt = new Date().toISOString();
        state.autoSwg.stormStartPct = saltDrop.pct;
        logger.info(`AutoSwg: storm response acting on a ${(saltDrop.pct * 100).toFixed(0)}% fall in salt (${Math.round(saltDrop.fromPpm)} to ${Math.round(saltDrop.toPpm)} ppm) with a stale FC reading; it may keep the SWG raised for up to ${cfg.stormMaxDays} days.`);
    }
    state.autoSwg.details = {
        inputs: result.inputs,
        swgCapacityPpmPerDay: result.swgCapacityPpmPerDay,
        swgRunHours: result.swgRunHours,
        avgWindowExtended: result.avgWindowExtended,
        mostRecentFc: result.mostRecentFc,
        settingsKey: autoSwgSettingsKey(),
        dataKey: result.dataKey,
        mostRecentCya: result.mostRecentCya,
        mostRecentSwg: result.mostRecentSwg,
        localSwgEntriesUsed: result.localSwgEntriesUsed,
        poolMathSwgEntriesReplaced: result.poolMathSwgEntriesReplaced,
        targetRefreshed: result.refreshed,
        targetStrayPpm: result.targetStrayPpm,
        targetThresholdPpm: result.targetThresholdPpm,
        targetDateExtended: result.targetDateExtended,
        projectedFcRange: result.projectedFcRange,
        stormApplied: result.stormApplied,
        stormLossPpm: result.stormLossPpm,
        projectedFcBeforeStorm: result.projectedFcBeforeStorm,
        targetMarginPpm: result.targetMarginPpm,
        burnTempNote: result.burnTempNote,
        runHoursInPeriod: result.runHoursInPeriod,
        periodDayEquivalents: result.periodDayEquivalents,
        troughAddPpm: result.troughAddPpm,
    };
    state.autoSwg.rationale = result.rationale;
    state.autoSwg.error = undefined;
    state.autoSwg.pending = true;
    state.autoSwg.emitEquipmentChange();
    return undefined;
}

// The calculation's inputs include the PoolMath share code and pool name. Keep them out of the history records so
// an export of the history can be shared.
function withoutPrivateInputs(inputs: any): any {
    if (!inputs) return inputs;
    const copy = Object.assign({}, inputs);
    delete copy.shareCode;
    delete copy.poolName;
    return copy;
}

// Applies the currently pending AutoSwg recommendation to the chlorinator -- shared by
// the manual /apply route (isAutoApply=false, a human just reviewed the number on screen)
// and fully-automatic mode's unattended apply (isAutoApply=true, nobody reviewed it, so
// the magnitude gets checked against autoApplyWarnThresholdPct and flagged for the
// dashboard if it's large). `pctOverride` lets a manual apply send a value other than the
// plain recommendation; the automatic path never overrides it.
async function applyAutoSwgRecommendation(isAutoApply: boolean, pctOverride?: number, trigger?: AutoSwgApplyTrigger): Promise<ChlorinatorState> {
    if (!state.autoSwg.pending) throw new ServiceParameterError('There is no pending AutoSwg recommendation to apply. Run /state/autoSwg/recommend first.', 'autoSwg', 'pending', state.autoSwg.pending);
    if (sys.autoSwg.chlorinatorId < 0) throw new ServiceParameterError('AutoSwg is not configured with a target chlorinatorId.', 'autoSwg', 'chlorinatorId', sys.autoSwg.chlorinatorId);
    let pct = typeof pctOverride !== 'undefined' ? pctOverride : state.autoSwg.recommendedPct;
    let previousAppliedPct = state.autoSwg.lastAppliedPct;
    let previousTargetDate = state.autoSwg.lastAppliedTargetDate;
    autoSwgApplyInFlight = { pct: pct, at: Date.now() };
    let schlor: ChlorinatorState;
    try { schlor = await sys.board.chlorinator.setChlorAsync({ id: sys.autoSwg.chlorinatorId, poolSetpoint: pct }); }
    catch (err) { autoSwgApplyInFlight = undefined; throw err; }
    state.autoSwg.lastAppliedAt = new Date().toISOString();
    state.autoSwg.lastAppliedPct = pct;
    // Snapshot the explanation behind THIS calculation now, since `rationale` gets
    // overwritten by the next Check Now even if that one is never applied -- this is
    // what stays available as "the text behind what's actually running right now".
    state.autoSwg.lastAppliedRationale = state.autoSwg.rationale;
    // Use whatever target this specific calculation actually aimed for (set by
    // runAutoSwgRecommendation) rather than re-deriving one from live config here -- a
    // refine's whole point is to preserve the ORIGINAL target FC/date, and re-deriving from
    // today's live config would silently reset it back to "the target window from right now"
    // on every apply, undermining that. If something applied without ever going through
    // runAutoSwgRecommendation (shouldn't normally happen, since /apply requires
    // state.autoSwg.pending, which only that function sets) there's no date to record, and
    // none is invented -- so no refine is offered and no step is scheduled off it.
    state.autoSwg.lastAppliedTargetFc = typeof state.autoSwg.pendingTargetFc === 'number' ? state.autoSwg.pendingTargetFc : sys.autoSwg.effectiveTargetFc;
    state.autoSwg.lastAppliedTargetDate = state.autoSwg.pendingTargetDate;
    state.autoSwg.lastAppliedPeriodsKey = state.autoSwg.pendingPeriodsKey;
    state.autoSwg.lastAppliedTargetWarning = state.autoSwg.targetWarning;
    state.autoSwg.lastAppliedTargetInfo = state.autoSwg.targetInfo;
    state.autoSwg.lastAppliedStaleFcNote = state.autoSwg.staleFcNote;
    state.autoSwg.lastAppliedFcAnomalyNote = state.autoSwg.fcAnomalyNote;
    state.autoSwg.lastAppliedRatingNote = state.autoSwg.ratingNote;
    state.autoSwg.lastAppliedDataKey = state.autoSwg.details ? state.autoSwg.details.dataKey : undefined;
    // Which FC reading this apply was based on, so a later Refresh can tell whether
    // PoolMath has anything newer (see the skip in runAutoSwgRecommendation).
    let appliedFc = state.autoSwg.details ? state.autoSwg.details.mostRecentFc : undefined;
    state.autoSwg.lastAppliedFcAt = appliedFc ? appliedFc.ts : undefined;
    state.autoSwg.lastAppliedSettingsKey = state.autoSwg.details ? state.autoSwg.details.settingsKey : undefined;
    // A button you pressed (Check Now, Refresh, Refresh and Apply) is your own action, so it never raises the red banner, whatever the size of the change;
    // the banner is for what nobody asked for at that moment: the periodic automatic check.
    const awayToggle = autoSwgAwayToggle && Date.now() - autoSwgAwayToggle.at < 5 * 60 * 1000 ? autoSwgAwayToggle : undefined;
    let userStarted = trigger === 'check-now' || trigger === 'refine' || trigger === 'refresh-and-apply' || (trigger === 'automatic-check' && !!awayToggle);
    if (awayToggle) {
        state.autoSwg.awayChangeNote = `Away protection ${awayToggle.on ? 'was turned on' : 'ended'}: the SWG % ${typeof previousAppliedPct === 'number' && previousAppliedPct !== pct ? `changed from ${previousAppliedPct}% to ${pct}%` : `stays at ${pct}%`}${awayToggle.on ? ' (it is never below the maintenance % while Away protection is on)' : ''}.`;
        autoSwgAwayToggle = undefined;
    }
    else {
        state.autoSwg.awayChangeNote = undefined;
        // Any apply after the one that followed turning Away protection off settles it: the notes about its end have done their job.
        if (!sys.autoSwg.awayActive && sys.autoSwg.awayEndedNote) sys.autoSwg.clearAwayEnded();
    }
    if (isAutoApply && userStarted) state.autoSwg.lastAutoApplyLargeChange = false;
    else if (isAutoApply) {
        let threshold = sys.autoSwg.autoApplyWarnThresholdPct;
        let movedBy = typeof previousAppliedPct === 'number' ? Math.abs(pct - previousAppliedPct) : undefined;
        state.autoSwg.lastAutoApplyLargeChange = typeof movedBy === 'number' && typeof threshold === 'number' && movedBy >= threshold;
        state.autoSwg.lastAutoApplyPreviousPct = previousAppliedPct;
        state.autoSwg.lastAutoApplyThresholdPct = threshold;
        if (state.autoSwg.lastAutoApplyLargeChange) logger.warn(`AutoSwg: automatically applied a ${movedBy.toFixed(1)}-point change (to ${pct}%), at or above the ${threshold}-point warning threshold.`);
    }
    else state.autoSwg.lastAutoApplyLargeChange = false; // a human reviewed this one
    // If the applied % differs from maintenance (catching up from below, or backing
    // off toward it from above), schedule a step to maintenance once the target
    // period elapses -- runAutoSwgStep() figures out the direction when it runs.
    // The step should fire at exactly the target date this apply is aiming for -- reuse
    // lastAppliedTargetDate (just set above, either preserved from a refine or freshly
    // computed from live config) rather than independently recomputing "the target window
    // from right now" here, which would silently restart the countdown using whatever
    // days happen to be configured NOW -- e.g. if they were edited in Settings after
    // the original apply/refine chain started.
    let maintenancePct = state.autoSwg.maintenancePct;
    let stepAtMs = state.autoSwg.lastAppliedTargetDate ? new Date(state.autoSwg.lastAppliedTargetDate).getTime() : NaN;
    if (sys.autoSwg.autoStepEnabled && typeof maintenancePct === 'number' && pct !== maintenancePct && !isNaN(stepAtMs) && stepAtMs > Date.now()) {
        state.autoSwg.stepAt = autoSwgStepTime(new Date(stepAtMs)).toISOString();
        state.autoSwg.stepPct = maintenancePct;
        armAutoSwgStep();
    }
    else clearAutoSwgStep();
    // Log the inputs and outputs behind this change. The setpoint is already
    // on the chlorinator, so a logging failure must not fail the request.
    try {
        let details = state.autoSwg.details || {};
        let capacity: number = details.swgCapacityPpmPerDay;
        // Note when the run window differs from the previous apply's (a schedule edit, or changed sunrise/sunset offsets), to the
        // nearest 10 minutes, so schedule experiments can be lined up with the readings.
        let runWindowChange: { from: string; to: string } | undefined;
        try {
            const cur: any = details.inputs || {};
            const prevRec: any = readAutoSwgHistory().filter(r => r.source === 'auto' && r.inputs && r.inputs.swgStartTime && r.inputs.swgStopTime).pop();
            if (prevRec && cur.swgStartTime && cur.swgStopTime
                && (windowKeyTime(prevRec.inputs.swgStartTime) !== windowKeyTime(cur.swgStartTime) || windowKeyTime(prevRec.inputs.swgStopTime) !== windowKeyTime(cur.swgStopTime)))
                runWindowChange = { from: `${prevRec.inputs.swgStartTime}-${prevRec.inputs.swgStopTime}`, to: `${cur.swgStartTime}-${cur.swgStopTime}` };
        } catch (err) { /* only a note; never let it affect the apply */ }
        let stateSnapshot = Object.assign({}, state.autoSwg.get(true));
        delete stateSnapshot.details;
        let calcOutputs = Object.assign({}, details);
        delete calcOutputs.inputs; // recorded separately as `inputs`
        let outputs = Object.assign(stateSnapshot, calcOutputs);
        appendAutoSwgHistory({
            source: 'auto',
            trigger: trigger || (isAutoApply ? undefined : 'reviewed'),
            algorithm: AUTO_SWG_ALGORITHM_VERSION,
            targetOutcome: details.targetRefreshed ? 'kept' : (details.targetDateExtended ? 'new-extended' : 'new'),
            targetStrayPpm: details.targetStrayPpm,
            targetThresholdPpm: details.targetThresholdPpm,
            runWindowChange: runWindowChange,
            targetFc: state.autoSwg.lastAppliedTargetFc,
            targetDate: state.autoSwg.lastAppliedTargetDate ? new Date(state.autoSwg.lastAppliedTargetDate).toISOString() : undefined,
            previousTargetDate: previousTargetDate ? new Date(previousTargetDate).toISOString() : undefined,
            appliedAt: state.autoSwg.lastAppliedAt,
            appliedPct: pct,
            recommendedPct: state.autoSwg.recommendedPct,
            previousPct: typeof previousAppliedPct === 'number' ? previousAppliedPct : state.autoSwg.currentPct,
            ppmPerDay: typeof capacity === 'number' ? Math.round(capacity * pct) / 100 : undefined,
            hrs: details.swgRunHours,
            inputs: withoutPrivateInputs(details.inputs),
            outputs: outputs,
        });
    }
    catch (err) { logger.error(`AutoSwg: applied ${pct}% but could not write the history log: ${err.message}`); }
    state.autoSwg.pending = false;
    state.autoSwg.emitEquipmentChange();
    return schlor;
}

const AUTO_SWG_AUTO_CHECK_MIN_DELAY_MS = 5 * 60 * 1000; // never fire sooner than 5 min after being (re)armed
let autoSwgAutoCheckTimer: NodeJS.Timeout | undefined;

function clearAutoSwgAutoCheck() {
    if (autoSwgAutoCheckTimer) clearTimeout(autoSwgAutoCheckTimer);
    autoSwgAutoCheckTimer = undefined;
}

// Arms (or re-arms) the periodic PoolMath check + apply cycle. Only actually schedules
// anything while BOTH autoCheckEnabled and autoApplyEnabled are on -- autoCheckEnabled by
// itself would just overwrite whatever unapplied preview the user is looking at on the
// calculation screen with nobody there to act on it, and autoApplyEnabled by itself (no
// periodic timer) is a valid, supported standalone mode handled separately -- see
// applyIfAutoApplyEnabled(), called after every manual Check Now/Refresh & Adjust too.
// Called at startup and again whenever AutoSwg config is saved, so toggling either flag on
// takes effect immediately rather than needing a restart.
export function armAutoSwgAutoCheck(minDelayMs: number = 0, firstRunMs?: number) {
    clearAutoSwgAutoCheck();
    let cfg = sys.autoSwg;
    let wasDue = state.autoSwg.nextAutoCheckAt;
    state.autoSwg.nextAutoCheckAt = undefined;
    state.autoSwg.awayStatus = cfg.awayStatus;
    state.autoSwg.awayStartedAt = cfg.awayActive ? cfg.awayStartedAt : undefined;
    state.autoSwg.awayTargetFc = cfg.awayTargetFc;
    // The periodic check runs for the automatic mode's Auto-Apply and automatic check, or while Away protection is on.
    if (!cfg.enabled || !((cfg.autoCheckEnabled && cfg.autoApplyEnabled) || cfg.awayActive) || !cfg.shareCode || cfg.chlorinatorId < 0) {
        if (wasDue) state.autoSwg.emitEquipmentChange();
        return;
    }
    let hours = typeof cfg.autoCheckHours === 'number' && cfg.autoCheckHours > 0 ? cfg.autoCheckHours : 12;
    let floorMs = Math.max(minDelayMs, AUTO_SWG_AUTO_CHECK_MIN_DELAY_MS);
    let delay = Math.max(hours * 3600000, floorMs);
    // Pinned to the clock when a start time is set (and the interval is under a day):
    // every `hours` from that time of day, so restarts and settings saves don't shift it.
    if (cfg.autoCheckStartTime && hours < 24) {
        try { delay = nextScheduledCheck(new Date(), cfg.autoCheckStartTime, hours, cfg.timezone, floorMs).getTime() - Date.now(); }
        catch (err) { logger.warn(`AutoSwg: ignoring unusable automatic check start time '${cfg.autoCheckStartTime}' (${err.message}); counting ${hours}h from now instead.`); }
    }
    // Turning Away protection on starts its first check soon, so the target you just set takes effect (within its limits) rather than a day later.
    if (typeof firstRunMs === 'number') delay = firstRunMs;
    state.autoSwg.nextAutoCheckAt = new Date(Date.now() + delay).toISOString();
    logger.info(`AutoSwg: next automatic check at ${formatLocalDateTime(new Date(state.autoSwg.nextAutoCheckAt), cfg.timezone)} ${cfg.timezone}.`);
    state.autoSwg.emitEquipmentChange();
    autoSwgAutoCheckTimer = setTimeout(() => { runAutoSwgAutoCheck().catch(err => logger.error(`AutoSwg: automatic check failed: ${err.message}`)); }, delay);
}

// After a manual Check Now/Refresh & Adjust produces a fresh pending recommendation, apply
// it immediately with no further confirmation if AutoSwg.autoApplyEnabled is on -- this is
// what lets auto-apply be used standalone (manual-trigger only), independent of whether the
// periodic autoCheckEnabled timer is running at all.
async function applyIfAutoApplyEnabled(skipped?: string, trigger?: AutoSwgApplyTrigger): Promise<void> {
    if (!skipped && sys.autoSwg.autoApplyEnabled) await applyAutoSwgRecommendation(true, undefined, trigger);
    // A PoolMath read is also when auto tune looks at whether enough new FC readings have arrived (not waited for).
    runAutoSwgAutoTune().catch(err => logger.error(`AutoSwg: auto tune failed: ${err.message}`));
}

// The calculation state plus, when a Refresh was skipped for want of a new FC reading,
// that message (response-only -- nothing about a skip is persisted).
function autoSwgResponse(skipped?: string) {
    let data = state.autoSwg.get(true);
    return skipped ? Object.assign({}, data, { skipped: skipped }) : data;
}

// Called with what each read of the PoolMath share page found: that page is the freshest data,
// so it overwrites the archived readings for the period it covers (PoolMath entries can be edited
// or deleted). A no-op until the archive has been pulled for this share code.
function refreshAutoSwgArchiveFromPage(page: PageReadings) {
    let cfg = sys.autoSwg;
    let r = refreshPoolMathArchiveFromPage(cfg.shareCode, cfg.poolName || undefined, page);
    if (r && (r.updated || r.added || r.removed)) {
        logger.info(`AutoSwg: PoolMath history archive refreshed from the share page: ${r.updated} updated, ${r.added} added, ${r.removed} removed.`);
        let sum = poolMathArchiveSummary();
        state.autoSwg.archiveCount = sum.count;
        state.autoSwg.archiveOldest = sum.oldest;
        state.autoSwg.emitEquipmentChange();
    }
}

// The PoolMath archive as the reports use it, alongside what the share page lists (empty until the archive has
// been pulled for this share code, in which case the reports see the page alone).
function autoSwgArchiveForReports() {
    return { fc: archivedFcReadings(), swg: archivedSwgEvents(), cya: archivedCyaReadings(), chlorine: archivedChlorineAdditions(), temp: archivedWaterTemps() };
}

// The inputs the reports (projection accuracy, what-if sweep, tune) give the calculation: the same ones a normal
// calculation uses (see runAutoSwgRecommendation), from the saved settings.
function autoSwgReportParams(cfg: typeof sys.autoSwg): AutoSwgParams {
    let { swgStartTime, swgStopTime } = resolveAutoSwgRunWindow(cfg);
    let sunTimes = autoSwgSunTimes(cfg.timezone);
    return {
        shareCode: cfg.shareCode,
        poolName: cfg.poolName || undefined,
        gallons: cfg.gallons,
        swgLbsPerDay: cfg.swgLbsPerDay,
        swgStartTime: swgStartTime,
        swgStopTime: swgStopTime,
        timezone: cfg.timezone,
        windowDays: cfg.windowDays,
        targetFc: cfg.effectiveTargetFc,
        targetPeriodsAbove: cfg.targetPeriodsAbove,
        targetPeriodsBelow: cfg.targetPeriodsBelow,
        away: autoSwgAwayParams(cfg),
        sunriseTime: sunTimes.sunrise,
        sunsetTime: sunTimes.sunset,
        daytimeSharePct: cfg.daytimeLossSharePct,
        nightBurnRatio: cfg.nightBurnRatio,
        creditChlorineAdditions: cfg.creditChlorineAdditions,
        fcAnomalyTolerancePpm: cfg.fcAnomalyTolerancePpm,
        projectionWeight: cfg.projectionWeight,
        projectionTaperStartDays: cfg.projectionTaperStartDays,
        projectionTaperEndDays: cfg.projectionTaperEndDays,
        overshootPpmPerDay: cfg.overshootPpmPerDay,
        troughFloor: cfg.protectOvernightLow,
        burnTempAdjust: cfg.burnTempAdjust,
    };
}

// Whether another Tune is worth it yet (see the /state/autoSwg/tune/status route), from what is stored locally.
function autoSwgTuneStatus(cfg: typeof sys.autoSwg) {
    let ms = (v: string) => v ? new Date(v).getTime() : NaN;
    let ref = Math.max(isNaN(ms(cfg.lastTuneAt)) ? -Infinity : ms(cfg.lastTuneAt), isNaN(ms(cfg.lastTuneAppliedAt)) ? -Infinity : ms(cfg.lastTuneAppliedAt));
    let manual = isFinite(ref) && !isNaN(ms(cfg.tuningChangedAt)) && ms(cfg.tuningChangedAt) > ref + 60000;
    let since: number | undefined;
    if (isFinite(ref) && cfg.shareCode && isPoolMathArchiveCurrent(cfg.shareCode, cfg.poolName || undefined)) since = archivedFcReadings().filter(r => r.ts.getTime() > ref).length;
    return { lastTuneAt: cfg.lastTuneAt, lastTuneAppliedAt: cfg.lastTuneAppliedAt, tuningChangedAt: cfg.tuningChangedAt, manualChangeSinceTune: manual, readingsSinceTune: since, needed: cfg.autoTuneAfterFcReadings > 0 ? cfg.autoTuneAfterFcReadings : 10 };
}

// Writes one Tune run to the Tune history and stamps when it ran. `by` is who ran it: the Tune button, or auto tune.
function recordAutoSwgTuneRun(cfg: typeof sys.autoSwg, tune: TuneResult, status: ReturnType<typeof autoSwgTuneStatus>, by: 'manual' | 'auto') {
    cfg.lastTuneAt = new Date().toISOString();
    try {
        appendTuneHistory({
            ts: cfg.lastTuneAt,
            by: by,
            settings: { windowDays: cfg.windowDays, daytimeLossSharePct: cfg.daytimeLossSharePct, nightBurnRatio: cfg.nightBurnRatio, creditChlorineAdditions: cfg.creditChlorineAdditions, fcAnomalyTolerancePpm: cfg.fcAnomalyTolerancePpm, projectionWeight: cfg.projectionWeight, projectionTaperStartDays: cfg.projectionTaperStartDays, projectionTaperEndDays: cfg.projectionTaperEndDays, burnTempAdjust: cfg.burnTempAdjust },
            readings: tune.readings, history: tune.history, meanAbsError: tune.meanAbsError, unchangedMae: tune.unchangedMae, skill: tune.skill,
            status: tune.status,
            recommendation: tune.recommendation ? { kind: tune.recommendation.kind, label: tune.recommendation.label, settings: tune.recommendation.settings, expectedMae: tune.recommendation.expectedMae, change: tune.recommendation.change, low: tune.recommendation.low, high: tune.recommendation.high } : undefined,
            manualChangeSinceLastTune: status.manualChangeSinceTune, readingsSinceLastTune: status.readingsSinceTune,
        });
    }
    catch (err) { logger.warn(`AutoSwg: could not record the Tune run: ${err.message}`); }
}

// Auto tune (the automatic mode): after a PoolMath read (an automatic check, or a Check Now), if enough new FC readings have arrived since the
// last Tune, run Tune. What it recommends is applied only when Auto tune apply is on and every guard passes (see AutoSwgAutoTune.ts);
// otherwise the recommendation is kept in the Tune history, with the reasons it was held, and a note is shown on the AutoSwg page.
let autoSwgAutoTuneRunning = false;
async function runAutoSwgAutoTune(): Promise<void> {
    let cfg = sys.autoSwg;
    if (autoSwgAutoTuneRunning || !cfg.enabled || !cfg.autoTuneEnabled || !cfg.shareCode) return;
    let status = autoSwgTuneStatus(cfg);
    if (typeof status.readingsSinceTune !== 'number' || status.readingsSinceTune < status.needed) return;
    autoSwgAutoTuneRunning = true;
    let note = '';
    try {
        let tune = await buildTune(autoSwgReportParams(cfg), { lookbackDays: 365, localSwgEntries: toLocalSwgEntries(readAutoSwgHistory()), historyRecords: readAutoSwgHistory(), tuningChangedAt: cfg.tuningChangedAt, archive: autoSwgArchiveForReports() });
        recordAutoSwgTuneRun(cfg, tune, status, 'auto');
        let at = cfg.lastTuneAt;
        let rec = tune.recommendation;
        if (tune.status === 'insufficient') note = `Auto tune: too few FC readings could be scored yet (${tune.readings}).`;
        else if (tune.status !== 'recommend' || !rec) note = `Auto tune: your settings look good (${tune.readings} readings scored).`;
        else {
            let what = `${rec.label} (expected change ${rec.change.toFixed(2)} ppm in mean error, range ${rec.low.toFixed(2)} to ${rec.high.toFixed(2)})`;
            if (!cfg.autoTuneApplyEnabled) note = `Auto tune recommends: ${what}. Not applied: Auto tune apply is off.`;
            else {
                let fcs = archivedFcReadings();
                let guard = evaluateAutoTuneApply(cfg, tune, { manualChangeSinceTune: status.manualChangeSinceTune, readiness: getAutoSwgReadiness(cfg, true), newestFcAt: fcs.length ? fcs[fcs.length - 1].ts : undefined });
                if (!guard.ok) {
                    note = `Auto tune recommends: ${what}. Not applied: ${guard.reasons.join('; ')}.`;
                    try { markLastTuneHeld(guard.reasons); } catch (err) { logger.warn(`AutoSwg: could not note why the Tune recommendation was held: ${err.message}`); }
                }
                else {
                    let before = snapshotAutoSwgSettings(cfg);
                    let previous: { [setting: string]: number | boolean } = {};
                    for (const k of Object.keys(rec.settings)) previous[k] = (cfg as any)[k];
                    cfg.set(rec.settings);
                    // Stamped together so the change does not read as one made by hand since the Tune.
                    cfg.tuningChangedAt = cfg.lastTuneAppliedAt = cfg.lastTuneAt = at;
                    try { logAutoSwgSettingChanges(before, snapshotAutoSwgSettings(cfg), 'auto-tune'); } catch (err) { logger.warn(`AutoSwg: could not log the auto tune change: ${err.message}`); }
                    try { markLastTuneApplied(at, 'auto', previous); } catch (err) { logger.warn(`AutoSwg: could not mark the Tune as applied: ${err.message}`); }
                    note = `Auto tune applied: ${what}. The settings it replaced: ${Object.keys(previous).map(k => `${k} = ${previous[k]}`).join(', ')}.`;
                }
            }
        }
        state.autoSwg.autoTuneAt = at;
    }
    catch (err) { note = `Auto tune could not run: ${err.message}`; logger.error(`AutoSwg: ${note}`); }
    finally { autoSwgAutoTuneRunning = false; }
    state.autoSwg.autoTuneNote = note;
    logger.info(`AutoSwg: ${note}`);
    state.autoSwg.emitEquipmentChange();
}

// The salt you logged adding in PoolMath (from the archive, see topUpPoolMathArchive), in ppm of this pool.
function autoSwgSaltAdditions(): SaltAddition[] {
    try {
        let gallons = sys.autoSwg.gallons;
        return archivedSaltAdditions().map(a => ({ ts: a.ts.getTime(), ppm: saltAdditionPpm(a.pounds, gallons) }));
    }
    catch (err) { return []; }
}

// Once an hour, record the chlorinator's own salt reading (AutoSwgSaltHistory keeps it): a fall in salt is the best sign the pool was diluted by
// rain or a water change. It is local data only and changes no calculation; the timer is checked every ten minutes and the history keeps at most
// one sample an hour. Nothing is recorded when the chlorinator is not configured for AutoSwg, ignores its salt reading, or reports none.
// A summary of an Away protection period for the history, written when it ends (by itself or unchecked): how many checks ran and the lowest and
// highest % applied, the last check's projection with and without the storm and outage correction (to score against the FC test that ended it), the
// outages and the alerts seen at the checks, and the reading that ended it. The records of the checks themselves are in the history too.
export function awaySummary(startedAt: string, reading?: { value: number; ts: string }) {
    let from = new Date(startedAt).getTime();
    if (isNaN(from)) return undefined;
    let recs = readAutoSwgHistory().filter(r => r.source === 'auto' && new Date(r.appliedAt).getTime() >= from);
    let pcts = recs.map(r => r.appliedPct).filter(p => typeof p === 'number');
    let alertIds: string[] = [];
    for (const r of recs) for (const a of ((r.outputs && r.outputs.alerts) || [])) if (a && a.id && alertIds.indexOf(a.id) < 0) alertIds.push(a.id);
    let last = recs.length ? recs[recs.length - 1] : undefined;
    let o: any = last && last.outputs ? last.outputs : {};
    return {
        startedAt: startedAt,
        endedAt: new Date().toISOString(),
        endingReading: reading,
        checks: recs.length,
        minPct: pcts.length ? Math.min(...pcts) : undefined,
        maxPct: pcts.length ? Math.max(...pcts) : undefined,
        stormChecks: recs.filter(r => r.outputs && r.outputs.stormApplied).length,
        lastCheck: last ? { at: last.appliedAt, appliedPct: last.appliedPct, recommendedPct: last.recommendedPct, maintenancePct: o.maintenancePct, projectedFc: o.projectedCurrentFc, projectedFcBeforeStorm: o.projectedFcBeforeStorm, stormLossPpm: o.stormLossPpm, projectedFcRange: o.projectedFcRange } : undefined,
        outages: (state.autoSwg.outages || []).filter(x => x && new Date(x.to).getTime() >= from).map(x => ({ from: x.from, to: x.to, minutes: x.minutes, rebooted: x.rebooted })),
        alertsSeen: alertIds,
        swgOutput: outputLog.summary(from, Date.now()),
    };
}

// Away protection ends by itself when an FC reading logged in PoolMath after it was turned on shows up (see runAutoSwgRecommendation). Called after
// every read of PoolMath: each check and the daily top-up.
// Returns true when it ended Away protection and the target in force changed with it (so a calculation made against the vacation target is out of date).
function endAwayOnNewReading(reading?: { value: number; ts: string }): boolean {
    let cfg = sys.autoSwg;
    if (!cfg.awayEnabled || !cfg.awayStartedAt || !reading) return false;
    let readingAt = new Date(reading.ts).getTime(), startedAt = new Date(cfg.awayStartedAt).getTime();
    if (isNaN(readingAt) || isNaN(startedAt) || readingAt <= startedAt) return false;
    let targetRestored = false;
    let before = snapshotAutoSwgSettings(cfg);
    let summary = awaySummary(cfg.awayStartedAt, reading);
    cfg.awayEnabled = false;
    // The plan goes back to the normal Target FC; a calculation made against the vacation target is out of date when the two differ.
    let targetNote = '';
    if (cfg.awayTargetFc !== cfg.targetFc) {
        targetNote = ` The target in force went back from the vacation target of ${cfg.awayTargetFc} to the Target FC of ${cfg.targetFc} ppm.`;
        targetRestored = true;
    }
    noteAutoSwgAwayToggled(false);   // the apply that follows is the one this explains
    cfg.noteAwayEnded(`Away protection ended by itself: a new FC reading (${reading.value} ppm, ${formatLocalDateTime(new Date(reading.ts), cfg.timezone)}) was logged in PoolMath after it was turned on. Your other settings apply again.${targetNote}`);
    try { logAutoSwgSettingChanges(before, snapshotAutoSwgSettings(cfg), 'away-ended', summary); } catch (err) { logger.warn(`AutoSwg: could not log the end of Away protection: ${err.message}`); }
    logger.info(`AutoSwg: ${cfg.awayEndedNote}`);
    state.autoSwg.awayStatus = cfg.awayStatus;
    state.autoSwg.awayStartedAt = undefined;
    armAutoSwgAutoCheck();
    state.autoSwg.emitEquipmentChange();
    return targetRestored;
}

// The ways the SWG can fail to hold FC that no recommendation can fix (a bad chlorinator status or no output in the run window, an automatic check that
// stopped, a step that did not happen) become alerts in the AutoSwg area of the dashboard, checked with each salt sample. See AutoSwgWatch.ts.
const autoSwgWatch = new AutoSwgWatch();
// How long none of the air, water or solar temperatures has changed. Only sensors that report to a fraction of a degree are watched: a controller that
// reports whole degrees can legitimately sit on one value for hours.
let autoSwgTempSig = '';
let autoSwgTempChangedAt = 0;
function autoSwgTempsUnchangedMs(now: number): number | undefined {
    let t = state.temps;
    let vals = [t.air, t.solar, t.waterSensor1, t.waterSensor2, t.waterSensor3, t.waterSensor4].filter(v => typeof v === 'number' && !isNaN(v));
    if (!vals.some(v => Math.abs(v - Math.round(v)) > 1e-6)) { autoSwgTempSig = ''; return undefined; }
    let sig = vals.join('|');
    if (sig !== autoSwgTempSig || !autoSwgTempChangedAt) { autoSwgTempSig = sig; autoSwgTempChangedAt = now; return 0; }
    return now - autoSwgTempChangedAt;
}
// A gap of this long since njsPC last knew it was running (found at start-up) is an outage: the pool equipment it keeps on was off for the time.
const AUTO_SWG_OUTAGE_MIN_MS = 25 * 60 * 1000;
function detectAutoSwgOutage() {
    try {
        let now = Date.now();
        let beat = state.autoSwg.heartbeatAt ? new Date(state.autoSwg.heartbeatAt).getTime() : NaN;
        if (!isNaN(beat) && now - beat >= AUTO_SWG_OUTAGE_MIN_MS && now - beat < 400 * 86400000) {
            // If the computer itself started after njsPC was last seen, it restarted (a power loss or a reboot) and not just njsPC.
            let rebooted = os.uptime() * 1000 < (now - beat) + 5 * 60 * 1000;
            let outage = { from: new Date(beat).toISOString(), to: new Date(now).toISOString(), minutes: Math.round((now - beat) / 60000), rebooted: rebooted };
            state.autoSwg.outages = (state.autoSwg.outages || []).concat([outage]).slice(-10);
            logger.warn(`AutoSwg: njsPC was not running from ${outage.from} to ${outage.to} (${outage.minutes} minutes), so the pool equipment it controls was off${rebooted ? '; the computer restarted (a power loss or a reboot)' : ''}.`);
            state.autoSwg.emitEquipmentChange();
        }
        state.autoSwg.heartbeatAt = new Date(now).toISOString();
    }
    catch (err) { logger.warn(`AutoSwg: could not check for an outage: ${err.message}`); }
}
// Whether the chlorinator should have power right now. When AutoSwg follows a schedule, that schedule's circuit is the SWG's power relay, so its
// state is the answer (the SWG is only powered inside its run window, and is silent the rest of the day by design). With no schedule to follow,
// fall back to the body running, as njsPC's own poll assumes.
function autoSwgChlorinatorPowered(cfg: typeof sys.autoSwg, body: number): boolean {
    try {
        if (cfg.scheduleId >= 0) {
            const sched = sys.schedules.toArray().find(s => s.id === cfg.scheduleId);
            if (sched && !sched.disabled) {
                const c: any = state.circuits.getInterfaceById(sched.circuit);
                if (c) return c.isOn === true;
            }
        }
        return sys.board.bodies.isBodyOn(body);
    }
    catch (err) { return false; }
}
function watchAutoSwg() {
    try {
        let cfg = sys.autoSwg;
        if (state.autoSwg.awayTargetFc !== cfg.awayTargetFc) state.autoSwg.awayTargetFc = cfg.awayTargetFc;
        if (state.autoSwg.awayStatus !== cfg.awayStatus) { state.autoSwg.awayStatus = cfg.awayStatus; state.autoSwg.awayStartedAt = cfg.awayActive ? cfg.awayStartedAt : undefined; state.autoSwg.emitEquipmentChange(); }
        let put = (alerts: any[]) => {
            if (JSON.stringify(alerts) !== JSON.stringify(state.autoSwg.alerts || [])) {
                let was: any[] = state.autoSwg.alerts || [];
                for (const a of alerts) if (!was.some(w => w && w.id === a.id)) logger.info(`AutoSwg alert raised (${a.level}): ${a.text}`);
                for (const w of was) if (w && !alerts.some(a => a.id === w.id)) logger.info(`AutoSwg alert cleared: ${w.id}`);
                state.autoSwg.alerts = alerts; state.autoSwg.emitEquipmentChange();
            }
        };
        if (!cfg.enabled || cfg.chlorinatorId < 0) { put([]); return; }
        let chlorRecord = sys.chlorinators.toArray().find(c => c.id === cfg.chlorinatorId);
        let schlor = chlorRecord ? state.chlorinators.getItemById(chlorRecord.id, false) : undefined;
        let now = Date.now();
        let win = resolveAutoSwgRunWindow(cfg);
        let statusDesc = '';
        if (schlor) { try { let v: any = sys.board.valueMaps.chlorinatorStatus.transform(schlor.status); statusDesc = v && (v.desc || v.name) ? (v.desc || v.name) : String(schlor.status); } catch (err) { statusDesc = String(schlor.status); } }
        put(autoSwgWatch.evaluate({
            now: now,
            inRunWindow: inRunWindow(win.swgStartTime, win.swgStopTime, cfg.timezone, now),
            chlorinator: schlor ? { status: schlor.status, statusDesc: statusDesc, currentOutput: schlor.currentOutput, setpoint: schlor.poolSetpoint,
                powered: chlorRecord && !chlorRecord.disabled && autoSwgChlorinatorPowered(cfg, chlorRecord.body),
                commAgeSec: typeof schlor.lastComm === 'number' && schlor.lastComm > 0 ? Math.max(0, Math.round((now - schlor.lastComm) / 1000)) : undefined } : undefined,
            autoCheckEnabled: (cfg.autoCheckEnabled && cfg.autoApplyEnabled) || cfg.awayActive,
            autoCheckHours: cfg.autoCheckHours,
            lastCheckedAt: state.autoSwg.lastCheckedAt,
            checkError: state.autoSwg.error,
            stepAt: state.autoSwg.stepAt,
            tempsUnchangedMs: autoSwgTempsUnchangedMs(now),
            runWindow: { start: win.swgStartTime, stop: win.swgStopTime, scheduleNote: win.scheduleNote },
            outages: state.autoSwg.outages || [],
        }));
    }
    catch (err) { logger.warn(`AutoSwg: could not update the dashboard alerts: ${err.message}`); }
}

let autoSwgSaltTimer: NodeJS.Timeout | undefined;
// What the chlorinator actually did, logged at all times (every mode, inside the run window or not) as one line an hour; see AutoSwgOutputLog.ts.
// It uses the AutoSwg chlorinator when one is chosen, otherwise the first chlorinator there is.
function sampleAutoSwgOutput() {
    try {
        let chlorinators = sys.chlorinators.toArray();
        let rec = chlorinators.find(c => c.id === sys.autoSwg.chlorinatorId) || chlorinators[0];
        if (!rec) return;
        let s = state.chlorinators.getItemById(rec.id, false);
        if (!s) return;
        let now = Date.now();
        outputLog.record({
            output: s.currentOutput, set: s.poolSetpoint, target: s.targetOutput, status: s.status, salt: s.saltLevel,
            commAgeSec: typeof s.lastComm === 'number' && s.lastComm > 0 ? Math.max(0, Math.round((now - s.lastComm) / 1000)) : undefined
        }, now);
    }
    catch (err) { logger.warn(`AutoSwg: could not log the chlorinator output: ${err.message}`); }
}
function sampleAutoSwgSalt() {
    try { state.autoSwg.heartbeatAt = new Date().toISOString(); } catch (err) { /* the heartbeat is best effort */ }
    sampleAutoSwgOutput();
    watchAutoSwg();
    try {
        let cfg = sys.autoSwg;
        if (!cfg.enabled || cfg.chlorinatorId < 0) return;
        let chlorRecord = sys.chlorinators.toArray().find(c => c.id === cfg.chlorinatorId);
        if (!chlorRecord || chlorRecord.ignoreSaltReading) return;
        let schlor = state.chlorinators.getItemById(chlorRecord.id, false);
        if (schlor) saltHistory.record(schlor.saltLevel);
    }
    catch (err) { logger.warn(`AutoSwg: could not record the salt reading: ${err.message}`); }
}
// A top-up of the archive about once a day: salt additions and the extra numbers on new tests (salt, water temperature, pH ...) that the page
// refresh does not copy. One small request; a failure is retried in a few hours. See topUpPoolMathArchive.
const AUTO_SWG_TOPUP_FIRST_DELAY_MS = 15 * 60 * 1000;
const AUTO_SWG_TOPUP_MS = 24 * 3600 * 1000;
const AUTO_SWG_TOPUP_RETRY_MS = 6 * 3600 * 1000;
const AUTO_SWG_TOPUP_NOT_READY_MS = 30 * 60 * 1000;
let autoSwgTopUpTimer: NodeJS.Timeout | undefined;
export function armAutoSwgArchiveTopUp(delayMs: number = AUTO_SWG_TOPUP_FIRST_DELAY_MS) {
    if (typeof autoSwgTopUpTimer !== 'undefined') clearTimeout(autoSwgTopUpTimer);
    autoSwgTopUpTimer = setTimeout(() => { runAutoSwgArchiveTopUp().catch(err => logger.error(`AutoSwg: archive top-up failed: ${err.message}`)); }, delayMs);
    autoSwgTopUpTimer.unref();
}
async function runAutoSwgArchiveTopUp(): Promise<void> {
    autoSwgTopUpTimer = undefined;
    let next = AUTO_SWG_TOPUP_MS;
    try {
        let cfg = sys.autoSwg;
        if (cfg.enabled && cfg.shareCode) {
            if (autoSwgArchiveRunning) next = AUTO_SWG_TOPUP_NOT_READY_MS;
            else {
                let r = await topUpPoolMathArchive(cfg.shareCode, cfg.poolName || undefined);
                // Whatever the mode, PoolMath is read at least once a day here; a new test ends Away protection.
                if (typeof r !== 'undefined') {
                    let newest: { value: number; ts: Date } | undefined;
                    for (const f of archivedFcReadings()) if (!newest || f.ts.getTime() > newest.ts.getTime()) newest = f;
                    if (newest) endAwayOnNewReading({ value: newest.value, ts: newest.ts.toISOString() });
                }
                if (typeof r === 'undefined') next = AUTO_SWG_TOPUP_NOT_READY_MS;   // the full pull has not happened yet
                else if (r.saltAdded || r.testsEnriched || r.testsAdded || r.removed) logger.info(`AutoSwg: PoolMath archive top-up: ${r.saltAdded} salt addition${r.saltAdded === 1 ? '' : 's'}, ${r.testsEnriched} test${r.testsEnriched === 1 ? '' : 's'} filled in, ${r.testsAdded} test${r.testsAdded === 1 ? '' : 's'} added, ${r.removed} removed.`);
            }
        }
    }
    catch (err) { next = AUTO_SWG_TOPUP_RETRY_MS; logger.warn(`AutoSwg: PoolMath archive top-up failed (${err.message}); trying again in ${next / 3600000} hours.`); }
    finally { armAutoSwgArchiveTopUp(next); }
}

export function armAutoSwgSaltLog() {
    if (typeof autoSwgSaltTimer !== 'undefined') return;
    detectAutoSwgOutage();
    const first = setTimeout(sampleAutoSwgSalt, 2 * 60 * 1000);
    first.unref();
    autoSwgSaltTimer = setInterval(sampleAutoSwgSalt, 10 * 60 * 1000);
    autoSwgSaltTimer.unref();
}

// Background PoolMath history sync: pulls up to 18 months of logs from the share link's JSON
// interface into a local archive (see AutoSwgPoolMathArchive). It is a one-time pull per share
// code and pool -- it runs only when the archive isn't already for the configured ones (the first
// time, or after either changes), not on a schedule; a failure (including PoolMath rate
// limiting) is retried until it succeeds.
const AUTO_SWG_ARCHIVE_FIRST_DELAY_MS = 3 * 60 * 1000;
const AUTO_SWG_ARCHIVE_RETRY_MS = 30 * 60 * 1000;
let autoSwgArchiveTimer: NodeJS.Timeout | undefined;
let autoSwgArchiveRunning = false;

export function armAutoSwgArchiveSync(delayMs: number = AUTO_SWG_ARCHIVE_FIRST_DELAY_MS) {
    if (autoSwgArchiveTimer) clearTimeout(autoSwgArchiveTimer);
    autoSwgArchiveTimer = undefined;
    let cfg = sys.autoSwg;
    if (!cfg.enabled || !cfg.shareCode) return;
    if (isPoolMathArchiveCurrent(cfg.shareCode, cfg.poolName || undefined)) {
        // Already archived for this share code -- nothing to pull; just show what's there.
        let sum = poolMathArchiveSummary();
        if (state.autoSwg.archiveCount !== sum.count || state.autoSwg.archiveSyncedAt !== sum.syncedAt) {
            state.autoSwg.archiveSyncedAt = sum.syncedAt;
            state.autoSwg.archiveCount = sum.count;
            state.autoSwg.archiveOldest = sum.oldest;
            state.autoSwg.emitEquipmentChange();
        }
        return;
    }
    autoSwgArchiveTimer = setTimeout(() => { runAutoSwgArchiveSync().catch(err => logger.error(`AutoSwg: PoolMath history sync failed: ${err.message}`)); }, delayMs);
}

async function runAutoSwgArchiveSync(): Promise<void> {
    autoSwgArchiveTimer = undefined;
    if (autoSwgArchiveRunning) return;
    let cfg = sys.autoSwg;
    if (!cfg.enabled || !cfg.shareCode) return;
    autoSwgArchiveRunning = true;
    let retryMs: number | undefined;
    try {
        let r = await syncPoolMathArchive(cfg.shareCode, cfg.poolName || undefined);
        state.autoSwg.archiveSyncedAt = new Date().toISOString();
        state.autoSwg.archiveCount = r.total;
        state.autoSwg.archiveOldest = r.oldest;
        state.autoSwg.archiveError = undefined;
        logger.info(`AutoSwg: PoolMath history sync: ${r.fetched} entries returned (asked for ${r.requested}), ${r.added} new, ${r.total} archived back to ${r.oldest ? r.oldest.slice(0, 10) : 'n/a'}.`);
    }
    catch (err) {
        retryMs = AUTO_SWG_ARCHIVE_RETRY_MS;
        state.autoSwg.archiveError = err.message;
        logger.warn(`AutoSwg: PoolMath history sync failed (${err.message}); trying again in ${retryMs / 60000} minutes.`);
    }
    finally {
        autoSwgArchiveRunning = false;
        state.autoSwg.emitEquipmentChange();
        // After a failure, try again; after a success this is a no-op unless the share code changed
        // while the sync was running (then it pulls the new one's history).
        armAutoSwgArchiveSync(typeof retryMs !== 'undefined' ? retryMs : 60 * 1000);
    }
}

// The SWG % Away protection may apply: the recommendation (the glide to the target you set, plus what a storm or outage adds, which the calculation
// limits to stormMaxExtraPct points), but never below the maintenance %. Away protection can only add chlorine.
function awayBoundedPct(): number | undefined {
    let maintenance = state.autoSwg.maintenancePct, recommended = state.autoSwg.recommendedPct;
    if (typeof maintenance !== 'number' || isNaN(maintenance) || typeof recommended !== 'number' || isNaN(recommended)) return undefined;   // no usable check: nothing to apply
    return Math.round(Math.max(maintenance, Math.min(100, recommended)));
}

async function runAutoSwgAutoCheck() {
    autoSwgAutoCheckTimer = undefined;
    let cfg = sys.autoSwg;
    // Turned off, or the return date passed, since this cycle was armed.
    if (!cfg.enabled || !(cfg.autoApplyEnabled || cfg.awayActive)) return;
    try {
        // Same decision as the "Refresh and Apply" button: stay on course for an in-flight
        // target unless the projected FC has strayed past the new-target-date threshold (or
        // there's no in-flight target left), in which case start a new one.
        let skipped = await runAutoSwgRecommendation('auto', cfg.autoApplyEnabled ? 'Automatic check.' : 'Automatic check (Away protection).');
        if (skipped) logger.info(`AutoSwg: automatic check skipped. ${skipped}`);
        else if (cfg.autoApplyEnabled) await applyAutoSwgRecommendation(true, undefined, 'automatic-check');
        else {
            // Away protection only: the % is held within its limits.
            let bounded = awayBoundedPct();
            if (typeof bounded === 'undefined') { logger.info('AutoSwg: Away protection had no usable recommendation to apply.'); return; }
            if (bounded !== state.autoSwg.recommendedPct) logger.info(`AutoSwg: Away protection held the recommended ${state.autoSwg.recommendedPct}% to ${bounded}%, the maintenance %.`);
            await applyAutoSwgRecommendation(true, bounded, 'automatic-check');
        }
    }
    catch (err) { logger.error(`AutoSwg: automatic check/apply failed: ${err.message}`); }
    finally {
        armAutoSwgAutoCheck();
        runAutoSwgAutoTune().catch(err => logger.error(`AutoSwg: auto tune failed: ${err.message}`));
    }
}

export class StateRoute {
    public static initRoutes(app: express.Application) {
        ChlorinatorState.onPoolSetpointChanged = (chlor, previous, current) => {
            if (sys.autoSwg.chlorinatorId !== chlor.id) return;
            if (autoSwgApplyInFlight && autoSwgApplyInFlight.pct === current && Date.now() - autoSwgApplyInFlight.at < AUTO_SWG_APPLY_ECHO_MS) return;
            // Someone changed the setpoint by hand: they've taken over, so don't step it later.
            if (state.autoSwg.stepAt) logger.info(`AutoSwg: SWG % changed manually to ${current}%; cancelling the pending step.`);
            clearAutoSwgStep();
            logManualSwgChange(previous, current);
            // Any not-yet-applied calculation preview is now stale (its "current %" input no
            // longer holds, and its recommendation was passed over) -- clear it the same way
            // Cancel does, then record the override as what's actually running now so the
            // status popup/panel doesn't keep showing the superseded recommendation.
            clearAutoSwgCalculation();
            state.autoSwg.lastAppliedAt = new Date().toISOString();
            state.autoSwg.lastAppliedPct = current;
            state.autoSwg.lastAppliedRationale = [`Manually changed from ${previous}% to ${current}%.`];
            // A manual override abandons whatever glide-to-target was in flight -- there's
            // no original deadline left to refine toward.
            state.autoSwg.lastAppliedTargetDate = undefined;
            state.autoSwg.lastAppliedTargetWarning = undefined;
            state.autoSwg.lastAppliedTargetInfo = undefined;
            state.autoSwg.lastAppliedStaleFcNote = undefined;
            state.autoSwg.lastAppliedFcAnomalyNote = undefined;
            state.autoSwg.lastAppliedRatingNote = undefined;
            // A human just acted directly on the chlorinator -- nothing unreviewed left to warn about.
            state.autoSwg.lastAutoApplyLargeChange = false;
            state.autoSwg.emitEquipmentChange();
        };
        armAutoSwgStep(AUTO_SWG_STEP_MIN_DELAY_MS);
        armAutoSwgAutoCheck(AUTO_SWG_AUTO_CHECK_MIN_DELAY_MS);
        armAutoSwgArchiveSync();
        armAutoSwgSaltLog();
        armAutoSwgArchiveTopUp();
        // What the chlorinator actually did, hour by hour (see AutoSwgOutputLog.ts): GET /state/autoSwg/output?days=30
        app.get('/state/autoSwg/output', (req, res, next) => {
            try {
                let days = parseInt(req.query.days as string, 10);
                if (isNaN(days) || days < 1 || days > 548) days = 30;
                return res.status(200).send({ days: days, hours: outputLog.read(days) });
            }
            catch (err) { next(err); }
        });
        // The chlorinator's salt reading, day by day (median, lowest, highest), and any recent fall in it.
        app.get('/state/autoSwg/salt', (req, res, next) => {
            try {
                let days = parseInt(req.query.days as string, 10);
                if (isNaN(days) || days < 1 || days > 400) days = 400;
                let gallons = sys.autoSwg.gallons;
                let additions = archivedSaltAdditions().filter(a => a.ts.getTime() >= Date.now() - days * 86400000).map(a => ({ ts: a.ts.toISOString(), pounds: Math.round(a.pounds * 10) / 10, ppm: Math.round(saltAdditionPpm(a.pounds, gallons)) }));
                return res.status(200).send({ samples: saltHistory.count(), recentDrop: saltHistory.recentDrop(Date.now(), autoSwgSaltAdditions()) || null, additions: additions, daily: saltHistory.daily(days) });
            }
            catch (err) { next(err); }
        });
        app.get('/state/rs485Port/:id', async (req, res, next) => {
            try {
                let portId = parseInt(req.params.id, 10);
                if (isNaN(portId)) throw new ServiceParameterError(`RS485 port id not supplied`, '/state/rs485Port/:id', 'portId', req.params.id);
                let cfg = config.getSection(portId === 0 ? 'controller.comms' : `controller.comms${portId}`);
                if (typeof cfg === 'undefined') throw new ServiceParameterError(`RS485 port id not found`, '/state/rs485Port/:id', 'portId', req.params.id);
                let port = conn.findPortById(portId);
                let sport: any = {
                    portId: portId,
                    enabled: cfg.enabled || false,
                    netConnect: cfg.netConnect,
                    reconnects: 0,
                    inactivityRetry: cfg.inactivityRetry,
                    isOpen: false,
                    mock: cfg.mock || false
                }
                if (cfg.netConnect) sport.netConnect = { host: cfg.netHost, port: cfg.netPort }
                else if (typeof cfg.type !== 'undefined' && cfg.type === 'screenlogic'){
                    sport.screenlogic = cfg.screenlogic;
                }
                else sport.settings = extend(true, { name: cfg.rs485Port }, cfg.portSettings);
                if (typeof port !== 'undefined' && port.type !== 'screenlogic') {
                    let stats = port.stats;
                    sport.reconnects = port.reconnects;
                    sport.isOpen = port.isOpen;
                    sport.received = {
                        bytes: stats.bytesReceived,
                        success: stats.recSuccess,
                        failed: stats.recFailed,
                        collisions: stats.recCollisions,
                        rewinds: stats.recFRewinds,
                        failureRate: stats.recFailureRate
                    };
                    sport.sent = {
                        bytes: stats.bytesSent,
                        success: stats.sndSuccess,
                        aborted: stats.sndAborted,
                        retries: stats.sndRetries,
                        failureRate: stats.sndFailureRate
                    }
                }
                res.status(200).send(sport);
            }
            catch (err) { next(err); }
        });
        app.get('/state/chemController/:id', (req, res) => {
            res.status(200).send(state.chemControllers.getItemById(parseInt(req.params.id, 10)).getExtended());
        });
        app.get('/state/chemDoser/:id', (req, res) => {
            res.status(200).send(state.chemDosers.getItemById(parseInt(req.params.id, 10)).getExtended());
        });
        app.put('/state/chemController', async (req, res, next) => {
            try {
                let schem = await sys.board.chemControllers.setChemControllerStateAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemDoser', async (req, res, next) => {
            try {
                let schem = await sys.board.chemDosers.setChemDoserStateAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemController/manualDose', async (req, res, next) => {
            try {
                let schem = await sys.board.chemControllers.manualDoseAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemDoser/manualDose', async (req, res, next) => {
            try {
                let schem = await sys.board.chemDosers.manualDoseAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });

        app.put('/state/chemController/manualMix', async (req, res, next) => {
            try {
                logger.debug(`Starting manual mix`);
                let schem = await sys.board.chemControllers.manualMixAsync(req.body);
                logger.debug(`Started manual mix`);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemDoser/manualMix', async (req, res, next) => {
            try {
                let schem = await sys.board.chemDosers.manualMixAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.get('/state/chemController/:id/doseHistory', (req, res) => {
            let schem = state.chemControllers.getItemById(parseInt(req.params.id));
            let hist = { ph: [], orp: [] };
            for (let i = 0; i < schem.ph.doseHistory.length; i++)
                hist.ph.push(schem.ph.doseHistory[i]);
            for (let i = 0; i < schem.orp.doseHistory.length; i++)
                hist.orp.push(schem.orp.doseHistory[i]);
            return res.status(200).send(hist);
        });
        app.get('/state/chemDoser/:id/doseHistory', (req, res) => {
            let schem = state.chemDosers.getItemById(parseInt(req.params.id));
            return res.status(200).send(schem.doseHistory);
        });

        app.put('/state/chemController/:id/doseHistory/orp/clear', async (req, res, next) => {
            try {
                let schem = state.chemControllers.getItemById(parseInt(req.params.id));
                schem.orp.doseHistory = [];
                schem.orp.calcDoseHistory();
                return res.status(200).send(schem.orp.doseHistory);
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemDoser/:id/doseHistory/clear', async (req, res, next) => {
            try {
                let schem = state.chemDosers.getItemById(parseInt(req.params.id));
                schem.doseHistory = [];
                schem.calcDoseHistory();
                return res.status(200).send(schem.doseHistory);
            }
            catch (err) { next(err); }
        });

        app.put('/state/chemController/:id/doseHistory/ph/clear', async (req, res, next) => {
            try {
                let schem = state.chemControllers.getItemById(parseInt(req.params.id));
                schem.ph.doseHistory = [];
                schem.ph.calcDoseHistory();
                return res.status(200).send(schem.ph.doseHistory);
            }
            catch (err) { next(err); }

        });
        app.get('/state/chemController/:id/doseLog/ph', async (req, res, next) => {
            try {
                let schem = state.chemControllers.getItemById(parseInt(req.params.id));
                let filter = req.body || {};
                let dh = await DataLogger.readFromEndAsync(`chemDosage_${schem.ph.chemType}.log`, ChemicalDoseState, (lineNumber: number, entry: ChemicalDoseState, arr: ChemicalDoseState[]): boolean => {
                    if (entry.id !== schem.id) return false;
                    if (typeof filter.lines !== 'undefined' && filter.lines <= arr.length) return false;
                    if (typeof filter.date !== 'undefined' && entry.end < filter.date) return false;
                    return true;
                });
                return res.status(200).send(dh);
            }
            catch (err) { next(err); }
        });
        app.get('/state/chemDoser/:id/doseLog', async (req, res, next) => {
            try {
                let schem = state.chemDosers.getItemById(parseInt(req.params.id));
                let filter = req.body || {};
                let dh = await DataLogger.readFromEndAsync(`chemDosage_Peristalic.log`, ChemicalDoseState, (lineNumber: number, entry: ChemicalDoseState, arr: ChemicalDoseState[]): boolean => {
                    if (entry.id !== schem.id) return false;
                    if (typeof filter.lines !== 'undefined' && filter.lines <= arr.length) return false;
                    if (typeof filter.date !== 'undefined' && entry.end < filter.date) return false;
                    return true;
                });
                return res.status(200).send(dh);
            }
            catch (err) { next(err); }
        });

        app.search('/state/chemController/:id/doseLog/ph', async (req, res, next) => {
            try {
                let schem = state.chemControllers.getItemById(parseInt(req.params.id));
                let filter = req.body || {};
                let dh = DataLogger.readFromEnd(`chemDosage_${schem.ph.chemType}.log`, ChemicalDoseState, (lineNumber: number, entry: ChemicalDoseState, arr: ChemicalDoseState[]): boolean => {
                    if (entry.id !== schem.id) return;
                    if (typeof filter.lines !== 'undefined' && filter.lines <= arr.length) return false;
                    if (typeof filter.date !== 'undefined' && entry.end < filter.date) return false;
                    return true;
                });
                return res.status(200).send(dh);
            }
            catch (err) { next(err); }
        });
        app.get('/state/chemController/:id/doseLog/orp', async (req, res, next) => {
            try {
                let schem = state.chemControllers.getItemById(parseInt(req.params.id));
                let filter = req.body || {};
                let dh = await DataLogger.readFromEndAsync(`chemDosage_orp.log`, ChemicalDoseState, (lineNumber: number, entry: ChemicalDoseState, arr: ChemicalDoseState[]): boolean => {
                    if (entry.id !== schem.id) return false;
                    if (typeof filter.lines !== 'undefined' && filter.lines <= arr.length) return false;
                    if (typeof filter.date !== 'undefined' && entry.end < filter.date) return false;
                    return true;
                });
                return res.status(200).send(dh);
            }
            catch (err) { next(err); }
        });
        app.search('/state/chemController/:id/doseLog/orp', async (req, res, next) => {
            try {
                let schem = state.chemControllers.getItemById(parseInt(req.params.id));
                let filter = req.body || {};
                let dh = DataLogger.readFromEnd(`chemDosage_orp.log`, ChemicalDoseState, (lineNumber: number, entry: ChemicalDoseState, arr: ChemicalDoseState[]): boolean => {
                    if (entry.id !== schem.id) return;
                    if (typeof filter.lines !== 'undefined' && filter.lines <= arr.length) return false;
                    if (typeof filter.date !== 'undefined' && entry.end < filter.date) return false;
                    return true;
                });
                return res.status(200).send(dh);
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemController/cancelDosing', async (req, res, next) => {
            try {
                let schem = await sys.board.chemControllers.cancelDosingAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemDoser/cancelDosing', async (req, res, next) => {
            try {
                let schem = await sys.board.chemDosers.cancelDosingAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemController/cancelMixing', async (req, res, next) => {
            try {
                let schem = await sys.board.chemControllers.cancelMixingAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });
        app.put('/state/chemDoser/cancelMixing', async (req, res, next) => {
            try {
                let schem = await sys.board.chemDosers.cancelMixingAsync(req.body);
                return res.status(200).send(schem.getExtended());
            }
            catch (err) { next(err); }
        });

        app.get('/state/chlorinator/:id', (req, res) => {
            res.status(200).send(state.chlorinators.getItemById(parseInt(req.params.id, 10), false).getExtended());
        });
        app.get('/state/circuit/:id', (req, res) => {
            res.status(200).send(state.circuits.getItemById(parseInt(req.params.id, 10)).get());
        });
        app.get('/state/feature/:id', (req, res) => {
            res.status(200).send(state.features.getItemById(parseInt(req.params.id, 10)).get());
        });
        app.get('/state/schedule/:id', (req, res) => {
            res.status(200).send(state.schedules.getItemById(parseInt(req.params.id, 10)).get());
        });
        app.get('/state/circuitGroup/:id', (req, res) => {
            res.status(200).send(state.circuitGroups.getItemById(parseInt(req.params.id, 10)).get());
        });

        app.get('/state/pump/:id', (req, res) => {
            // todo: need getInterfaceById.get() for features
            let pump = state.pumps.getItemById(parseInt(req.params.id, 10));
            return res.status(200).send(pump.getExtended());
        });
        app.put('/state/circuit/setState', async (req, res, next) => {
            try {
                // Do some work to allow the legacy state calls to work.  For some reason the state value is generic while all of the
                // circuits are actually binary states.  While this may need to change in the future it seems like a distant plan
                // that circuits would have more than 2 states.  Not true for other equipment but certainly true for individual circuits/features/groups.
                let isOn = utils.makeBool(typeof req.body.isOn !== 'undefined' ? req.body.isOn : req.body.state);
                //state.circuits.setCircuitState(parseInt(req.body.id, 10), utils.makeBool(req.body.state));
                let cstate = await sys.board.circuits.setCircuitStateAsync(parseInt(req.body.id, 10), isOn);
                return res.status(200).send(cstate.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/circuitGroup/setState', async (req, res, next) => {
            console.log(`request:  ${JSON.stringify(req.body)}... id: ${req.body.id}  state: ${req.body.state} isOn: ${req.body.isOn}`);
            let isOn = utils.makeBool(typeof req.body.isOn !== 'undefined' ? req.body.isOn : req.body.state);
            let cstate = await sys.board.circuits.setCircuitGroupStateAsync(parseInt(req.body.id, 10), isOn);
            return res.status(200).send(cstate.get(true));
        });
        app.put('/state/lightGroup/setState', async (req, res, next) => {
            console.log(`request:  ${JSON.stringify(req.body)}... id: ${req.body.id}  state: ${req.body.state} isOn: ${req.body.isOn}`);
            let isOn = utils.makeBool(typeof req.body.isOn !== 'undefined' ? req.body.isOn : req.body.state);
            let cstate = await sys.board.circuits.setLightGroupStateAsync(parseInt(req.body.id, 10), isOn);
            return res.status(200).send(cstate.get(true));
        });
        app.put('/state/circuit/toggleState', async (req, res, next) => {
            try {
                let cstate = await sys.board.circuits.toggleCircuitStateAsync(parseInt(req.body.id, 10));
                return res.status(200).send(cstate.get(true));
            }
            catch (err) {next(err);}
        });    
        app.put('/state/feature/toggleState', async (req, res, next) => {
            try {
                let fstate = await sys.board.features.toggleFeatureStateAsync(parseInt(req.body.id, 10));
                return res.status(200).send(fstate.get(true));
            }
            catch (err) {next(err);}
        });    
        app.put('/state/circuit/setTheme', async (req, res, next) => {
            try {
                let theme = await state.circuits.setLightThemeAsync(parseInt(req.body.id, 10), sys.board.valueMaps.lightThemes.encode(req.body.theme));
               return res.status(200).send(theme.get(true));
            } 
            catch (err) { next(err); }
        });
        app.put('/state/light/setTheme', async (req, res, next) => {
            try {
                let theme = await state.circuits.setLightThemeAsync(parseInt(req.body.id, 10), sys.board.valueMaps.lightThemes.encode(req.body.theme));
                return res.status(200).send(theme.get(true));
            }
            catch (err) { next(err); }
        });

        app.put('/state/light/runCommand', async (req, res, next) => {
            try {
                let slight = await sys.board.circuits.runLightCommandAsync(req.body);
                return res.status(200).send(slight.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/light/:id/colorSync', async (req, res, next) => {
            try {
                let slight = await sys.board.circuits.runLightCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorsync' });
                return res.status(200).send(slight.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/light/:id/colorHold', async (req, res, next) => {
            try {
                let slight = await sys.board.circuits.runLightCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorhold' });
                return res.status(200).send(slight.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/light/:id/colorRecall', async (req, res, next) => {
            try {
                let slight = await sys.board.circuits.runLightCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorecall' });
                return res.status(200).send(slight.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/light/:id/lightThumper', async (req, res, next) => {
            try {
                let slight = await sys.board.circuits.runLightCommandAsync({ id: parseInt(req.params.id, 10), command: 'lightthumper' });
                return res.status(200).send(slight.get(true));
            }
            catch (err) { next(err); }
        });

/*         app.put('/state/intellibrite/setTheme', (req, res) => {
            let id = sys.board.equipmentIds.circuitGroups.start; 
            if (typeof req.body.theme !== 'undefined') id = parseInt(req.body.id, 10);
            sys.board.circuits.setLightGroupThemeAsync(id ,parseInt(req.body.theme, 10));
            return res.status(200).send('OK');
        }); */
        app.put('/state/temps', async (req, res, next) => {
            try {
                let controller = await sys.board.system.setTempsAsync(req.body);
                return res.status(200).send(controller.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/circuit/setDimmerLevel', async (req, res, next) => {
            try {
                let cstate = await sys.board.circuits.setDimmerLevelAsync(parseInt(req.body.id, 10), parseInt(req.body.level, 10));
                return res.status(200).send(cstate.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/light/setBrightness', async (req, res, next) => {
            try {
                let cstate = await sys.board.circuits.setDimmerLevelAsync(
                    parseInt(req.body.id, 10),
                    parseInt(typeof req.body.level !== 'undefined' ? req.body.level : req.body.brightness, 10)
                );
                return res.status(200).send(cstate.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/light/setColor', async (req, res, next) => {
            try {
                let cstate = await sys.board.circuits.setLightColorAsync(parseInt(req.body.id, 10), {
                    red: parseInt(typeof req.body.red !== 'undefined' ? req.body.red : req.body.r, 10),
                    green: parseInt(typeof req.body.green !== 'undefined' ? req.body.green : req.body.g, 10),
                    blue: parseInt(typeof req.body.blue !== 'undefined' ? req.body.blue : req.body.b, 10)
                });
                return res.status(200).send(cstate.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/feature/setState', async (req, res, next) => {
            try {
                let isOn = utils.makeBool(typeof req.body.isOn !== 'undefined' ? req.body.isOn : req.body.state);
                let fstate = await state.features.setFeatureStateAsync(req.body.id, isOn);
                return res.status(200).send(fstate.get(true));
            }
            catch (err){ next(err); }
        });
        app.put('/state/body/heatMode', async (req, res, next) => {
            // RKS: 06-24-20 -- Changed this so that users can send in the body id, circuit id, or the name.
            try {
                // Map the mode that was passed in.  This should accept the text based name or the ordinal id value.
                let mode = parseInt(req.body.mode, 10);
                let val;
                if (isNaN(mode)) mode = parseInt(req.body.heatMode, 10);
                if (!isNaN(mode)) val = sys.board.valueMaps.heatModes.transform(mode);
                else {
                    let smode = req.body.mode || req.body.heatMode;
                    if (typeof smode === 'string') smode = smode.toLowerCase();
                    else {
                        return next(new ServiceParameterError(`Invalid mode supplied ${req.body.mode || req.body.heatMode}.`, 'body', 'heatmode', smode));
                    }
                    val = sys.board.valueMaps.heatModes.transformByName(smode);
                    if (typeof val.val === 'undefined') {
                        return next(new ServiceParameterError(`Invalid value for heatMode: ${req.body.mode}`, 'body', 'heatMode', mode));
                    }
                }
                mode = val.val;
                let body = sys.bodies.findByObject(req.body);
                if (typeof body === 'undefined') return next(new ServiceParameterError(`Cannot set body heatMode.  You must supply a valid id, circuit, name, or type for the body`, 'body', 'id', req.body.id));
                let tbody = await sys.board.bodies.setHeatModeAsync(body, mode);
                return res.status(200).send(tbody.get(true));
            } catch (err) { next(err); }
        });
        app.put('/state/body/setPoint', async (req, res, next) => {
            // RKS: 06-24-20 -- Changed this so that users can send in the body id, circuit id, or the name.
            // RKS: 05-14-21 -- Added cooling setpoints for the body.
            try {
                
                let body = sys.bodies.findByObject(req.body);
                if (typeof body === 'undefined') return next(new ServiceParameterError(`Cannot set body setPoint.  You must supply a valid id, circuit, name, or type for the body`, 'body', 'id', req.body.id));
                if (typeof req.body.coolSetpoint !== 'undefined' && !isNaN(parseInt(req.body.coolSetpoint, 10)))
                    await sys.board.bodies.setCoolSetpointAsync(body, parseInt(req.body.coolSetpoint, 10));
                if (typeof req.body.heatSetpoint !== 'undefined' && !isNaN(parseInt(req.body.heatSetpoint, 10)))
                    await sys.board.bodies.setHeatSetpointAsync(body, parseInt(req.body.heatSetpoint, 10));
                else if (typeof req.body.setPoint !== 'undefined' && !isNaN(parseInt(req.body.setPoint, 10)))
                    await sys.board.bodies.setHeatSetpointAsync(body, parseInt(req.body.setPoint, 10));
                let tbody = state.temps.bodies.getItemById(body.id);
                return res.status(200).send(tbody.get(true));
            } catch (err) { next(err); }
        });
        app.put('/state/chlorinator', async (req, res, next) => {
            try {
                let schlor = await sys.board.chlorinator.setChlorAsync(req.body);
                return res.status(200).send(schlor.get(true));
            } catch (err) { next(err); }
        });
        // this ../setChlor should really be EOL for PUT /state/chlorinator above
        app.put('/state/chlorinator/setChlor', async (req, res, next) => {
            try {
                let schlor = await sys.board.chlorinator.setChlorAsync(req.body);
                return res.status(200).send(schlor.get(true));
            } catch (err) { next(err); }
        });
        app.put('/state/chlorinator/poolSetpoint', async (req, res, next) => {
            try {
                let obj = { id: req.body.id, poolSetpoint: parseInt(req.body.setPoint, 10) }
                let schlor = await sys.board.chlorinator.setChlorAsync(obj);
                return res.status(200).send(schlor.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/chlorinator/spaSetpoint', async (req, res, next) => {
            try {
                let obj = { id: req.body.id, spaSetpoint: parseInt(req.body.setPoint, 10) }
                let schlor = await sys.board.chlorinator.setChlorAsync(obj);
                return res.status(200).send(schlor.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/chlorinator/superChlorHours', async (req, res, next) => {
            try {
                let obj = { id: req.body.id, superChlorHours: parseInt(req.body.hours, 10) }
                let schlor = await sys.board.chlorinator.setChlorAsync(obj);
                return res.status(200).send(schlor.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/chlorinator/superChlorinate', async (req, res, next) => {
            try {
                let obj = { id: req.body.id, superChlorinate: utils.makeBool(req.body.superChlorinate) }
                let schlor = await sys.board.chlorinator.setChlorAsync(obj);
                return res.status(200).send(schlor.get(true));
            }
            catch (err) { next(err); }
        });
        // AutoSwg: computes (and, on confirmation, applies) a recommended SWG%
        // from the configured PoolMath share page. See controller/AutoSwgService.ts
        // for the calculation and controller/Equipment.ts's AutoSwg class for the
        // persisted settings (exposed under /config/autoSwg).
        app.get('/state/autoSwg', (req, res) => {
            return res.status(200).send(state.autoSwg.get(true));
        });
        // SWG % changes -- applied recommendations (with the inputs/outputs behind
        // each) and manual changes -- oldest first; kept for 18 months. See
        // controller/AutoSwgHistory.ts.
        app.get('/state/autoSwg/history', (req, res) => {
            return res.status(200).send(readAutoSwgHistory());
        });
        // The same history merged with PoolMath's, as a calculation would see it: FC
        // readings from PoolMath and SWG % entries from the local log plus PoolMath's
        // (a PoolMath SWG entry within an hour of a local one is left out). Each entry
        // is labeled with its source. Falls back to local-only data if PoolMath can't
        // be read (see poolMathError in the response).
        app.get('/state/autoSwg/history/combined', async (req, res, next) => {
            try {
                let combined = await buildCombinedHistory({ shareCode: sys.autoSwg.shareCode, poolName: sys.autoSwg.poolName || undefined, gallons: sys.autoSwg.gallons }, undefined, toLocalSwgEntries(readAutoSwgHistory()), () => ({ fc: archivedFcReadings(), swg: archivedSwgEvents(), cya: archivedCyaReadings(), chlorine: archivedChlorineAdditions() }), refreshAutoSwgArchiveFromPage, readAutoSwgHistory().filter(r => r.source === 'settings' && Array.isArray(r.changes)).map(r => ({ ts: r.appliedAt, changes: r.changes, via: r.via })));
                return res.status(200).send(combined);
            }
            catch (err) { next(err); }
        });
        // Runs the background PoolMath history sync now (rather than at its next scheduled time)
        // and reports what it archived. PoolMath rate limits the share endpoint, so this can
        // take a minute or more when a request was made recently.
        app.post('/state/autoSwg/history/poolmath/sync', async (req, res, next) => {
            try {
                if (autoSwgArchiveRunning) throw new ServiceParameterError('A PoolMath history sync is already running.', 'autoSwg', 'sync', 'running');
                let cfg = sys.autoSwg;
                autoSwgArchiveRunning = true;
                let r;
                try { r = await syncPoolMathArchive(cfg.shareCode, cfg.poolName || undefined); }
                finally { autoSwgArchiveRunning = false; }
                state.autoSwg.archiveSyncedAt = new Date().toISOString();
                state.autoSwg.archiveCount = r.total;
                state.autoSwg.archiveOldest = r.oldest;
                state.autoSwg.archiveError = undefined;
                state.autoSwg.emitEquipmentChange();
                return res.status(200).send(r);
            }
            catch (err) {
                state.autoSwg.archiveError = err.message;
                state.autoSwg.emitEquipmentChange();
                next(err);
            }
        });
        // How well the algorithm's projections have matched the FC readings actually measured (see
        // buildProjectionAccuracy). Reads the PoolMath share page once; ?days= sets how far back (default 120).
        app.get('/state/autoSwg/projectionAccuracy', async (req, res, next) => {
            try {
                let cfg = sys.autoSwg;
                if (!cfg.shareCode) throw new ServiceParameterError('AutoSwg is not configured: shareCode is required.', 'autoSwg', 'shareCode', cfg.shareCode);
                let days = parseInt(String(req.query.days), 10);
                days = isNaN(days) ? 365 : Math.max(14, Math.min(540, days));
                // The same inputs a normal calculation uses (see runAutoSwgRecommendation).
                let report = await buildProjectionAccuracy(autoSwgReportParams(cfg), { lookbackDays: days, localSwgEntries: toLocalSwgEntries(readAutoSwgHistory()), historyRecords: readAutoSwgHistory(), tuningChangedAt: cfg.tuningChangedAt, archive: autoSwgArchiveForReports() });
                return res.status(200).send(report);
            }
            catch (err) { next(err); }
        });
        // Scores alternative settings (averaging window, daylight weighting, chlorine credit, anomaly
        // tolerance) on the same readings as the current ones (see buildWhatIfSweep). ?days= sets how
        // far back (default 365). Takes a few seconds; it yields to the rest of njsPC as it goes.
        app.get('/state/autoSwg/projectionAccuracy/whatIf', async (req, res, next) => {
            try {
                let cfg = sys.autoSwg;
                if (!cfg.shareCode) throw new ServiceParameterError('AutoSwg is not configured: shareCode is required.', 'autoSwg', 'shareCode', cfg.shareCode);
                let days = parseInt(String(req.query.days), 10);
                days = isNaN(days) ? 365 : Math.max(14, Math.min(540, days));
                let sweep = await buildWhatIfSweep(autoSwgReportParams(cfg), { lookbackDays: days, localSwgEntries: toLocalSwgEntries(readAutoSwgHistory()), archive: autoSwgArchiveForReports() });
                return res.status(200).send(sweep);
            }
            catch (err) { next(err); }
        });
        // One guided recommendation from the saved settings and the FC history (see buildTune): the accuracy and
        // what-if reports boiled down to a single change, or "your settings look good".
        app.get('/state/autoSwg/tune', async (req, res, next) => {
            try {
                let cfg = sys.autoSwg;
                if (!cfg.shareCode) throw new ServiceParameterError('AutoSwg is not configured: shareCode is required.', 'autoSwg', 'shareCode', cfg.shareCode);
                let tune = await buildTune(autoSwgReportParams(cfg), { lookbackDays: 365, localSwgEntries: toLocalSwgEntries(readAutoSwgHistory()), historyRecords: readAutoSwgHistory(), tuningChangedAt: cfg.tuningChangedAt, archive: autoSwgArchiveForReports() });
                let status = autoSwgTuneStatus(cfg);   // as it stood before this run
                recordAutoSwgTuneRun(cfg, tune, status, 'manual');
                return res.status(200).send(tune);
            }
            catch (err) { next(err); }
        });
        // Is another Tune worth it yet? Answered from what is stored locally (no PoolMath request): when Tune last
        // ran, how many FC readings have arrived since (from the archive, which every PoolMath read keeps current),
        // and whether the tuning settings were changed by hand since -- which would make tuning again worthwhile.
        app.get('/state/autoSwg/tune/status', (req, res, next) => {
            try { return res.status(200).send(autoSwgTuneStatus(sys.autoSwg)); }
            catch (err) { next(err); }
        });
        // The recent Tune runs, newest first.
        app.get('/state/autoSwg/tune/history', (req, res, next) => {
            try { return res.status(200).send(readTuneHistory().slice().reverse()); }
            catch (err) { next(err); }
        });
        app.post('/state/autoSwg/recommend', async (req, res, next) => {
            try {
                let skipped = await runAutoSwgRecommendation('new');
                await applyIfAutoApplyEnabled(skipped, 'check-now');
                return res.status(200).send(autoSwgResponse(skipped));
            }
            catch (err) {
                state.autoSwg.error = err.message;
                state.autoSwg.pending = false;
                state.autoSwg.emitEquipmentChange();
                next(err);
            }
        });
        // Re-runs the calculation against the SAME target FC/date an already-applied
        // recommendation committed to (not today's configured target days, which would just
        // restart the countdown), using fresh PoolMath data -- lets a glide-to-target
        // already in progress be corrected mid-flight instead of waiting out a stale
        // estimate until the original deadline arrives. Used when Auto-Apply is off (with
        // Auto-Apply on, /refreshAndApply below decides between this and a new target).
        app.post('/state/autoSwg/refine', async (req, res, next) => {
            try {
                let skipped = await runAutoSwgRecommendation('refine');
                await applyIfAutoApplyEnabled(skipped, 'refine');
                return res.status(200).send(autoSwgResponse(skipped));
            }
            catch (err) {
                state.autoSwg.error = err.message;
                state.autoSwg.pending = false;
                state.autoSwg.emitEquipmentChange();
                next(err);
            }
        });
        // The single button shown while Auto-Apply is on: refreshes the % against the
        // in-flight target and deadline if the projected FC is within the configured
        // new-target-date threshold of the target FC, otherwise starts a new target (new
        // deadline) the way Check Now does -- and applies the result either way.
        app.post('/state/autoSwg/refreshAndApply', async (req, res, next) => {
            try {
                if (!sys.autoSwg.automationAvailable) throw new ServiceParameterError('Auto-Apply is not available. Use Check Now and apply the recommendation yourself.', 'autoSwg', 'autoApplyEnabled', false);
                let skipped = await runAutoSwgRecommendation('auto');
                await applyIfAutoApplyEnabled(skipped, 'refresh-and-apply');
                return res.status(200).send(autoSwgResponse(skipped));
            }
            catch (err) {
                state.autoSwg.error = err.message;
                state.autoSwg.pending = false;
                state.autoSwg.emitEquipmentChange();
                next(err);
            }
        });
        app.put('/state/autoSwg/apply', async (req, res, next) => {
            try {
                let pctOverride = typeof req.body.poolSetpoint !== 'undefined' ? parseInt(req.body.poolSetpoint, 10) : undefined;
                let schlor = await applyAutoSwgRecommendation(false, pctOverride);
                return res.status(200).send({ chlorinator: schlor.get(true), autoSwg: state.autoSwg.get(true) });
            }
            catch (err) { next(err); }
        });
        // Dismisses the red "automatic change exceeded threshold" banner: you have seen the change an automatic check made. Nothing else changes.
        app.put('/state/autoSwg/acknowledge', (req, res) => {
            state.autoSwg.lastAutoApplyLargeChange = false;
            state.autoSwg.emitEquipmentChange();
            return res.status(200).send(state.autoSwg.get(true));
        });
        // Dismisses the current Check Now result without applying it. Clears every field
        // /recommend sets (see clearAutoSwgCalculation) rather than just `pending` -- otherwise
        // the next load would still see lastCheckedAt newer than lastAppliedAt and show the
        // "cancelled" calculation right back again as if it were a fresh, not-yet-applied one.
        // What was actually applied (lastApplied*) and any pending step (step*) are untouched.
        app.put('/state/autoSwg/cancel', (req, res) => {
            clearAutoSwgCalculation();
            state.autoSwg.emitEquipmentChange();
            return res.status(200).send(state.autoSwg.get(true));
        });
        app.put('/state/cancelDelay', async (req, res, next) => {
            try {
                let delay = await sys.board.system.cancelDelay();
                return res.status(200).send(delay);
            }
            catch (err) { next(err); }
        });
        app.put('/state/manualOperationPriority', async (req, res, next) => {
            try {
                let cstate = await sys.board.system.setManualOperationPriority(parseInt(req.body.id, 10));
                return res.status(200).send(cstate.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/runCommand', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync(req.body);
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/:id/colorSync', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorsync' });
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/:id/colorSet', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorset' });
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/:id/colorSwim', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorswim' });
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/:id/colorHold', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorhold' });
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/:id/colorRecall', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync({ id: parseInt(req.params.id, 10), command: 'colorrecall' });
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/lightGroup/:id/lightThumper', async (req, res, next) => {
            try {
                let sgroup = await sys.board.circuits.runLightGroupCommandAsync({ id: parseInt(req.params.id, 10), command: 'lightthumper' });
                return res.status(200).send(sgroup.get(true));
            }
            catch (err) { next(err); }
        });
        app.put('/state/panelMode', async (req, res, next) => {
            try {
                await sys.board.system.setPanelModeAsync(req.body);
                return res.status(200).send(state.controllerState);
            } catch (err) { next(err); }
        });
        app.put('/state/toggleServiceMode', async (req, res, next) => {
            try {
                let data = extend({}, req.body);
                if (state.mode === 0) {
                    if (typeof data.timeout !== 'undefined' && !isNaN(data.timeout)) data.mode = 'timeout';
                    else data.mode = 'service';
                    await sys.board.system.setPanelModeAsync(req.body);
                }
                else sys.board.system.setPanelModeAsync({ mode: 'auto' });
                return res.status(200).send(state.controllerState);
            } catch (err) { next(err); }
        });
        app.get('/state/emitAll', (req, res) => {
            res.status(200).send(state.emitAllEquipmentChanges());
        });
        app.put('/state/cancelDelay', async (req, res, next) => {
            try {
                let result = await (sys.board as any).cancelDelay();
                return res.status(200).send(result);
            } catch (err) { next(err); }
        });
        app.get('/state/:section', (req, res) => {
            res.status(200).send(state.getState(req.params.section));
        });
    }
}