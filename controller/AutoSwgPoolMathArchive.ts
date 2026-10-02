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

// Local archive of up to AUTO_SWG_ARCHIVE_MONTHS of PoolMath log history, pulled in the
// background from the share link's JSON interface (https://api.poolmathapp.com/share/<code>.json
// ?recentLogs=N). The calculation itself still reads the share page's HTML for recent entries
// (see AutoSwgService); this archive exists so longer-range features, such as a look back at
// last year's consumption, have the data they need even after PoolMath's own recent window has
// moved on. Entries are accumulated across syncs (an entry that has dropped out of what
// PoolMath returns stays archived until it ages past the retention period) and de-duplicated
// by PoolMath's log id; entries PoolMath reports as deleted are removed.
//
// Stored in data/autoSwgPoolMathArchive.json next to poolConfig.json. PoolMath's share endpoint
// is rate limited (about one request per minute), so a sync makes one request, waits out any
// 429 before retrying, and shares a clock with the HTML fetch (see noteShareRequest).
//
// The sync is a one-time pull per share code: it runs only when the archive isn't already for
// the configured share code and pool (the first time, or after either changes), not on a
// schedule -- see isPoolMathArchiveCurrent.

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { msSinceLastShareRequest, noteShareRequest } from './AutoSwgService';
import type { PageReadings } from './AutoSwgService';

export const AUTO_SWG_ARCHIVE_MONTHS = 18;

// How many log entries to ask for, smallest first: it stops at the first size that reaches back far
// enough (see syncPoolMathArchive), so a small account is one small request.
const RECENT_LOGS_SIZES = [500, 2000, 5000];
// PoolMath allows roughly one share request per minute; stay comfortably outside that.
const MIN_GAP_MS = 90 * 1000;
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 70 * 1000;
const MAX_WAIT_MS = 5 * 60 * 1000;

// One archived PoolMath log entry. Numeric fields are kept as PoolMath reports them (units
// included) rather than interpreted, so nothing has to be re-pulled to use them later.
export interface PoolMathArchiveEntry {
    id: string;                 // PoolMath's log id
    type: string;               // 'testlog' | 'chemlog' | any other kind PoolMath reports
    ts: string;                 // ISO logTimestamp
    // testlog
    fc?: number; cc?: number; cya?: number; ph?: number; ta?: number; ch?: number; salt?: number; waterTemp?: number; waterTempUnits?: number;
    // chemlog, including SWG entries (which chemical id / unit PoolMath uses for them is
    // deliberately not assumed here)
    chemical?: number; runTime?: number; percent?: number; unit?: number; amount?: number; normalizedAmount?: number;
    // Weather PoolMath attached to the entry -- sunlight drives most chlorine loss
    uvIndex?: number; weatherTemp?: number; cloudCover?: number;
}

export interface PoolMathArchive {
    shareCode?: string;         // what the entries were pulled for; a change discards them
    poolName?: string;
    syncedAt?: string;          // ISO time of the last successful sync
    entries: PoolMathArchiveEntry[];
}

export interface PoolMathSyncResult {
    fetched: number;            // entries PoolMath returned (not deleted, within retention)
    added: number;              // new to the archive
    total: number;              // archive size afterwards
    oldest?: string;            // ISO timestamp of the oldest archived entry
    requested: number;          // the recentLogs size that was accepted
}

function archivePath(): string { return path.join(process.cwd(), 'data', 'autoSwgPoolMathArchive.json'); }

export function readPoolMathArchive(): PoolMathArchive {
    try {
        const parsed = JSON.parse(fs.readFileSync(archivePath(), 'utf8'));
        if (parsed && Array.isArray(parsed.entries)) return parsed;
    }
    catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`AutoSwg: could not read ${archivePath()}: ${err.message}`);
    }
    return { entries: [] };
}

function writePoolMathArchive(archive: PoolMathArchive) {
    const file = archivePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(archive), 'utf8');
    fs.renameSync(tmp, file);
}

