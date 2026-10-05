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

// A local record of what the chlorinator actually did, one line an hour, kept for 18 months (the length of the PoolMath archive) in
// data/autoSwgOutputLog.jsonl next to poolConfig.json. It is written at all times, in every mode, whenever a chlorinator is configured:
// the nights and the hours outside the run window are the baseline, and an output where there should be none (or none where there should
// be some) is the evidence. The calculation assumes the SWG made what the % and the run window say; this is the record of whether it did.
// It changes no calculation. It is used to judge a trip afterwards (see awaySummary) and to test, later, whether the calculation should use
// the actual output.
//
// Each line is one hour (`t`, the start of the hour in UTC) built from the samples taken in it (every ten minutes, see sampleAutoSwgSalt):
//   n      samples in the hour             on     samples with an output above 0     out  mean output (%)     max  highest output (%)
//   set    the SWG % that was set (last sample)    tgt  the chlorinator's target output (last sample)
//   st     the statuses seen (0 = OK; see the chlorinatorStatus value map), only when any was not 0
//   salt   the chlorinator's salt reading (ppm, last sample)    age  the longest time since the chlorinator last reported (seconds), a
//   stale output looks like production when njsPC has lost the chlorinator
// Two lines can have the same `t` (njsPC restarted within the hour); add them, weighting by n. Appended as lines, never rewritten, except when
// the oldest hour passes the 18 months, which rewrites the file once.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

const HOUR_MS = 3600000;
const KEEP_MONTHS = 18;
const PRUNE_EVERY_MS = 24 * HOUR_MS;

export interface AutoSwgOutputSample {
    output: number; set: number; target: number; status: number; salt: number;
    commAgeSec?: number;    // seconds since the chlorinator last reported, when known
}
export interface AutoSwgOutputHour {
    t: string; n: number; on: number; out: number; max: number; set: number; tgt: number; st?: number[]; salt: number; age?: number;
}
export interface AutoSwgOutputSummary {
    hours: number;                  // hours with samples
    producingHours: number;         // the hours (fractions of hours) with an output above 0
    meanOutputWhenOn?: number;      // mean output (%) over the samples that were producing
    maxOutput: number;
    hoursWithStatus: number;        // hours in which the chlorinator reported anything but OK
    statuses: number[];             // the distinct statuses seen
    hoursStale: number;             // hours in which the chlorinator went more than 15 minutes without reporting
    setHistogram: { [pct: string]: number };   // hours at each set %
}

const STALE_SEC = 15 * 60;

interface Bucket { start: number; n: number; on: number; sum: number; max: number; set: number; tgt: number; st: number[]; salt: number; age: number; }

