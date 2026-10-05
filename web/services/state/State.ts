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
import * as extend from "extend";

import { state, ICircuitState, LightGroupState, ICircuitGroupState, ChemicalDoseState, ChlorinatorState } from "../../../controller/State";
import { sys } from "../../../controller/Equipment";
import { utils } from '../../../controller/Constants';
import { logger } from "../../../logger/Logger";
import { DataLogger } from "../../../logger/DataLogger";
import { conn } from "../../../controller/comms/Comms";
import { config } from "../../../config/Config";

import { ServiceParameterError } from "../../../controller/Errors";
import { ChlorinatorStateMessage } from "../../../controller/comms/messages/status/ChlorinatorStateMessage";
import { buildCombinedHistory, buildProjectionAccuracy, buildTune, buildWhatIfSweep, computeRecommendation, computeSwgCapacity, formatLocalDateTime, minutesToHHMM, nextScheduledCheck } from "../../../controller/AutoSwgService";
import type { AutoSwgParams, PageReadings } from "../../../controller/AutoSwgService";
import { appendTuneHistory, readTuneHistory } from "../../../controller/AutoSwgTuneHistory";
import { appendAutoSwgHistory, readAutoSwgHistory, toLocalSwgEntries, AutoSwgApplyTrigger, AUTO_SWG_ALGORITHM_VERSION } from "../../../controller/AutoSwgHistory";
import { archivedChlorineAdditions, archivedCyaReadings, archivedFcReadings, archivedSwgEvents, isPoolMathArchiveCurrent, poolMathArchiveSummary, refreshPoolMathArchiveFromPage, syncPoolMathArchive } from "../../../controller/AutoSwgPoolMathArchive";

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
function autoSwgSettingsKey(): string {
    let cfg = sys.autoSwg;
    let start = cfg.swgStartTime, stop = cfg.swgStopTime;
    try { const win = resolveAutoSwgRunWindow(cfg); start = win.swgStartTime; stop = win.swgStopTime; }
    catch (err) { /* the typed-in window is the fallback */ }
    return [
        cfg.targetFc, cfg.targetDaysAbove, cfg.targetDaysBelow, cfg.newTargetDateThresholdPpm,
        cfg.windowDays, cfg.gallons, cfg.swgLbsPerDay, cfg.timezone, cfg.daytimeLossSharePct, cfg.creditChlorineAdditions, cfg.fcAnomalyTolerancePpm, cfg.projectionWeight, cfg.projectionTaperStartDays, cfg.projectionTaperEndDays,
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
    if (mode !== 'new') {
        let at = state.autoSwg.lastAppliedTargetDate ? new Date(state.autoSwg.lastAppliedTargetDate).getTime() : NaN;
        if (mode === 'refine') {
            if (!state.autoSwg.lastAppliedTargetDate) throw new ServiceParameterError('There is no in-flight AutoSwg target to refine toward -- apply a recommendation first.', 'autoSwg', 'lastAppliedTargetDate', state.autoSwg.lastAppliedTargetDate);
            // With no pending step to clear it (auto-step off), a deadline can pass and
            // linger -- there's nothing left to re-aim at, and a non-positive window would
            // quietly degrade to the maintenance % rather than say so.
            if (isNaN(at) || at <= Date.now()) throw new ServiceParameterError('The target date of the last AutoSwg apply has already passed, so there is nothing left to refine toward -- run Check Now to start a new target.', 'autoSwg', 'lastAppliedTargetDate', state.autoSwg.lastAppliedTargetDate);
        }
        if (!isNaN(at) && at > Date.now() && typeof state.autoSwg.lastAppliedTargetFc === 'number') {
            inFlight = { targetFc: state.autoSwg.lastAppliedTargetFc, targetDate: new Date(at), strayPpm: mode === 'refine' ? Infinity : cfg.newTargetDateThresholdPpm };
        }
    }
    let { swgStartTime, swgStopTime, scheduleNote } = resolveAutoSwgRunWindow(cfg);
    let sunTimes = autoSwgSunTimes(cfg.timezone);
    let chlorRecord = sys.chlorinators.toArray().find(c => c.id === cfg.chlorinatorId);
    let schlor = chlorRecord ? state.chlorinators.getItemById(chlorRecord.id, false) : undefined;
    let result = await computeRecommendation({
        shareCode: cfg.shareCode,
        poolName: cfg.poolName || undefined,
        gallons: cfg.gallons,
        swgLbsPerDay: cfg.swgLbsPerDay,
        swgStartTime: swgStartTime,
        swgStopTime: swgStopTime,
        timezone: cfg.timezone,
        windowDays: cfg.windowDays,
        targetFc: cfg.targetFc,
        targetDaysAbove: cfg.targetDaysAbove,
        targetDaysBelow: cfg.targetDaysBelow,
        inFlight: inFlight,
        sunriseTime: sunTimes.sunrise,
        sunsetTime: sunTimes.sunset,
        daytimeSharePct: cfg.daytimeLossSharePct,
        creditChlorineAdditions: cfg.creditChlorineAdditions,
        fcAnomalyTolerancePpm: cfg.fcAnomalyTolerancePpm,
        projectionWeight: cfg.projectionWeight,
        projectionTaperStartDays: cfg.projectionTaperStartDays,
        projectionTaperEndDays: cfg.projectionTaperEndDays,
    }, undefined, toLocalSwgEntries(readAutoSwgHistory()), refreshAutoSwgArchiveFromPage);
    // A Refresh works from fresh PoolMath data; if the data it read (readings, additions, SWG entries)
    // is exactly what the last apply used -- the newest FC reading is the very one it was based on,
    // and nothing was added, edited or deleted -- there is nothing new and re-running would only restate
    // the same number (or nudge it with extrapolation). Leave everything as it is. Check Now
    // ('new') always runs -- it's the explicit "start over" and also picks up config changes.
    if (mode !== 'new' && inFlight && state.autoSwg.lastAppliedFcAt && result.mostRecentFc && result.mostRecentFc.ts === state.autoSwg.lastAppliedFcAt && state.autoSwg.lastAppliedSettingsKey === autoSwgSettingsKey() && state.autoSwg.lastAppliedDataKey === result.dataKey) {
        return `No new FC reading in PoolMath since ${formatLocalDateTime(new Date(result.mostRecentFc.ts), cfg.timezone)}; nothing to refresh.`;
    }
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
    state.autoSwg.lastAppliedTargetFc = typeof state.autoSwg.pendingTargetFc === 'number' ? state.autoSwg.pendingTargetFc : sys.autoSwg.targetFc;
    state.autoSwg.lastAppliedTargetDate = state.autoSwg.pendingTargetDate;
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
    if (isAutoApply) {
        let threshold = sys.autoSwg.autoApplyWarnThresholdPct;
        let movedBy = typeof previousAppliedPct === 'number' ? Math.abs(pct - previousAppliedPct) : undefined;
        state.autoSwg.lastAutoApplyLargeChange = typeof movedBy === 'number' && typeof threshold === 'number' && movedBy >= threshold;
        if (state.autoSwg.lastAutoApplyLargeChange) logger.warn(`AutoSwg: automatically applied a ${movedBy.toFixed(1)}-point change (to ${pct}%), at or above the ${threshold}-point warning threshold.`);
    }
    else state.autoSwg.lastAutoApplyLargeChange = false; // a human reviewed this one
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
            previousPct: state.autoSwg.currentPct,
            ppmPerDay: typeof capacity === 'number' ? Math.round(capacity * pct) / 100 : undefined,
            hrs: details.swgRunHours,
            inputs: withoutPrivateInputs(details.inputs),
            outputs: outputs,
        });
    }
    catch (err) { logger.error(`AutoSwg: applied ${pct}% but could not write the history log: ${err.message}`); }
    state.autoSwg.pending = false;
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
        state.autoSwg.stepAt = state.autoSwg.lastAppliedTargetDate;
        state.autoSwg.stepPct = maintenancePct;
        armAutoSwgStep();
    }
    else clearAutoSwgStep();
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
export function armAutoSwgAutoCheck(minDelayMs: number = 0) {
    clearAutoSwgAutoCheck();
    let cfg = sys.autoSwg;
    let wasDue = state.autoSwg.nextAutoCheckAt;
    state.autoSwg.nextAutoCheckAt = undefined;
    if (!cfg.enabled || !cfg.autoCheckEnabled || !cfg.autoApplyEnabled || !cfg.shareCode || cfg.chlorinatorId < 0) {
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
    return { fc: archivedFcReadings(), swg: archivedSwgEvents(), cya: archivedCyaReadings(), chlorine: archivedChlorineAdditions() };
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
        targetFc: cfg.targetFc,
        targetDaysAbove: cfg.targetDaysAbove,
        targetDaysBelow: cfg.targetDaysBelow,
        sunriseTime: sunTimes.sunrise,
        sunsetTime: sunTimes.sunset,
        daytimeSharePct: cfg.daytimeLossSharePct,
        creditChlorineAdditions: cfg.creditChlorineAdditions,
        fcAnomalyTolerancePpm: cfg.fcAnomalyTolerancePpm,
        projectionWeight: cfg.projectionWeight,
        projectionTaperStartDays: cfg.projectionTaperStartDays,
        projectionTaperEndDays: cfg.projectionTaperEndDays,
    };
}

