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

// AutoSwgService -- reads a PoolMath (troublefreepool.com) shared pool page and
// computes a recommended salt-water-chlorinator (SWG) duty-cycle percentage.
//
// This is a TypeScript port of swg_percent_calcv5.py (see the "Automated SWG
// Settings" project for the reference implementation and full method writeup).
// It intentionally has no third-party dependencies (no HTML-parsing library,
// no date/timezone library) to match this codebase's existing minimal-dependency
// style (see config/VersionCheck.ts for the same raw-https-request pattern).
//
// METHOD (see swg_percent_calcv5.py's module docstring for the full derivation):
// Each SWG log entry's "X ppm FC" figure is PoolMath's own estimate of how much
// FC the cell would add over a full 24-hour day at that runtime/%. That rate is
// treated as a step function of time, in effect from that entry's timestamp
// until the next SWG entry's timestamp. For each pair of consecutive FC test
// readings (t1,fc1)->(t2,fc2): generated_ppm = integral of the SWG rate over
// [t1,t2]; consumed_ppm = generated_ppm - (fc2-fc1); consumed_ppm_per_day =
// consumed_ppm / (t2-t1 in days). The running N-day figure is time-weighted
// over the last N days, ending at calculation time (clipping any interval that
// only partially overlaps) and divided by the days actually spanned by
// consecutive FC readings. If that window holds fewer than 3 FC readings it is
// extended back to the third-most-recent reading, and the summary line says so.
//
// SWG log entries come from two places: PoolMath's log and the local SWG % change
// log (applied recommendations and manual setpoint changes; see AutoSwgHistory.ts).
// The local log takes precedence: a PoolMath SWG entry within an hour of a local
// entry is ignored, while PoolMath entries with no local counterpart are used.

import * as https from 'https';
import { logger } from '../logger/Logger';

export interface AutoSwgParams {
    shareCode: string;
    poolName?: string;
    gallons: number;
    swgLbsPerDay: number;
    swgStartTime: string; // e.g. '07:00' or '7am'
    swgStopTime: string;  // e.g. '19:00' or '7pm'
    timezone: string;     // IANA zone name, e.g. 'America/New_York'
    windowDays: number;   // running-average window, e.g. 14
    targetFc: number;
    targetDays: number;
}

export interface AutoSwgResult {
    currentPct: number;              // most recent logged SWG %, for comparison
    recommendedPct: number;          // recommended duty cycle to match ongoing demand
    recommendedPctForTarget: number; // recommended duty cycle to hit targetFc in targetDays
    avgConsumptionPpmPerDay: number;
    avgConsumptionSummary: string;   // human-readable form of avgConsumptionPpmPerDay, e.g. for a dashboard tile
    avgWindowStart: string;          // ISO start of the running-average window actually used (after any extension)
    avgWindowEnd: string;            // ISO end of that window (calculation time)
    avgWindowExtended: boolean;      // true if the window was extended back to include MIN_FC_READINGS_IN_WINDOW readings
    projectedCurrentFc: number;
    mostRecentFc?: { value: number; ts: string };
    mostRecentCya?: { value: number; ts: string };
    mostRecentSwg?: { ppmPerDay: number; hrs: number; pct: number; ts: string; source: SwgSource };
    inputs: AutoSwgParams;           // the parameters this result was computed from
    swgCapacityPpmPerDay: number;    // ppm/day at 100% duty cycle over swgRunHours
    swgRunHours: number;             // length of the daily run window used
    localSwgEntriesUsed: number;     // entries from the local SWG % change log that fed the calculation
    poolMathSwgEntriesReplaced: number; // PoolMath SWG entries ignored because a local entry was within an hour
    rationale: string[];
}

// A past SWG % change (an applied recommendation or a manual change), as recorded
// in the local history log (see AutoSwgHistory.ts). Shaped like a PoolMath SWG log
// entry so the two can be merged into a single step function of SWG rate over time.
export interface LocalSwgEntry { ts: string; ppmPerDay: number; hrs: number; pct: number; }

type SwgSource = 'poolmath' | 'local';

interface FcEvent { ts: Date; value: number; }
interface SwgEvent { ts: Date; ppmPerDay: number; hrs: number; pct: number; source: SwgSource; }

// A PoolMath SWG entry within this long of a local entry is treated as the same
// event, and the local entry wins.
const LOCAL_SWG_MATCH_MS = 60 * 60 * 1000;

