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

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { logger } from '../logger/Logger';
import { msSinceLastShareRequest, noteShareRequest } from './AutoSwgService';

export const AUTO_SWG_ARCHIVE_MONTHS = 18;

// How many log entries to ask for, largest first; a rejected size falls back to the next.
const RECENT_LOGS_SIZES = [5000, 1000, 250];
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

// One background sync: asks PoolMath's JSON interface for as many recent logs as it will give,
// merges them into the archive, and writes it. Throws on any problem (rate limiting that
// outlasts the retries, an HTTP error, an unexpected shape) leaving the archive untouched.
export async function syncPoolMathArchive(shareCode: string, poolName?: string): Promise<PoolMathSyncResult> {
    if (!shareCode) throw new Error('No PoolMath share code is configured.');
    let data: any;
    let requested = 0;
    for (let s = 0; s < RECENT_LOGS_SIZES.length && !data; s++) {
        const size = RECENT_LOGS_SIZES[s];
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
            if ((res.status === 400 || res.status === 413 || res.status === 422) && s < RECENT_LOGS_SIZES.length - 1) break; // too many logs asked for -- try a smaller size
            if (res.status < 200 || res.status >= 300) throw new Error(`PoolMath returned HTTP ${res.status} for the JSON history.`);
            try { data = JSON.parse(res.body); }
            catch (err) { throw new Error(`PoolMath's JSON response could not be parsed: ${err.message}`); }
            requested = size;
            break;
        }
    }
    if (!data) throw new Error('PoolMath did not accept any recentLogs size for the JSON history.');

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