class OutputLog {
    private bucket: Bucket | undefined;
    private lastPrune = 0;
    constructor() {
        process.on('exit', () => { try { this.flush(); } catch (err) { /* nothing more can be done at exit */ } });
    }
    private file(): string { return path.join(process.cwd(), 'data', 'autoSwgOutputLog.jsonl'); }
    // Adds one sample; the hour is written when the next hour's first sample arrives (or at exit).
    public record(s: AutoSwgOutputSample, now: number = Date.now()) {
        if (!s || typeof s.output !== 'number' || !isFinite(s.output)) return;
        const start = Math.floor(now / HOUR_MS) * HOUR_MS;
        if (this.bucket && this.bucket.start !== start) this.flush();
        if (!this.bucket) this.bucket = { start: start, n: 0, on: 0, sum: 0, max: 0, set: 0, tgt: 0, st: [], salt: 0, age: 0 };
        const b = this.bucket;
        b.n++;
        if (s.output > 0) b.on++;
        b.sum += s.output;
        if (s.output > b.max) b.max = s.output;
        if (typeof s.set === 'number') b.set = s.set;
        if (typeof s.target === 'number') b.tgt = s.target;
        if (typeof s.status === 'number' && s.status !== 0 && b.st.indexOf(s.status) < 0) b.st.push(s.status);
        if (typeof s.salt === 'number' && s.salt > 0) b.salt = s.salt;
        if (typeof s.commAgeSec === 'number' && s.commAgeSec > b.age) b.age = s.commAgeSec;
        if (now - this.lastPrune > PRUNE_EVERY_MS) this.prune(now);
    }
    // Writes the hour being built (a partial hour at exit has a smaller n).
    public flush() {
        const b = this.bucket;
        this.bucket = undefined;
        if (!b || b.n === 0) return;
        const line: AutoSwgOutputHour = { t: new Date(b.start).toISOString(), n: b.n, on: b.on, out: Math.round((b.sum / b.n) * 10) / 10, max: b.max, set: b.set, tgt: b.tgt, salt: b.salt };
        if (b.st.length) line.st = b.st;
        if (b.age > 0) line.age = b.age;
        try {
            const f = this.file();
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.appendFileSync(f, JSON.stringify(line) + '\n', 'utf8');
        } catch (err) { logger.warn(`AutoSwg: could not write the chlorinator output log: ${err.message}`); }
    }
    // The hours from the last `days` days, oldest first (the hour being built is not included until it is written).
    public read(days: number = 548, now: number = Date.now()): AutoSwgOutputHour[] {
        return this.readAll().filter(h => new Date(h.t).getTime() >= now - days * 86400000);
    }
    private readAll(): AutoSwgOutputHour[] {
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return [];
            const out: AutoSwgOutputHour[] = [];
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    const h = JSON.parse(line);
                    if (h && typeof h.t === 'string' && typeof h.n === 'number' && !isNaN(new Date(h.t).getTime())) out.push(h);
                } catch (err) { /* a torn last line after a power loss is skipped */ }
            }
            return out;
        } catch (err) { logger.warn(`AutoSwg: could not read the chlorinator output log: ${err.message}`); return []; }
    }
    // Drops the hours older than 18 months; rewrites the file only when there are any.
    private prune(now: number) {
        this.lastPrune = now;
        try {
            const all = this.readAll();
            if (!all.length) return;
            const cutoff = new Date(now);
            cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);
            const kept = all.filter(h => new Date(h.t).getTime() >= cutoff.getTime());
            if (kept.length === all.length) return;
            const f = this.file();
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, kept.map(h => JSON.stringify(h)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
            fs.renameSync(tmp, f);
        } catch (err) { logger.warn(`AutoSwg: could not trim the chlorinator output log: ${err.message}`); }
    }
    // What the chlorinator actually did between two times (for the summary written when Away protection ends).
    public summary(fromMs: number, toMs: number): AutoSwgOutputSummary | undefined {
        if (this.bucket) this.flush();
        const hours = this.readAll().filter(h => { const t = new Date(h.t).getTime(); return t >= fromMs - HOUR_MS + 1 && t <= toMs; });
        if (!hours.length) return undefined;
        let producing = 0, onSamples = 0, onSum = 0, max = 0, withStatus = 0, stale = 0;
        const statuses: number[] = [], hist: { [pct: string]: number } = {};
        for (const h of hours) {
            if (h.n > 0) producing += h.on / h.n;
            // the mean over the samples that were producing: out is the mean over all n, so the producing mean is out * n / on
            if (h.on > 0) { onSamples += h.on; onSum += h.out * h.n; }
            if (h.max > max) max = h.max;
            if (h.st && h.st.length) { withStatus++; for (const s of h.st) if (statuses.indexOf(s) < 0) statuses.push(s); }
            if (typeof h.age === 'number' && h.age > STALE_SEC) stale++;
            hist[String(h.set)] = (hist[String(h.set)] || 0) + 1;
        }
        return {
            hours: hours.length,
            producingHours: Math.round(producing * 10) / 10,
            meanOutputWhenOn: onSamples > 0 ? Math.round((onSum / onSamples) * 10) / 10 : undefined,
            maxOutput: max,
            hoursWithStatus: withStatus,
            statuses: statuses,
            hoursStale: stale,
            setHistogram: hist,
        };
    }
}

export const outputLog = new OutputLog();