// The running-average window is extended back in time, if needed, until it holds
// at least this many FC readings.
const MIN_FC_READINGS_IN_WINDOW = 3;

const SWG_PATTERN = /([\d.]+)\s*ppm\s*FC[\s\S]*?SWG\s*([\d.]+)\s*hrs?\s*@\s*([\d.]+)\s*%/i;

// ---------------------------------------------------------------------------
// Minimal, dependency-free HTML helpers
// ---------------------------------------------------------------------------

// Finds every *top-level* <div ...>...</div> block within `html` whose class
// attribute passes `classTest`. "Top level" means not nested inside another
// matched block -- e.g. two sibling logCard divs are both returned, but a div
// nested inside one of them is not treated as a separate top-level match (it's
// available in that match's `inner` for further, narrower extraction).
function extractDivBlocks(html: string, classTest: (classAttr: string) => boolean):
    { openTag: string; inner: string; start: number; end: number }[] {
    const results: { openTag: string; inner: string; start: number; end: number }[] = [];
    const openTagRe = /<div\b([^>]*)>/gi;
    const tokenRe = /<div\b[^>]*>|<\/div\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = openTagRe.exec(html))) {
        const attrs = m[1] || '';
        const classMatch = /class\s*=\s*"([^"]*)"/i.exec(attrs) || /class\s*=\s*'([^']*)'/i.exec(attrs);
        const classAttr = classMatch ? classMatch[1] : '';
        if (!classTest(classAttr)) continue;
        const start = m.index;
        const afterOpenTag = openTagRe.lastIndex;
        tokenRe.lastIndex = afterOpenTag;
        let depth = 1;
        let tok: RegExpExecArray | null;
        let closeIdx = -1;
        let closeLen = 0;
        while ((tok = tokenRe.exec(html))) {
            if (tok[0][1] === '/') { // closing tag
                depth--;
                if (depth === 0) { closeIdx = tok.index; closeLen = tok[0].length; break; }
            } else {
                depth++;
            }
        }
        if (closeIdx === -1) { openTagRe.lastIndex = afterOpenTag; continue; } // malformed, skip just this one
        const inner = html.slice(afterOpenTag, closeIdx);
        results.push({ openTag: m[0], inner, start, end: closeIdx + closeLen });
        openTagRe.lastIndex = closeIdx + closeLen; // skip past this whole block
    }
    return results;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&bull;/gi, '•');
}

// Rough equivalent of BeautifulSoup's card.get_text(" ", strip=True): strip tags,
// replacing each with a space so adjacent text nodes don't run together, then
// collapse whitespace.
function getText(html: string): string {
    return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Restrict the document to the section belonging to `poolHeading` (an <h1-6>
// whose text matches, case-insensitively), up to the next heading. Falls back
// to the whole document if the heading isn't found or isn't given.
function restrictToHeadingSection(html: string, poolHeading?: string): string {
    if (!poolHeading) return html;
    const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
    let m: RegExpExecArray | null;
    let sectionStart = -1;
    while ((m = headingRe.exec(html))) {
        const text = getText(m[2]);
        if (text.toLowerCase() === poolHeading.toLowerCase()) {
            sectionStart = headingRe.lastIndex;
            break;
        }
    }
    if (sectionStart === -1) {
        logger.warn(`AutoSwg: heading '${poolHeading}' not found on PoolMath page; scanning entire page instead.`);
        return html;
    }
    // Find the next heading after sectionStart to bound the section.
    const nextHeadingRe = /<h[1-6]\b[^>]*>/i;
    const rest = html.slice(sectionStart);
    const next = nextHeadingRe.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
}

function parseTimestamp(dtStr: string): Date | null {
    let s = dtStr.trim();
    // PoolMath emits up to 7 fractional-second digits; JS Date only reliably
    // handles milliseconds (3 digits), so trim any extras.
    s = s.replace(/(\.\d{3})\d+/, '$1');
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function cardTimestamp(cardInner: string): Date | null {
    const m = /<time\b[^>]*\bclass\s*=\s*"[^"]*\btimereal\b[^"]*"[^>]*\bdatetime\s*=\s*"([^"]*)"/i.exec(cardInner)
        || /<time\b[^>]*\bdatetime\s*=\s*"([^"]*)"/i.exec(cardInner);
    return m ? parseTimestamp(m[1]) : null;
}

