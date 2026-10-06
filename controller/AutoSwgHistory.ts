/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026.
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

// Persistent log of SWG % changes on the AutoSwg chlorinator. A record is written
// (a) each time a recommendation is applied, capturing the inputs and outputs of
// the calculation behind it, and (b) each time the pool setpoint is changed some
// other way (API, socket, MQTT, the panel), with just the capacity inputs needed
// to interpret it. AutoSwgService merges these records with PoolMath's SWG log
// entries and prefers the local ones (see mergeSwgEvents there), so the
// calculation reflects what was actually set even if the change was never logged
// on PoolMath.
//
// Stored as a JSON array in data/autoSwgHistory.json (next to poolConfig.json,
// which -- unlike the logs/ folder -- is not rotated away). Records older than
// AUTO_SWG_HISTORY_MONTHS are pruned each time a record is added.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import type { LocalSwgEntry } from './AutoSwgService';

export const AUTO_SWG_HISTORY_MONTHS = 18;

// What caused an AutoSwg apply: the periodic check, the Refresh and Apply button, Check Now or Refresh: Adjust % with
// Auto-Apply on, a person pressing Apply after reviewing the number, or the step to the maintenance % after a target.
export type AutoSwgApplyTrigger = 'automatic-check' | 'refresh-and-apply' | 'check-now' | 'refine' | 'reviewed' | 'step';

// One AutoSwg setting that was changed, with its old and new value.
export interface AutoSwgSettingChange { setting: string; from: any; to: any; }

// Bump this when the calculation itself changes in a way that can change its numbers (not for settings or display), so
// the history shows which version of the algorithm produced each apply. 1 = before the projection weighting and taper,
// 2 = weighting and taper, the PoolMath archive and the liquid chlorine credit as they are now.
export const AUTO_SWG_ALGORITHM_VERSION = 2;

// The settings whose changes are logged. A change to the target, the days to reach it or the tuning options is what to
// line up against the FC history when judging how the calculation did.
export const AUTO_SWG_LOGGED_SETTINGS = [
    'enabled', 'chlorinatorId', 'gallons', 'swgLbsPerDay', 'swgStartTime', 'swgStopTime', 'scheduleId', 'timezone',
    'targetFc', 'targetPeriodsAbove', 'targetPeriodsBelow', 'newTargetDateThresholdPpm', 'autoStepEnabled',
    'autoApplyEnabled', 'autoCheckEnabled', 'autoCheckHours', 'autoCheckStartTime', 'autoApplyWarnThresholdPct',
    'windowDays', 'daytimeLossSharePct', 'creditChlorineAdditions', 'fcAnomalyTolerancePpm',
    'projectionWeight', 'projectionTaperStartDays', 'projectionTaperEndDays', 'overshootPpmPerDay', 'protectOvernightLow', 'nightBurnRatio', 'burnTempAdjust',
    'mode', 'autoTuneEnabled', 'autoTuneAfterFcReadings', 'autoTuneApplyEnabled', 'autoTuneApplyAfterManual',
    'stormResponseEnabled', 'stormMaxExtraPct', 'stormMaxDays', 'awayEnabled',
    'shareCode', 'poolName'
];
// Logged as "changed" only: the values are private, but a different pool's data changes everything after it.
const AUTO_SWG_MASKED_SETTINGS = ['shareCode', 'poolName'];