// Whether another Tune is worth it yet (see the /state/autoSwg/tune/status route), from what is stored locally.
function autoSwgTuneStatus(cfg: typeof sys.autoSwg) {
    let ms = (v: string) => v ? new Date(v).getTime() : NaN;
    let ref = Math.max(isNaN(ms(cfg.lastTuneAt)) ? -Infinity : ms(cfg.lastTuneAt), isNaN(ms(cfg.lastTuneAppliedAt)) ? -Infinity : ms(cfg.lastTuneAppliedAt));
    let manual = isFinite(ref) && !isNaN(ms(cfg.tuningChangedAt)) && ms(cfg.tuningChangedAt) > ref + 60000;
    let since: number | undefined;
    if (isFinite(ref) && cfg.shareCode && isPoolMathArchiveCurrent(cfg.shareCode, cfg.poolName || undefined)) since = archivedFcReadings().filter(r => r.ts.getTime() > ref).length;
    return { lastTuneAt: cfg.lastTuneAt, lastTuneAppliedAt: cfg.lastTuneAppliedAt, tuningChangedAt: cfg.tuningChangedAt, manualChangeSinceTune: manual, readingsSinceTune: since, needed: 10 };
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

async function runAutoSwgAutoCheck() {
    autoSwgAutoCheckTimer = undefined;
    let cfg = sys.autoSwg;
    if (!cfg.enabled || !cfg.autoApplyEnabled) return; // turned off since this cycle was armed
    try {
        // Same decision as the "Refresh and Apply" button: stay on course for an in-flight
        // target unless the projected FC has strayed past the new-target-date threshold (or
        // there's no in-flight target left), in which case start a new one.
        let skipped = await runAutoSwgRecommendation('auto', 'Automatic check.');
        if (skipped) logger.info(`AutoSwg: automatic check skipped. ${skipped}`);
        else await applyAutoSwgRecommendation(true, undefined, 'automatic-check');
    }
    catch (err) { logger.error(`AutoSwg: automatic check/apply failed: ${err.message}`); }
    finally { armAutoSwgAutoCheck(); }
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
        // The latest message of each kind received from the chlorinator over RS485 since njsPC
        // started (diagnostic; not persisted).
        app.get('/state/chlorinator/:id/rs485', (req, res, next) => {
            try {
                let id = parseInt(req.params.id, 10);
                let chlor = sys.chlorinators.toArray().find(c => c.id === id);
                if (typeof chlor === 'undefined') return next(new ServiceParameterError(`Cannot find a chlorinator with id ${req.params.id}`, 'chlorinator', 'id', req.params.id));
                let cstate = state.chlorinators.getItemById(id, false);
                return res.status(200).send({
                    id: id,
                    name: chlor.name,
                    lastComm: typeof cstate.lastComm === 'number' && cstate.lastComm > 0 ? new Date(cstate.lastComm).toISOString() : undefined,
                    records: ChlorinatorStateMessage.getLastReceived(id)
                });
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
                cfg.lastTuneAt = new Date().toISOString();
                try {
                    appendTuneHistory({
                        ts: cfg.lastTuneAt,
                        settings: { windowDays: cfg.windowDays, daytimeLossSharePct: cfg.daytimeLossSharePct, creditChlorineAdditions: cfg.creditChlorineAdditions, fcAnomalyTolerancePpm: cfg.fcAnomalyTolerancePpm, projectionWeight: cfg.projectionWeight, projectionTaperStartDays: cfg.projectionTaperStartDays, projectionTaperEndDays: cfg.projectionTaperEndDays },
                        readings: tune.readings, history: tune.history, meanAbsError: tune.meanAbsError, unchangedMae: tune.unchangedMae, skill: tune.skill,
                        status: tune.status,
                        recommendation: tune.recommendation ? { kind: tune.recommendation.kind, label: tune.recommendation.label, settings: tune.recommendation.settings, expectedMae: tune.recommendation.expectedMae, change: tune.recommendation.change, low: tune.recommendation.low, high: tune.recommendation.high } : undefined,
                        manualChangeSinceLastTune: status.manualChangeSinceTune, readingsSinceLastTune: status.readingsSinceTune,
                    });
                }
                catch (err) { logger.warn(`AutoSwg: could not record the Tune run: ${err.message}`); }
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