interface ParsedCards {
    fcEvents: FcEvent[];
    swgEvents: SwgEvent[];
    cyaEvents: FcEvent[];
    ccEvents: FcEvent[];
}

function parseCards(html: string, poolHeading?: string): ParsedCards {
    const section = restrictToHeadingSection(html, poolHeading);
    const cards = extractDivBlocks(section, cls => /\blogCard\b/.test(cls));

    const fcEvents: FcEvent[] = [];
    const swgEvents: SwgEvent[] = [];
    const cyaEvents: FcEvent[] = [];
    const ccEvents: FcEvent[] = [];

    for (const card of cards) {
        const ts = cardTimestamp(card.inner);
        if (!ts) continue;

        const text = getText(card.inner);
        const swgMatch = SWG_PATTERN.exec(text);
        if (swgMatch) {
            swgEvents.push({
                ts,
                ppmPerDay: parseFloat(swgMatch[1]),
                hrs: parseFloat(swgMatch[2]),
                pct: parseFloat(swgMatch[3]),
                source: 'poolmath',
            });
            continue;
        }

        const isTestLogCard = /\btestLogCard\b/.test(card.openTag);
        if (!isTestLogCard) continue;

        const chiclets = extractDivBlocks(card.inner, cls => /\bchiclet\b/.test(cls));
        for (const chiclet of chiclets) {
            const divs = extractDivBlocks(chiclet.inner, () => true);
            if (divs.length < 2) continue;
            const valueText = getText(divs[0].inner);
            const labelText = getText(divs[1].inner).toUpperCase();
            const value = parseFloat(valueText);
            if (isNaN(value)) continue;
            if (labelText === 'FC') fcEvents.push({ ts, value });
            else if (labelText === 'CYA') cyaEvents.push({ ts, value });
            else if (labelText === 'CC') ccEvents.push({ ts, value });
        }
    }

    const sortDedupe = <T extends { ts: Date }>(arr: T[]): T[] => {
        const seen = new Set<string>();
        const out: T[] = [];
        for (const e of arr.sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
            const key = JSON.stringify(e);
            if (!seen.has(key)) { seen.add(key); out.push(e); }
        }
        return out;
    };

    return {
        fcEvents: sortDedupe(fcEvents),
        swgEvents: sortDedupe(swgEvents),
        cyaEvents: sortDedupe(cyaEvents),
        ccEvents: sortDedupe(ccEvents),
    };
}

// Combines PoolMath SWG entries with locally logged applied recommendations. Local
// entries always count; a PoolMath entry is dropped only if a local entry lies
// within LOCAL_SWG_MATCH_MS of it (i.e. they describe the same change).
function mergeSwgEvents(poolMath: SwgEvent[], local: LocalSwgEntry[]): { events: SwgEvent[]; replaced: number; localUsed: number } {
    const localEvents: SwgEvent[] = [];
    for (const l of local) {
        const ts = new Date(l.ts);
        if (isNaN(ts.getTime()) || !isFinite(l.ppmPerDay) || !isFinite(l.hrs) || !isFinite(l.pct)) continue;
        localEvents.push({ ts, ppmPerDay: l.ppmPerDay, hrs: l.hrs, pct: l.pct, source: 'local' });
    }
    const kept = poolMath.filter(p => !localEvents.some(l => Math.abs(l.ts.getTime() - p.ts.getTime()) <= LOCAL_SWG_MATCH_MS));
    const events = [...kept, ...localEvents].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return { events, replaced: poolMath.length - kept.length, localUsed: localEvents.length };
}

function swgRateAt(swgEvents: SwgEvent[], t: Date): number {
    let rate = 0;
    for (const e of swgEvents) {
        if (e.ts.getTime() <= t.getTime()) rate = e.ppmPerDay;
        else break;
    }
    return rate;
}

// Integral of the SWG step-function rate over [t1, t2], in ppm.
function generatedBetween(swgEvents: SwgEvent[], t1: Date, t2: Date): number {
    if (swgEvents.length === 0) return 0;
    const points = Array.from(new Set(
        [t1.getTime(), ...swgEvents.filter(e => e.ts.getTime() > t1.getTime() && e.ts.getTime() < t2.getTime()).map(e => e.ts.getTime()), t2.getTime()]
    )).sort((a, b) => a - b);
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = new Date(points[i]);
        const b = points[i + 1];
        const rate = swgRateAt(swgEvents, a);
        const days = (b - points[i]) / 86400000;
        total += rate * days;
    }
    return total;
}