export interface AutoSwgHistoryRecord {
    source: 'auto' | 'manual' | 'settings'; // 'auto' = applied via AutoSwg; 'manual' = changed some other way; 'settings' = AutoSwg settings were changed (see `changes`)
    changes?: AutoSwgSettingChange[]; // settings only: what changed
    via?: 'tune' | 'auto-tune' | 'away-ended'; // settings only: the change was applied from the Tune dialog, or by auto tune
    algorithm?: number;       // AUTO_SWG_ALGORITHM_VERSION when this was written (absent on older records)
    trigger?: AutoSwgApplyTrigger; // auto only: what caused it (absent on records written before this was kept)
    // auto only: what this apply did with the target date. 'kept' = refreshed against the original deadline; 'new' = a new
    // target was started; 'new-extended' = a new target whose deadline was then moved out to when consumption alone reaches
    // the target FC. Absent on records written before this was kept, and on steps.
    targetOutcome?: 'kept' | 'new' | 'new-extended';
    targetFc?: number;
    targetDate?: string;           // ISO: the deadline this apply is aiming for
    previousTargetDate?: string;   // ISO: the in-flight deadline before this apply, if there was one
    targetStrayPpm?: number;       // how far the projected FC was from the target FC when this apply decided kept or new
    targetThresholdPpm?: number;   // the new-target-date threshold in force then (unset for Check Now, which has no in-flight target)
    runWindowChange?: { from: string; to: string };   // set when the run window differs from the previous apply's (to the nearest 10 minutes), for example "08:20-18:09" to "09:20-17:09"
    appliedAt: string;        // ISO time the setpoint was sent (auto) or the change was detected (manual)
    appliedPct?: number;      // the SWG % now in effect (not set on a settings record)
    recommendedPct?: number;  // auto only: what the calculation recommended (differs from appliedPct if overridden)
    previousPct?: number;     // the SWG % before this change
    ppmPerDay?: number;       // appliedPct x window capacity; PoolMath-style "X ppm FC" equivalent
    hrs?: number;             // run-window length used for ppmPerDay
    away?: any;               // settings only, when Away protection ended: a summary of the period (see awaySummary in web/services/state/State.ts)
    inputs?: any;             // the calculation's parameters (auto) or the capacity inputs (manual)
    outputs?: any;            // auto only: the calculation's results as of apply (see AutoSwgState)
}

function historyPath(): string { return path.join(process.cwd(), 'data', 'autoSwgHistory.json'); }

export function readAutoSwgHistory(): AutoSwgHistoryRecord[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`AutoSwg: could not read ${historyPath()}: ${err.message}`);
        return [];
    }
}

function pruneOld(records: AutoSwgHistoryRecord[], now: Date): AutoSwgHistoryRecord[] {
    const cutoff = new Date(now.getTime());
    cutoff.setMonth(cutoff.getMonth() - AUTO_SWG_HISTORY_MONTHS);
    return records.filter(r => {
        const t = new Date(r.appliedAt).getTime();
        return !isNaN(t) && t >= cutoff.getTime();
    });
}

// Appends `record`, drops anything older than AUTO_SWG_HISTORY_MONTHS, and writes
// the file via a temp file + rename so a crash can't leave it truncated.
export function appendAutoSwgHistory(record: AutoSwgHistoryRecord): AutoSwgHistoryRecord[] {
    const records = pruneOld([...readAutoSwgHistory(), record], new Date());
    const file = historyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return records;
}

// Reads the logged settings off an AutoSwg config object (anything with those properties).
export function snapshotAutoSwgSettings(cfg: any): { [setting: string]: any } {
    const snap: { [setting: string]: any } = {};
    for (const k of AUTO_SWG_LOGGED_SETTINGS) snap[k] = cfg ? cfg[k] : undefined;
    return snap;
}

// Logs the settings that differ between two snapshots as one 'settings' record. Nothing is written when none differ
// (saving the same values again is not a change).
export function logAutoSwgSettingChanges(before: { [setting: string]: any }, after: { [setting: string]: any }, via?: 'tune' | 'auto-tune' | 'away-ended', away?: any): void {
    const changes: AutoSwgSettingChange[] = [];
    for (const k of AUTO_SWG_LOGGED_SETTINGS) {
        if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
        const masked = AUTO_SWG_MASKED_SETTINGS.indexOf(k) >= 0;
        changes.push({ setting: k, from: masked ? '(hidden)' : before[k], to: masked ? '(hidden)' : after[k] });
    }
    if (changes.length === 0) return;
    const record: AutoSwgHistoryRecord = { source: 'settings', appliedAt: new Date().toISOString(), algorithm: AUTO_SWG_ALGORITHM_VERSION, changes: changes };
    if (via) record.via = via;
    if (away) record.away = away;
    appendAutoSwgHistory(record);
}

// The records that carry enough data to stand in for a PoolMath SWG log entry.
export function toLocalSwgEntries(records: AutoSwgHistoryRecord[]): LocalSwgEntry[] {
    const entries: LocalSwgEntry[] = [];
    for (const r of records) {
        if (typeof r.ppmPerDay !== 'number' || typeof r.hrs !== 'number' || typeof r.appliedPct !== 'number') continue;
        entries.push({ ts: r.appliedAt, ppmPerDay: r.ppmPerDay, hrs: r.hrs, pct: r.appliedPct, kind: r.source === 'manual' ? 'manual' : 'auto', record: r });
    }
    return entries;
}