function retentionCutoff(now: Date): number {
    const cutoff = new Date(now.getTime());
    cutoff.setMonth(cutoff.getMonth() - AUTO_SWG_ARCHIVE_MONTHS);
    return cutoff.getTime();
}

// True when the archive was pulled for this share code and pool, so no sync is needed.
export function isPoolMathArchiveCurrent(shareCode: string, poolName?: string): boolean {
    const a = readPoolMathArchive();
    return !!a.syncedAt && a.shareCode === shareCode && (a.poolName || '') === (poolName || '');
}

// PoolMath entries can be edited or deleted, so the share page -- the freshest read there is -- wins
// for the period it covers. Given a read of the page, the archived test readings from the page's
// oldest entry onward are made to match it: values are updated (an edit), readings the page
// no longer lists are removed (a deletion), and readings the archive hasn't got yet are added.
// Older archive entries aren't touched (only recent entries are likely to be edited), and the other
// numbers on a test log (pH, salt, water temp, weather, ...) are kept. Does nothing unless the
// archive has already been pulled for this share code and pool -- the page never creates it.
export function refreshPoolMathArchiveFromPage(shareCode: string, poolName: string | undefined, page: PageReadings): { updated: number; added: number; removed: number } | undefined {
    if (!page.coverageStart) return undefined;
    const archive = readPoolMathArchive();
    if (!archive.syncedAt || archive.shareCode !== shareCode || (archive.poolName || '') !== (poolName || '')) return undefined;
    const MATCH_MS = 2 * 60 * 1000; // the page and the JSON can differ slightly in a log's timestamp
    const start = page.coverageStart.getTime();

    const groups = new Map<number, { ts: Date; fc?: number; cc?: number; cya?: number }>();
    const put = (list: { ts: Date; value: number }[], key: 'fc' | 'cc' | 'cya') => {
        for (const r of list) {
            const k = r.ts.getTime();
            const g = groups.get(k) || { ts: r.ts };
            (g as any)[key] = r.value;
            groups.set(k, g);
        }
    };
    put(page.fc, 'fc'); put(page.cc, 'cc'); put(page.cya, 'cya');

    // Archived test logs the page can speak for: in its span, and carrying FC/CC/CYA (a log
    // with none of those, e.g. a pH-only test, doesn't appear in what the page parses).
    const hasPageFields = (e: PoolMathArchiveEntry) => e.type === 'testlog' && (typeof e.fc === 'number' || typeof e.cc === 'number' || typeof e.cya === 'number');
    const candidates = archive.entries.filter(e => hasPageFields(e) && new Date(e.ts).getTime() >= start - MATCH_MS);
    const claimed = new Set<PoolMathArchiveEntry>();
    let updated = 0, added = 0, removed = 0;
    const newEntries: PoolMathArchiveEntry[] = [];

    for (const g of Array.from(groups.values()).sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
        let best: PoolMathArchiveEntry | undefined;
        let bestGap = Infinity;
        for (const c of candidates) {
            if (claimed.has(c)) continue;
            const gap = Math.abs(new Date(c.ts).getTime() - g.ts.getTime());
            if (gap <= MATCH_MS && gap < bestGap) { best = c; bestGap = gap; }
        }
        if (best) {
            claimed.add(best);
            let changed = false;
            for (const k of ['fc', 'cc', 'cya'] as const) {
                const v = g[k];
                if (best[k] !== v) { changed = true; if (typeof v === 'number') best[k] = v; else delete best[k]; }
            }
            if (changed) updated++;
        }
        else {
            const e: PoolMathArchiveEntry = { id: `page:${g.ts.toISOString()}`, type: 'testlog', ts: g.ts.toISOString() };
            for (const k of ['fc', 'cc', 'cya'] as const) { const v = g[k]; if (typeof v === 'number') e[k] = v; }
            newEntries.push(e);
            added++;
        }
    }
    // The same for SWG runs: update edited ones, add missing ones, drop ones the page no longer lists.
    const swgCandidates = archive.entries.filter(e => isSwgEntry(e) && new Date(e.ts).getTime() >= start - MATCH_MS);
    const swgClaimed = new Set<PoolMathArchiveEntry>();
    for (const g of [...(page.swg || [])].sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
        let best: PoolMathArchiveEntry | undefined;
        let bestGap = Infinity;
        for (const c of swgCandidates) {
            if (swgClaimed.has(c)) continue;
            const gap = Math.abs(new Date(c.ts).getTime() - g.ts.getTime());
            if (gap <= MATCH_MS && gap < bestGap) { best = c; bestGap = gap; }
        }
        if (best) {
            swgClaimed.add(best);
            if (best.amount !== g.ppmPerDay || best.runTime !== g.hrs || best.percent !== g.pct) {
                // normalizedAmount equals amount for the unit PoolMath uses for SWG entries; keep it in step
                if (best.normalizedAmount === best.amount) best.normalizedAmount = g.ppmPerDay;
                best.amount = g.ppmPerDay; best.runTime = g.hrs; best.percent = g.pct;
                updated++;
            }
        }
        else {
            newEntries.push({ id: `page:swg:${g.ts.toISOString()}`, type: 'chemlog', ts: g.ts.toISOString(), chemical: POOLMATH_SWG_CHEMICAL, runTime: g.hrs, percent: g.pct, amount: g.ppmPerDay, normalizedAmount: g.ppmPerDay });
            added++;
        }
    }

    // Archived readings in the page's span that the page no longer lists were deleted (or had
    // their FC/CC/CYA cleared) in PoolMath: drop the entry unless it has other test values.
    const drop = new Set<PoolMathArchiveEntry>();
    for (const c of swgCandidates) {
        if (swgClaimed.has(c) || new Date(c.ts).getTime() < start) continue;
        drop.add(c);
        removed++;
    }
    for (const c of candidates) {
        if (claimed.has(c) || new Date(c.ts).getTime() < start) continue;
        delete c.fc; delete c.cc; delete c.cya;
        const keepsOther = ['ph', 'ta', 'ch', 'salt', 'waterTemp'].some(k => typeof (c as any)[k] === 'number');
        if (!keepsOther) drop.add(c);
        removed++;
    }
    if (!updated && !added && !removed) return { updated, added, removed };
    const entries = [...archive.entries.filter(e => !drop.has(e)), ...newEntries].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    writePoolMathArchive({ ...archive, entries });
    return { updated, added, removed };
}