// ---------------------------------------------------------------------------
// Time-of-day / timezone helpers (dependency-free; see module comment above)
// ---------------------------------------------------------------------------

interface TimeOfDay { hour: number; minute: number; second: number; }

function parseTimeOfDay(s: string): TimeOfDay {
    const trimmed = s.trim().toUpperCase().replace(/\s+/g, '');
    let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed); // 07:00 / 19:00 / 07:00:00 (24h)
    if (m && !/[AP]M/.test(trimmed)) {
        return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10), second: m[3] ? parseInt(m[3], 10) : 0 };
    }
    m = /^(\d{1,2}):(\d{2})(AM|PM)$/.exec(trimmed); // 7:00AM
    if (m) return { hour: to24Hour(parseInt(m[1], 10), m[3]), minute: parseInt(m[2], 10), second: 0 };
    m = /^(\d{1,2})(AM|PM)$/.exec(trimmed); // 7AM
    if (m) return { hour: to24Hour(parseInt(m[1], 10), m[2]), minute: 0, second: 0 };
    throw new Error(`Could not parse time of day: '${s}' (try '07:00' or '7am')`);
}

function to24Hour(h: number, meridian: string): number {
    if (meridian === 'AM') return h === 12 ? 0 : h;
    return h === 12 ? 12 : h + 12;
}

// Hours from `start` to `stop`, treating stop <= start as running past midnight
// into the next day (e.g. start 10pm, stop 6am -> 8.0 hours).
function durationHours(start: TimeOfDay, stop: TimeOfDay): number {
    const startSecs = start.hour * 3600 + start.minute * 60 + start.second;
    const stopSecs = stop.hour * 3600 + stop.minute * 60 + stop.second;
    let deltaSecs = stopSecs - startSecs;
    if (deltaSecs <= 0) deltaSecs += 24 * 3600;
    return deltaSecs / 3600;
}

// Offset (minutes) such that: utcMillis = wallClockAsUTCMillis - offset*60000
function tzOffsetMinutes(instant: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts: any = {};
    for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return (asUtc - instant.getTime()) / 60000;
}

// Constructs the UTC Date corresponding to a wall-clock date/time in `timeZone`.
function zonedTimeToUtc(year: number, month: number, day: number, t: TimeOfDay, timeZone: string): Date {
    const wallAsUtc = Date.UTC(year, month - 1, day, t.hour, t.minute, t.second);
    let guess = new Date(wallAsUtc);
    for (let i = 0; i < 2; i++) {
        const offsetMin = tzOffsetMinutes(guess, timeZone);
        guess = new Date(wallAsUtc - offsetMin * 60000);
    }
    return guess;
}

// 'YYYY-MM-DD HH:mm' wall-clock time of `instant` in `timeZone`.
function formatLocalDateTime(instant: Date, timeZone: string): string {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
    const parts: any = {};
    for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function localYmd(instant: Date, timeZone: string): { year: number; month: number; day: number } {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts: any = {};
    for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
    return { year: +parts.year, month: +parts.month, day: +parts.day };
}

function addDays(ymd: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
    const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    d.setUTCDate(d.getUTCDate() + days);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Total hours that a daily-repeating run window [startTime, startTime+durationHours),
// defined in the local time zone `tz`, overlaps the interval [t1, t2].
function dailyWindowOverlapHours(t1: Date, t2: Date, startTime: TimeOfDay, duration: number, tz: string): number {
    if (t2.getTime() <= t1.getTime() || duration <= 0) return 0;
    let total = 0;
    let day = addDays(localYmd(t1, tz), -1);
    const lastDay = addDays(localYmd(t2, tz), 1);
    // Bound the loop defensively -- this should never run more than a few dozen
    // iterations for realistic inputs, but a malformed config should not hang.
    for (let i = 0; i < 400; i++) {
        const windowStart = zonedTimeToUtc(day.year, day.month, day.day, startTime, tz);
        const windowEnd = new Date(windowStart.getTime() + duration * 3600000);
        const overlapStart = new Date(Math.max(windowStart.getTime(), t1.getTime()));
        const overlapEnd = new Date(Math.min(windowEnd.getTime(), t2.getTime()));
        if (overlapEnd.getTime() > overlapStart.getTime()) total += (overlapEnd.getTime() - overlapStart.getTime()) / 3600000;
        if (day.year === lastDay.year && day.month === lastDay.month && day.day === lastDay.day) break;
        day = addDays(day, 1);
    }
    return total;
}

// ---------------------------------------------------------------------------
// PoolMath fetch
// ---------------------------------------------------------------------------

function fetchHtml(shareCodeOrUrl: string): Promise<string> {
    const url = shareCodeOrUrl.startsWith('http') ? shareCodeOrUrl : `https://api.poolmathapp.com/share/${shareCodeOrUrl}`;
    const options = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (nodejs-poolController AutoSwg)' } };
    return new Promise<string>((resolve, reject) => {
        try {
            const req = https.request(url, options, res => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetchHtml(res.headers.location).then(resolve, reject);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`PoolMath returned HTTP ${res.statusCode} for ${url}`));
                    res.resume();
                    return;
                }
                let data = '';
                res.on('data', d => { data += d; });
                res.on('end', () => resolve(data));
            });
            req.on('error', err => reject(err));
            req.end();
        } catch (err) { reject(err); }
    });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// The chlorinator's pool setpoint only accepts whole-number percentages. Round
