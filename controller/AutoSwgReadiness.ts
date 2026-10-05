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

// Whether there is enough FC and SWG history for the tuning tools and the automation (Auto-Apply and the automatic check) to be worth
// showing. The tuning reports replay the calculation at each past FC reading, so what they have to work with is the number of readings
// that can be scored with a full averaging window behind them, over enough weeks to span more than one stretch of weather. The
// automation changes the chlorinator without anyone reviewing the number, so it waits for the same evidence.
//
// A reading is "scorable" by the same rule the reports use (firstScorableReading in AutoSwgService): the fourth reading after the
// first SWG entry and every one after it. Tune needs at least 15 of them to say anything (its "insufficient" cutoff), which is the
// default minimum here, and a minimum number of days (two averaging windows) keeps a short run of daily tests, which all share one
// stretch of weather, from counting as enough. Automation additionally needs a Tune that was run and accepted (AutoSwg.tuneAcceptedAt).
// The check uses only what is stored locally (the PoolMath archive and the AutoSwg history), so it needs no network request. The
// thresholds are settings on the AutoSwg config that are not on the settings screen (gateMinFcReadings, gateMinSwgEntries,
// gateMinDays; gateOff makes everything always available).

import { AutoSwg, setAutoSwgReadinessProvider } from './Equipment';
import { archivedFcReadings, archivedSwgEvents } from './AutoSwgPoolMathArchive';
import { readAutoSwgHistory, toLocalSwgEntries } from './AutoSwgHistory';

export interface AutoSwgReadiness {
    ready: boolean;
    off: boolean;               // the gate is switched off (gateOff), so everything is available
    scorable: number;           // FC readings the reports can score
    scorableNeeded: number;
    swgEntries: number;         // distinct SWG % changes known (PoolMath and the local log)
    swgNeeded: number;
    days: number;               // days since both an FC reading and SWG output were known
    daysNeeded: number;
    windowDays: number;
}

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; value: AutoSwgReadiness } | undefined;

function num(v: any, fallback: number): number { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) && n >= 0 ? n : fallback; }

export function computeAutoSwgReadiness(cfg: AutoSwg, now: Date = new Date()): AutoSwgReadiness {
    const windowDays = num(cfg.windowDays, 21);
    const result: AutoSwgReadiness = {
        ready: false, off: cfg.gateOff === true, scorable: 0, scorableNeeded: num(cfg.gateMinFcReadings, 15), swgEntries: 0,
        swgNeeded: num(cfg.gateMinSwgEntries, 1), days: 0, daysNeeded: num(cfg.gateMinDays, 42), windowDays: windowDays
    };
    if (result.off) { result.ready = true; return result; }
    const dayMs = 86400000;
    const fc: number[] = archivedFcReadings().map(e => e.ts.getTime()).filter(t => isFinite(t)).sort((a, b) => a - b);
    const swgAll: number[] = [
        ...archivedSwgEvents().map(e => e.ts.getTime()),
        ...toLocalSwgEntries(readAutoSwgHistory()).map(e => new Date(e.ts).getTime())
    ].filter(t => isFinite(t)).sort((a, b) => a - b);
    // The same change can be in PoolMath and the local log a few minutes apart: count it once.
    const swg: number[] = [];
    for (const t of swgAll) if (swg.length === 0 || t - swg[swg.length - 1] > 60 * 60 * 1000) swg.push(t);
    result.swgEntries = swg.length;
    if (fc.length > 0 && swg.length > 0) {
        const baseline = Math.max(fc[0], swg[0]);       // the first moment an FC reading and SWG output are both known
        result.days = Math.max(0, Math.floor((now.getTime() - baseline) / dayMs * 10) / 10);
        const first = fc.findIndex(t => t >= swg[0]);
        result.scorable = first < 0 ? 0 : Math.max(0, fc.length - (first + 4));
    }
    result.ready = result.scorable >= result.scorableNeeded && result.swgEntries >= result.swgNeeded && result.days >= result.daysNeeded;
    return result;
}

// The result, kept for a few minutes: the settings getters ask on every use.
export function getAutoSwgReadiness(cfg: AutoSwg, fresh: boolean = false): AutoSwgReadiness {
    const now = Date.now();
    if (!fresh && cache && now - cache.at < CACHE_MS) return cache.value;
    const value = computeAutoSwgReadiness(cfg);
    cache = { at: now, value: value };
    return value;
}

// What the settings screen needs: the progress toward unlocking tuning, whether a Tune has been accepted, and what is available.
export function autoSwgGateInfo(cfg: AutoSwg): AutoSwgReadiness & { tuningAvailable: boolean; tuneAccepted: boolean; automationAvailable: boolean; advanced: boolean } {
    const r = getAutoSwgReadiness(cfg, true);
    return Object.assign({}, r, { advanced: cfg.mode === 'advanced', tuningAvailable: cfg.tuningAvailable, tuneAccepted: typeof cfg.tuneAcceptedAt === 'string' && cfg.tuneAcceptedAt.length > 0, automationAvailable: cfg.automationAvailable });
}

setAutoSwgReadinessProvider(cfg => getAutoSwgReadiness(cfg));
