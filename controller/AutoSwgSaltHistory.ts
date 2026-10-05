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

// A local record of the chlorinator's own salt reading, one sample an hour, kept for about 400 days in data/autoSwgSaltHistory.json (next to
// poolConfig.json). Water that is added or removed (rain, a drawdown and refill) dilutes salt and FC alike, and salt is measured continuously
// by the chlorinator, so a drop in it is the best sign the pool has been diluted. It is used for two things and changes no calculation:
//   * recentDrop(): a drop of about 7% or more within the averaging window is noted in the recommendation, because some of the FC lost over
//     that time may be dilution and not consumption (see AutoSwgResult.saltNote);
//   * the record itself, so a cautious dilution credit can be tested against real events later (GET /state/autoSwg/salt).
// The chlorinator reports salt in steps of 50 ppm, so day medians are used, and a single odd reading cannot make a drop.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

const SAMPLE_MS = 55 * 60 * 1000;           // at most one sample an hour
const KEEP_MS = 400 * 86400000;
const SAVE_MS = 30 * 60 * 1000;
const DAY_MS = 86400000;
const MIN_SAMPLES_PER_DAY = 6;              // a day median needs this many samples (so an outage does not leave one reading standing for a day)
export const SALT_DROP_PCT = 0.07;          // a fall of this fraction ...
export const SALT_DROP_MIN_PPM = 150;       // ... and at least this many ppm (the chlorinator reads in steps of 50)
export const SALT_DROP_LOOKBACK_DAYS = 21;  // the averaging window the drop would bias

interface SaltSample { t: number; v: number; }
export interface SaltDrop { fromPpm: number; toPpm: number; pct: number; fromAt: string; toAt: string; addedPpm?: number; }
export interface SaltAddition { ts: number; ppm: number; }     // salt you logged adding, in ppm of this pool
export interface SaltDay { date: string; median: number; min: number; max: number; count: number; }

