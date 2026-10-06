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

// The guards for auto tune (the automatic mode; see AutoSwg.autoTuneEnabled). Auto tune runs Tune by itself once enough new FC readings
// have arrived since the last one. Applying what Tune recommends, with nobody looking, is held to a higher bar than showing it:
//   * you must have applied a number of Tune recommendations yourself first (autoTuneApplyAfterManual);
//   * you must not have changed the tuning settings by hand since the last Tune;
//   * the data and history must be good enough (autoTuneGuardMinReadings, autoTuneGuardMinDays, autoTuneGuardMaxFcAgeDays, and the
//     calculation must beat "FC unchanged" by autoTuneGuardMinSkill);
//   * the expected gain must be worth it (autoTuneGuardMinGainPpm) and its 90% range must exclude zero;
//   * the same recommendation must have come up on autoTuneApplyConfirmRuns auto tunes in a row, since Tune picks the best of many
//     alternatives and a one-off result may be chance;
//   * only settings with a safe range are changed, and only inside it. The liquid chlorine credit is never changed automatically: it is
//     a statement about what went into the pool, not a tuning knob.
// Every check set to 0 is skipped (where 0 is not a meaningful value). Every reason a recommendation was held is returned, so the
// Tune history and the AutoSwg page can say why.

import { AutoSwg } from './Equipment';
import { TuneResult } from './AutoSwgService';
import { AutoSwgReadiness } from './AutoSwgReadiness';
import { autoTuneRecommendationConfirmed, countManualTuneApplies } from './AutoSwgTuneHistory';

// The settings auto tune may change, and the range each may be moved to (the lowest and highest allowed). A taper end of 0 means no taper.
export const AUTO_TUNE_BOUNDS: { [setting: string]: { min: number; max: number; allowZero?: boolean } | 'boolean' } = {
    windowDays: { min: 14, max: 56 },
    projectionWeight: { min: 0.25, max: 1 },
    projectionTaperStartDays: { min: 2, max: 7 },
    projectionTaperEndDays: { min: 6, max: 14, allowZero: true },
    fcAnomalyTolerancePpm: { min: 1, max: 4 },
    burnTempAdjust: 'boolean',
    nightBurnRatio: { min: 0.25, max: 1 },
};

// How many Tune recommendations have been applied by hand: the count kept in the config, or what the Tune history still holds if more.
export function manualTuneApplies(cfg: AutoSwg): number {
    const kept = typeof cfg.tuneManualApplies === 'number' ? cfg.tuneManualApplies : 0;
    let inHistory = 0;
    try { inHistory = countManualTuneApplies(); } catch (err) { /* the history is optional here */ }
    return Math.max(kept, inHistory);
}

export interface AutoTuneGuardContext {
    manualChangeSinceTune: boolean;     // the tuning settings were changed by hand since the last Tune
    readiness: AutoSwgReadiness;
    newestFcAt?: Date;                  // the newest FC reading known
    now?: Date;
}

export function evaluateAutoTuneApply(cfg: AutoSwg, tune: TuneResult, ctx: AutoTuneGuardContext): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const rec = tune.recommendation;
    if (tune.status !== 'recommend' || !rec) return { ok: false, reasons: ['Tune has no change to recommend.'] };
    const now = ctx.now || new Date();

    const manual = manualTuneApplies(cfg);
    if (cfg.autoTuneApplyAfterManual > 0 && manual < cfg.autoTuneApplyAfterManual) reasons.push(`only ${manual} of the ${cfg.autoTuneApplyAfterManual} Tune recommendations you must apply yourself first have been applied`);
    if (ctx.manualChangeSinceTune) reasons.push('the tuning settings were changed by hand since the last Tune, so they are left to you');

    if (cfg.autoTuneGuardMinReadings > 0 && tune.readings < cfg.autoTuneGuardMinReadings) reasons.push(`only ${tune.readings} FC readings could be scored (${cfg.autoTuneGuardMinReadings} needed)`);
    if (cfg.autoTuneGuardMinDays > 0 && ctx.readiness.days < cfg.autoTuneGuardMinDays) reasons.push(`the FC and SWG history spans ${Math.floor(ctx.readiness.days)} days (${cfg.autoTuneGuardMinDays} needed)`);
    if (cfg.autoTuneGuardMaxFcAgeDays > 0) {
        if (!ctx.newestFcAt) reasons.push('the age of the newest FC reading is not known');
        else {
            const age = (now.getTime() - ctx.newestFcAt.getTime()) / 86400000;
            if (age > cfg.autoTuneGuardMaxFcAgeDays) reasons.push(`the newest FC reading is ${age.toFixed(1)} days old (${cfg.autoTuneGuardMaxFcAgeDays} at most)`);
        }
    }
    if (typeof tune.skill === 'number' && tune.skill < cfg.autoTuneGuardMinSkill) reasons.push(`the calculation does not beat "FC unchanged" on this history (${Math.round(tune.skill * 100)}%)`);

    if (cfg.autoTuneGuardMinGainPpm > 0 && !(rec.change <= -cfg.autoTuneGuardMinGainPpm)) reasons.push(`the expected gain (${(-rec.change).toFixed(2)} ppm) is under ${cfg.autoTuneGuardMinGainPpm} ppm`);
    if (!(rec.high < 0)) reasons.push('the range of the expected gain includes zero');

    for (const k of Object.keys(rec.settings)) {
        const v = rec.settings[k], b = AUTO_TUNE_BOUNDS[k];
        if (typeof b === 'undefined') { reasons.push(`${k} is not changed automatically`); continue; }
        if (b === 'boolean') { if (typeof v !== 'boolean') reasons.push(`${k} is not a yes/no value`); continue; }
        if (typeof v !== 'number' || !(v >= b.min && v <= b.max) && !(b.allowZero && v === 0)) reasons.push(`${k} = ${v} is outside the range that is changed automatically (${b.min} to ${b.max}${b.allowZero ? ', or 0' : ''})`);
    }

    if (cfg.autoTuneApplyConfirmRuns > 1 && !autoTuneRecommendationConfirmed(cfg.autoTuneApplyConfirmRuns)) reasons.push(`the same change has not yet been recommended by ${cfg.autoTuneApplyConfirmRuns} auto tunes in a row`);
    return { ok: reasons.length === 0, reasons };
}