// up only when the fractional part is genuinely more than half (e.g. 19.7 ->
// 20), and round down otherwise (e.g. 19.3 -> 19, and a tie at exactly .5
// rounds down too) -- this avoids always ceiling small fractional overshoots
// up a full point while still preferring to slightly over- rather than
// under-shoot when the fraction is meaningfully large.
function roundDutyCyclePct(pct: number): number {
    const floor = Math.floor(pct);
    return (pct - floor) > 0.5 ? floor + 1 : floor;
}

// ppm/day the SWG can add at 100% duty cycle over a `swgHours`-long daily run
// window. swgLbsPerDay is the manufacturer's rated output over a full 24h day, so
// only swgHours/24 of it is achievable within the window.
function ppmPerDayAtFullDuty(gallons: number, swgLbsPerDay: number, swgHours: number): number {
    const ratedPpmPer24h = (swgLbsPerDay * 1_000_000) / (gallons * 8.34);
    return ratedPpmPer24h * (swgHours / 24);
}

// SWG capacity for a configured run window, e.g. to convert a logged SWG % into a
// PoolMath-style "X ppm FC per day" figure. Throws if a time can't be parsed.
export function computeSwgCapacity(p: { gallons: number; swgLbsPerDay: number; swgStartTime: string; swgStopTime: string }): { ppmPerDayAtFull: number; hours: number } {
    const hours = durationHours(parseTimeOfDay(p.swgStartTime), parseTimeOfDay(p.swgStopTime));
    return { ppmPerDayAtFull: ppmPerDayAtFullDuty(p.gallons, p.swgLbsPerDay, hours), hours };
}