// Summary of what's archived (for the status shown on the dashboard).
export function poolMathArchiveSummary(): { syncedAt?: string; count: number; oldest?: string } {
    const a = readPoolMathArchive();
    return { syncedAt: a.syncedAt, count: a.entries.length, oldest: a.entries.length ? a.entries[0].ts : undefined };
}

// PoolMath logs an SWG run as a chemical entry: chemical id 27, with `runTime` (hours),
// `percent` (SWG %) and `amount` (the ppm FC it was credited with) -- the same three numbers
// the share page shows as "X ppm FC ... SWG Y hrs @ Z%". Identified by that id or, failing it,
// by carrying both a run time and a percent.
const POOLMATH_SWG_CHEMICAL = 27;
function isSwgEntry(e: PoolMathArchiveEntry): boolean {
    return e.type === 'chemlog' && (e.chemical === POOLMATH_SWG_CHEMICAL || (typeof e.runTime === 'number' && typeof e.percent === 'number'))
        && typeof e.amount === 'number' && typeof e.runTime === 'number' && typeof e.percent === 'number';
}

// The archived SWG runs, oldest first, shaped like a share-page SWG entry.
export function archivedSwgEvents(): { ts: Date; ppmPerDay: number; hrs: number; pct: number }[] {
    return readPoolMathArchive().entries
        .filter(isSwgEntry)
        .map(e => ({ ts: new Date(e.ts), ppmPerDay: e.amount, hrs: e.runTime, pct: e.percent }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

// The archived FC test readings, oldest first, for merging into the combined history view.
export function archivedFcReadings(): { ts: Date; value: number }[] {
    return readPoolMathArchive().entries
        .filter(e => e.type === 'testlog' && typeof e.fc === 'number')
        .map(e => ({ ts: new Date(e.ts), value: e.fc }))
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function httpGet(url: string, redirects = 3): Promise<{ status: number; headers: any; body: string }> {
    return new Promise((resolve, reject) => {
        try {
            const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (nodejs-poolController AutoSwg)' }, timeout: 60000 }, res => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    httpGet(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject);
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', d => { body += d; });
                res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
            });
            req.on('timeout', () => req.destroy(new Error('PoolMath request timed out')));
            req.on('error', reject);
            req.end();
        } catch (err) { reject(err); }
    });
}

// The share link as a JSON URL with the requested number of recent logs.
function jsonUrl(shareCodeOrUrl: string, recentLogs: number): string {
    let base = shareCodeOrUrl.startsWith('http') ? shareCodeOrUrl : `https://api.poolmathapp.com/share/${shareCodeOrUrl}`;
    base = base.split('?')[0];
    if (!base.endsWith('.json')) base += '.json';
    return `${base}?recentLogs=${recentLogs}`;
}

function num(v: any): number | undefined { return typeof v === 'number' && isFinite(v) ? v : undefined; }

function pickPool(data: any, poolName?: string): any {
    const pools: any[] = Array.isArray(data && data.pools) ? data.pools : [];
    if (pools.length === 0) throw new Error('The PoolMath JSON has no pools.');
    if (!poolName) return pools[0];
    const want = poolName.trim().toLowerCase();
    const name = (p: any) => String(p && p.pool && p.pool.name || '').trim().toLowerCase();
    const match = pools.find(p => name(p) === want) || pools.find(p => name(p).includes(want));
    if (!match) throw new Error(`Pool '${poolName}' was not found in the PoolMath JSON.`);
    return match;
}

function toEntry(log: any): PoolMathArchiveEntry | undefined {
    if (!log || typeof log.id !== 'string' || typeof log.type !== 'string') return undefined;
    const t = new Date(log.logTimestamp).getTime();
    if (isNaN(t)) return undefined;
    const e: PoolMathArchiveEntry = { id: log.id, type: log.type, ts: new Date(t).toISOString() };
    const weather = log.weather || {};
    const fields: [keyof PoolMathArchiveEntry, any][] = [
        ['fc', log.fc], ['cc', log.cc], ['cya', log.cya], ['ph', log.ph], ['ta', log.ta], ['ch', log.ch], ['salt', log.salt],
        ['waterTemp', log.waterTemp], ['waterTempUnits', log.waterTempUnits],
        ['chemical', log.chemical], ['runTime', log.runTime], ['percent', log.percent], ['unit', log.unit],
        ['amount', log.amount], ['normalizedAmount', log.normalizedAmount],
        ['uvIndex', weather.uvIndex], ['weatherTemp', weather.temp], ['cloudCover', weather.cloudCover],
    ];
    for (const [k, v] of fields) { const n = num(v); if (typeof n !== 'undefined') (e as any)[k] = n; }
    return e;
}

// One request for the `size` most recent logs, waiting out any rate limiting first. Resolves to
// the parsed JSON, or to `undefined` when PoolMath rejects that size (HTTP 400/413/422); throws
// for anything else (rate limiting that outlasts the retries, another HTTP error, bad JSON).
async function fetchRecentLogs(shareCode: string, size: number): Promise<any | undefined> {
    for (let attempt = 0; ; attempt++) {
        // Leave a gap since ANY recent request to the share endpoint (the HTML fetch counts).
        const gap = MIN_GAP_MS - msSinceLastShareRequest();
        if (gap > 0) await sleep(gap);
        noteShareRequest();
        const res = await httpGet(jsonUrl(shareCode, size));
        if (res.status === 429) {
            if (attempt >= RATE_LIMIT_RETRIES) throw new Error('PoolMath is rate limiting the JSON request (HTTP 429).');
            const ra = parseInt(String(res.headers['retry-after'] || ''), 10);
            const wait = Math.min(MAX_WAIT_MS, isNaN(ra) ? DEFAULT_RETRY_AFTER_MS : Math.max(ra * 1000, 1000) + 5000);
            logger.info(`AutoSwg: PoolMath rate limited the history sync; retrying in ${Math.round(wait / 1000)}s.`);
            await sleep(wait);
            continue;
        }
        if (res.status === 400 || res.status === 413 || res.status === 422) return undefined;
        if (res.status < 200 || res.status >= 300) throw new Error(`PoolMath returned HTTP ${res.status} for the JSON history.`);
        try { return JSON.parse(res.body); }
        catch (err) { throw new Error(`PoolMath's JSON response could not be parsed: ${err.message}`); }
    }
}

// One background sync: asks PoolMath's JSON interface for recent logs until they reach back
// AUTO_SWG_ARCHIVE_MONTHS (recentLogs is a count, not a date range, so it asks for a growing
// number and stops as soon as the oldest entry returned is past the cutoff, or PoolMath has
// returned everything it has), merges them into the archive, and writes it. Throws if nothing
// could be fetched, leaving the archive untouched; if a larger request fails after a smaller one
// succeeded, the smaller result is used.
export async function syncPoolMathArchive(shareCode: string, poolName?: string): Promise<PoolMathSyncResult> {
    if (!shareCode) throw new Error('No PoolMath share code is configured.');
    const cutoff = retentionCutoff(new Date());
    let data: any;
    let requested = 0;
    let lastError: Error | undefined;
    for (const size of RECENT_LOGS_SIZES) {
        let got: any;
        try { got = await fetchRecentLogs(shareCode, size); }
        catch (err) { lastError = err; break; }
        if (typeof got === 'undefined') break; // that size isn't accepted -- keep what we have
        data = got;
        requested = size;
        const logs: any[] = Array.isArray(pickPool(got, poolName).recentLogs) ? pickPool(got, poolName).recentLogs : [];
        const oldest = logs.reduce((m, l) => { const t = new Date(l && l.logTimestamp).getTime(); return isNaN(t) ? m : Math.min(m, t); }, Infinity);
        if (logs.length < size || oldest <= cutoff) break; // everything PoolMath has, or far enough back
    }
    if (!data) throw lastError || new Error('PoolMath did not accept any recentLogs size for the JSON history.');
    if (lastError) logger.warn(`AutoSwg: PoolMath history sync stopped early (${lastError.message}); archiving what was fetched.`);

    const pool = pickPool(data, poolName);
    const logs: any[] = Array.isArray(pool.recentLogs) ? pool.recentLogs : [];
    const now = new Date();
    const cutoff = retentionCutoff(now);
    const deletedIds = new Set<string>();
    const fetched: PoolMathArchiveEntry[] = [];
    for (const log of logs) {
        if (log && log.deleted === true) { if (typeof log.id === 'string') deletedIds.add(log.id); continue; }
        const e = toEntry(log);
        if (e && new Date(e.ts).getTime() >= cutoff) fetched.push(e);
    }

    let archive = readPoolMathArchive();
    // A different share code or pool means the archived entries aren't this pool's.
    if (archive.shareCode !== shareCode || (archive.poolName || '') !== (poolName || '')) archive = { entries: [] };
    const byId = new Map<string, PoolMathArchiveEntry>();
    for (const e of archive.entries) if (!deletedIds.has(e.id) && new Date(e.ts).getTime() >= cutoff) byId.set(e.id, e);
    const before = byId.size;
    for (const e of fetched) byId.set(e.id, e);
    const entries = Array.from(byId.values()).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    writePoolMathArchive({ shareCode: shareCode, poolName: poolName || '', syncedAt: now.toISOString(), entries: entries });
    return {
        fetched: fetched.length,
        added: Math.max(0, byId.size - before),
        total: entries.length,
        oldest: entries.length ? entries[0].ts : undefined,
        requested: requested,
    };
}