const median = (xs: number[]): number => { const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

class SaltHistory {
    private samples: SaltSample[] = [];
    private loaded: boolean = false;
    private dirty: boolean = false;
    private lastSave: number = 0;
    constructor() {
        process.on('exit', () => { try { this.save(Date.now()); } catch (err) { /* nothing more can be done at exit */ } });
    }
    private file(): string { return path.join(process.cwd(), 'data', 'autoSwgSaltHistory.json'); }
    private load() {
        this.loaded = true;
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return;
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (Array.isArray(data)) this.samples = data.filter(s => s && typeof s.t === 'number' && typeof s.v === 'number' && isFinite(s.v) && s.v > 0).sort((a, b) => a.t - b.t);
        } catch (err) { logger.warn(`Could not read the salt history: ${err.message}`); }
    }
    private save(now: number) {
        if (!this.dirty) return;
        try {
            const f = this.file();
            fs.mkdirSync(path.dirname(f), { recursive: true });
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.samples), 'utf8');
            fs.renameSync(tmp, f);
            this.dirty = false;
            this.lastSave = now;
        } catch (err) { logger.warn(`Could not save the salt history: ${err.message}`); this.lastSave = now; }
    }
    // Adds the chlorinator's salt reading (ppm; 0 or less means unknown and is ignored). At most one sample an hour is kept.
    public record(ppm: number, now: number = Date.now()) {
        if (typeof ppm !== 'number' || !isFinite(ppm) || !(ppm > 0)) return;
        if (!this.loaded) this.load();
        const last = this.samples[this.samples.length - 1];
        if (typeof last === 'undefined' || now - last.t >= SAMPLE_MS) {
            this.samples.push({ t: now, v: ppm });
            const cutoff = now - KEEP_MS;
            while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();
            this.dirty = true;
        }
        if (this.dirty && now - this.lastSave >= SAVE_MS) this.save(now);
    }
    public count(): number { if (!this.loaded) this.load(); return this.samples.length; }
    // Day by day (days are 24 hours counting back from `now`, newest last) the median, lowest and highest reading, for the last `days` days.
    public daily(days: number = 400, now: number = Date.now()): SaltDay[] {
        if (!this.loaded) this.load();
        const out: SaltDay[] = [];
        for (let i = days - 1; i >= 0; i--) {
            const end = now - i * DAY_MS, start = end - DAY_MS;
            const xs = this.samples.filter(s => s.t > start && s.t <= end).map(s => s.v);
            if (xs.length < MIN_SAMPLES_PER_DAY) continue;
            out.push({ date: new Date(end).toISOString(), median: median(xs), min: Math.min(...xs), max: Math.max(...xs), count: xs.length });
        }
        return out;
    }
    // The biggest fall from an earlier day's median (days are 24 hour blocks counting back from the latest block, none overlapping it) to the
    // median of the last 24 hours, within the lookback, when it is big enough to matter (SALT_DROP_PCT and SALT_DROP_MIN_PPM). Undefined when
    // there is none, when the last 24 hours have too few samples, or when salt has since been brought back up.
    // Salt you logged adding is counted: an earlier day's level is raised by what was added after it (so a rain-diluted pool that was topped up is
    // still seen as lower than it should be), and nothing is reported while salt added in the last 24 hours is still dissolving.
    public recentDrop(now: number = Date.now(), additions: SaltAddition[] = []): SaltDrop | undefined {
        if (!this.loaded) this.load();
        if (additions.some(a => a.ts > now - DAY_MS && a.ts <= now)) return undefined;
        const latestSamples = this.samples.filter(s => s.t > now - DAY_MS && s.t <= now).map(s => s.v);
        if (latestSamples.length < MIN_SAMPLES_PER_DAY) return undefined;
        const latest = median(latestSamples);
        let best: { expected: number; level: number; added: number; at: number } | undefined;
        for (let i = 1; i <= SALT_DROP_LOOKBACK_DAYS; i++) {
            const end = now - i * DAY_MS, start = end - DAY_MS;
            const xs = this.samples.filter(s => s.t > start && s.t <= end).map(s => s.v);
            if (xs.length < MIN_SAMPLES_PER_DAY) continue;
            const level = median(xs);
            const added = additions.filter(a => a.ts > end && a.ts <= now - DAY_MS).reduce((sum, a) => sum + a.ppm, 0);
            const expected = level + added;
            if (typeof best === 'undefined' || (expected - latest) / expected > (best.expected - latest) / best.expected) best = { expected, level, added, at: end };
        }
        if (typeof best === 'undefined') return undefined;
        const drop = best.expected - latest;
        if (drop < SALT_DROP_MIN_PPM || drop / best.expected < SALT_DROP_PCT) return undefined;
        return { fromPpm: best.level, toPpm: latest, pct: drop / best.expected, fromAt: new Date(best.at).toISOString(), toAt: new Date(now).toISOString(), addedPpm: best.added > 0 ? best.added : undefined };
    }
}
export const saltHistory = new SaltHistory();

// The storm response acts on one event for at most stormMaxDays, and a new event cannot start for STORM_LOCKOUT_DAYS after one did (the length of the lookback
// a salt drop stays visible for) unless the drop has become STORM_DEEPER_PCT deeper. Without that, a drop that stays visible for three weeks could keep
// starting new events, each raising the SWG again. `startedAt` and `startPct` are what was recorded when the last event started.
export const STORM_LOCKOUT_DAYS = 21;
export const STORM_DEEPER_PCT = 0.05;
export function stormEventStatus(startedAt: string | undefined, startPct: number | undefined, dropPct: number, maxDays: number, now: number = Date.now()): { apply: boolean; newEvent: boolean } {
    const started = startedAt ? new Date(startedAt).getTime() : NaN;
    if (isNaN(started)) return { apply: true, newEvent: true };
    const since = now - started;
    const deeper = typeof startPct === 'number' && dropPct >= startPct + STORM_DEEPER_PCT;
    if (since > STORM_LOCKOUT_DAYS * DAY_MS || deeper) return { apply: true, newEvent: true };
    return { apply: since <= maxDays * DAY_MS, newEvent: false };
}