export async function computeRecommendation(params: AutoSwgParams, html?: string, localSwgEntries: LocalSwgEntry[] = []): Promise<AutoSwgResult> {
    const rationale: string[] = [];
    const swgStart = parseTimeOfDay(params.swgStartTime);
    const swgStop = parseTimeOfDay(params.swgStopTime);
    const swgHours = durationHours(swgStart, swgStop);

    const pageHtml = html || await fetchHtml(params.shareCode);
    const { fcEvents, swgEvents: poolMathSwgEvents, cyaEvents } = parseCards(pageHtml, params.poolName);

    if (fcEvents.length === 0) throw new Error('No FC test readings found on the PoolMath page. The page markup may have changed, or the share code/pool name may be wrong.');
    const swgMerge = mergeSwgEvents(poolMathSwgEvents, localSwgEntries);
    const swgEvents = swgMerge.events;
    if (swgEvents.length === 0) throw new Error('No SWG log entries found on the PoolMath page or in the local SWG % change log. The page markup may have changed, or the share code/pool name may be wrong.');

    // Time-weighted running average FC consumption over the last windowDays.
    const intervals: { t1: Date; t2: Date; perDay: number }[] = [];
    for (let i = 0; i < fcEvents.length - 1; i++) {
        const [t1, fc1] = [fcEvents[i].ts, fcEvents[i].value];
        const [t2, fc2] = [fcEvents[i + 1].ts, fcEvents[i + 1].value];
        if (t2.getTime() <= t1.getTime()) continue;
        const gen = generatedBetween(swgEvents, t1, t2);
        const rawDelta = fc2 - fc1;
        const consumed = gen - rawDelta;
        const days = (t2.getTime() - t1.getTime()) / 86400000;
        intervals.push({ t1, t2, perDay: days > 0 ? consumed / days : 0 });
    }

    const rightNow = new Date();
    let windowStart = new Date(rightNow.getTime() - params.windowDays * 86400000);
    // Require at least MIN_FC_READINGS_IN_WINDOW readings so the average spans
    // more than a single interval. If the configured window (which ends at
    // calculation time) holds fewer, reach back to the Nth-most-recent reading.
    const readingsInWindow = fcEvents.filter(e => e.ts.getTime() >= windowStart.getTime() && e.ts.getTime() <= rightNow.getTime()).length;
    const windowExtended = readingsInWindow < MIN_FC_READINGS_IN_WINDOW && fcEvents.length >= MIN_FC_READINGS_IN_WINDOW;
    if (windowExtended) windowStart = fcEvents[fcEvents.length - MIN_FC_READINGS_IN_WINDOW].ts;
    const windowDaysUsed = windowExtended ? (rightNow.getTime() - windowStart.getTime()) / 86400000 : params.windowDays;
    let weightedTotal = 0;
    let coveredDays = 0;
    for (const iv of intervals) {
        const clipStart = new Date(Math.max(iv.t1.getTime(), windowStart.getTime()));
        const clipEnd = new Date(Math.min(iv.t2.getTime(), rightNow.getTime()));
        if (clipEnd.getTime() <= clipStart.getTime()) continue;
        const overlapDays = (clipEnd.getTime() - clipStart.getTime()) / 86400000;
        weightedTotal += iv.perDay * overlapDays;
        coveredDays += overlapDays;
    }
    // Average over the time actually spanned by consecutive FC readings. The
    // stretch since the last reading has no measured consumption, so dividing by
    // the whole window would understate the rate.
    const avgPerDay = coveredDays > 0 ? weightedTotal / coveredDays : 0;
    // Captured verbatim (not just re-derived from avgConsumptionPpmPerDay) so a
    // dashboard tile can show exactly this sentence without duplicating the
    // windowDays/fcEvents.length/swgEvents.length formatting logic itself.
    const windowLabel = windowExtended ? windowDaysUsed.toFixed(1) : `${params.windowDays}`;
    const windowRange = `${formatLocalDateTime(windowStart, params.timezone)} to ${formatLocalDateTime(rightNow, params.timezone)} ${params.timezone}`;
    const extensionNote = windowExtended
        ? `; window extended back from ${params.windowDays} days because it held fewer than ${MIN_FC_READINGS_IN_WINDOW} FC readings`
        : '';
    const avgConsumptionSummary = `Running ${windowLabel}-day average FC consumption (${windowRange}${extensionNote}): ${avgPerDay.toFixed(2)} ppm/day (from ${fcEvents.length} FC readings, ${swgEvents.length} SWG log entries).`;
    rationale.push(avgConsumptionSummary);
    if (swgMerge.localUsed > 0) {
        rationale.push(`SWG entries: ${swgMerge.localUsed} from the local SWG % change log,${poolMathSwgEvents.length - swgMerge.replaced} from PoolMath; ${swgMerge.replaced} PoolMath ${swgMerge.replaced === 1 ? 'entry' : 'entries'} within 1h of a local entry ignored in favor of the local one.`);
    }

    // SWG capacity. swgLbsPerDay is the manufacturer's rated output at 100% duty
    // over a full 24h day; scale it down to what's actually achievable at 100%
    // duty within the shorter configured run window.
    const maxDailyPpmAtFull = ppmPerDayAtFullDuty(params.gallons, params.swgLbsPerDay, swgHours);
    rationale.push(`SWG capacity: ${params.swgLbsPerDay} lbs/day (rated over 24h) -> ${maxDailyPpmAtFull.toFixed(2)} ppm/day at 100% duty cycle over ${swgHours}h/day (${params.swgStartTime}-${params.swgStopTime} ${params.timezone}).`);

    let recommendedPct = 0;
    if (maxDailyPpmAtFull > 0) {
        recommendedPct = Math.max(0, Math.min(100, (avgPerDay / maxDailyPpmAtFull) * 100));
        rationale.push(`Recommended SWG duty cycle to match ${avgPerDay.toFixed(2)} ppm/day demand: ${recommendedPct.toFixed(1)}%.`);
    } else {
        rationale.push('Recommended SWG duty cycle: cannot compute (check gallons / swgLbsPerDay / run window).');
    }

    // Projected current FC, using the actual logged run duration of the most
    // recent SWG entry (not the configured capacity window) for the generation
    // credit since the last FC reading -- see swg_percent_calcv5.py for why.
    const lastFc = fcEvents[fcEvents.length - 1];
    const elapsedDays = (rightNow.getTime() - lastFc.ts.getTime()) / 86400000;
    const latestSwg = swgEvents[swgEvents.length - 1];
    const runHoursElapsed = dailyWindowOverlapHours(lastFc.ts, rightNow, swgStart, latestSwg.hrs, params.timezone);
    const ratePerHour = latestSwg.hrs > 0 ? latestSwg.ppmPerDay / latestSwg.hrs : 0;
    const swgGeneratedSinceReading = ratePerHour * runHoursElapsed;
    const projectedCurrentFc = lastFc.value - (avgPerDay * elapsedDays) + swgGeneratedSinceReading;
    rationale.push(`Projected current FC: ${projectedCurrentFc.toFixed(2)} ppm (last reading ${lastFc.value} ppm, ${elapsedDays.toFixed(2)} days ago; minus ${(avgPerDay * elapsedDays).toFixed(2)} ppm consumed; plus ${swgGeneratedSinceReading.toFixed(2)} ppm generated).`);

    // Duty cycle needed to reach targetFc in targetDays.
    const targetHours = params.targetDays * 24;
    const neededPpm = (params.targetFc - projectedCurrentFc) + (avgPerDay * params.targetDays);
    const producibleAtFull = maxDailyPpmAtFull * params.targetDays;
    let recommendedPctForTarget = recommendedPct;
    if (producibleAtFull > 0) {
        recommendedPctForTarget = Math.max(0, Math.min(100, (neededPpm / producibleAtFull) * 100));
        if (neededPpm <= 0) rationale.push(`Already at/above ${params.targetFc} ppm target given ongoing consumption.`);
        else rationale.push(`Recommended SWG duty cycle to reach ${params.targetFc} ppm FC in ${targetHours}h: ${recommendedPctForTarget.toFixed(1)}%.`);
    }

    return {
        currentPct: latestSwg.pct,
        recommendedPct: roundDutyCyclePct(recommendedPct),
        recommendedPctForTarget: roundDutyCyclePct(recommendedPctForTarget),
        avgConsumptionPpmPerDay: Math.round(avgPerDay * 100) / 100,
        avgConsumptionSummary,
        avgWindowStart: windowStart.toISOString(),
        avgWindowEnd: rightNow.toISOString(),
        avgWindowExtended: windowExtended,
        projectedCurrentFc: Math.round(projectedCurrentFc * 100) / 100,
        mostRecentFc: { value: lastFc.value, ts: lastFc.ts.toISOString() },
        mostRecentCya: cyaEvents.length ? { value: cyaEvents[cyaEvents.length - 1].value, ts: cyaEvents[cyaEvents.length - 1].ts.toISOString() } : undefined,
        mostRecentSwg: { ppmPerDay: latestSwg.ppmPerDay, hrs: latestSwg.hrs, pct: latestSwg.pct, ts: latestSwg.ts.toISOString(), source: latestSwg.source },
        inputs: params,
        swgCapacityPpmPerDay: maxDailyPpmAtFull,
        swgRunHours: swgHours,
        localSwgEntriesUsed: swgMerge.localUsed,
        poolMathSwgEntriesReplaced: swgMerge.replaced,
        rationale,
    };
}

// Converts minutes-since-midnight (njsPC's Schedule.startTime/endTime unit) to
// an 'HH:MM' string usable as swgStartTime/swgStopTime, so a recommendation can
// be driven by an actual configured schedule instead of a hand-typed time.
export function minutesToHHMM(minutes: number): string {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    const hh = Math.floor(m / 60).toString().padStart(2, '0');
    const mm = (m % 60).toString().padStart(2, '0');
    return `${hh}:${mm}`;
}

// Exported for unit testing / offline debugging against a saved copy of the page.
export const __testables = { parseCards, generatedBetween, dailyWindowOverlapHours, parseTimeOfDay, durationHours, fetchHtml };
