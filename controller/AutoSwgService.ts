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

// How old the newest FC reading can be before the result says its projection is mostly
// extrapolation.
const STALE_FC_DAYS = 3;

// Default for params.fcAnomalyTolerancePpm: an FC rise that the SWG output and logged additions fall
// short of explaining by more than this many ppm (test-kit noise is about a ppm) marks the interval
// as suspect: an unlogged chlorine addition, a mistyped reading, or a missing SWG % entry. Such
// intervals are left out of the average. 0 turns the check off.
const ANOMALY_TOLERANCE_PPM = 2;

// How far apart (as a fraction) njsPC's SWG rating and the rating PoolMath's recent SWG entries imply
// can be before the calculation warns.
const SWG_RATING_TOLERANCE = 0.15;

// Short non-cryptographic fingerprint of a string (djb2), used to tell whether the data a
// calculation read has changed.
function hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// The weight on the modelled FC change when the last reading is `days` old: `base` up to `start` days, falling
// linearly to 0 at `end` days (end <= 0, or not past start, means no taper). The model is useful between
// nearby tests and hurts across long gaps, where weather and anything unlogged have had time to matter.
export function projectionWeight(base: number, days: number, start: number, end: number): number {
    const b = Math.max(0, Math.min(1, base));
    if (!(end > 0) || !(end > start)) return b;
    if (days <= start) return b;
    if (days >= end) return 0;
    return b * (end - days) / (end - start);
}

export interface AutoSwgParams {
    shareCode: string;
    poolName?: string;
    gallons: number;
    swgLbsPerDay: number;
    swgStartTime: string; // e.g. '07:00' or '7am'
    swgStopTime: string;  // e.g. '19:00' or '7pm'
    timezone: string;     // IANA zone name, e.g. 'America/New_York'
    windowDays: number;   // running-average window, e.g. 14
    // The configured target for a NEW target: reach targetFc in targetDaysAbove days if the
    // projected current FC is above it, or targetDaysBelow days if it's at or below it --
    // coming down from above and building back up from below are different jobs and
    // needn't take the same time.
    targetFc: number;
    targetDaysAbove: number;
    targetDaysBelow: number;
    // An already-committed target (a previous apply's FC and deadline) to stay on course
    // for instead of starting a new one, as long as the projected FC is within strayPpm of
    // targetFc. Infinity always stays on course (an explicit refresh); a finite value lets
    // an FC that has wandered further than that from the target abandon the old deadline
    // and start fresh. The deadline must still be ahead.
    inFlight?: { targetFc: number; targetDate: Date; strayPpm: number };
    // Today's sunrise and sunset as wall-clock times in `timezone` (like swgStartTime). With
    // them, the partial day between FC readings (and since the last one) is weighted by how
    // much of the day's chlorine loss falls in daylight vs. night rather than by the clock
    // alone. Omit either and time is counted by the clock, as before.
    // Credit liquid chlorine additions logged in PoolMath as FC added (default true): an addition
    // between two FC readings raises the second reading without the SWG having done it, so
    // without the credit the consumption between them is understated.
    creditChlorineAdditions?: boolean;
    // Run the calculation as of this moment instead of now, using only the data logged up to then
    // (see buildProjectionAccuracy). Omit for a normal calculation.
    asOf?: Date;
    // How many ppm of FC rise beyond what the SWG output and logged additions explain marks an
    // interval as suspect and leaves it out of the average (default 2; 0 = don't check).
    fcAnomalyTolerancePpm?: number;
    // How much of the modelled FC change since the last reading (SWG output minus consumption) to apply when
    // projecting the current FC, 0 to 1 (default 1 = all of it; 0 = start from the last reading unchanged).
    // Between tests FC moves less than the model expects, so a weight below 1 often predicts better (see
    // buildProjectionAccuracy, which suggests one from the history). Liquid chlorine logged since the
    // reading is always added in full -- it is known, not modelled.
    projectionWeight?: number;
    // Gap-aware taper of that weight: full weight until the last reading is projectionTaperStartDays old
    // (default 3), then falling to 0 at projectionTaperEndDays (default 0 = no taper).
    projectionTaperStartDays?: number;
    projectionTaperEndDays?: number;
    sunriseTime?: string;
    sunsetTime?: string;
    // Share (percent) of a day's FC consumption that happens in daylight. 0 or omitted =
    // estimate it from the day length with the parabolic model (see parabolicDaytimeShare).
    daytimeSharePct?: number;
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
    fcModelChange: number;           // the modelled FC change since the last reading, before weighting (generated minus consumed)
    fcAdded: number;                 // liquid chlorine added since the last reading (ppm)
    projectionWeight: number;       // the weight applied to the modelled change
    // What recommendedPctForTarget was actually aimed at: a new target (today's configured
    // FC, reached in the above/below window that applied) or, if `refreshed`, the
    // in-flight one (its original FC and deadline, unchanged).
    targetFcUsed: number;
    targetDateUsed: string;          // ISO
    targetDaysUsed: number;          // days from calculation time until targetDateUsed
    refreshed: boolean;              // true if it stayed on course for params.inFlight rather than starting a new target
    targetWarning?: string;          // set when even 100% can't reach targetFc within the window (the % above is capped at 100)
    targetInfo?: string;             // set when FC is so far above targetFc that consumption alone (SWG at 0%) won't bring it down by targetDateUsed -- informational, not a problem
    ratingNote?: string;             // set when PoolMath's recent SWG entries imply a rated output that disagrees with swgLbsPerDay
    fcAnomalyNote?: string;          // set when intervals in the averaging window were left out for an FC rise the SWG and logged additions can't explain
    dataKey: string;                 // fingerprint of the PoolMath data (FC readings, additions, SWG entries) this calculation used
    staleFcNote?: string;            // set when the last FC reading is STALE_FC_DAYS or more old
    mostRecentFc?: { value: number; ts: string };
    mostRecentCya?: { value: number; ts: string };
    mostRecentSwg?: { ppmPerDay: number; hrs: number; pct: number; ts: string; source: SwgSource };
    // The parameters this result was computed from, with targetFc/targetDays being what was
    // actually aimed at (also what the history export reads).
    inputs: Omit<AutoSwgParams, 'inFlight'> & { targetDays: number };
    swgCapacityPpmPerDay: number;    // ppm/day at 100% duty cycle over swgRunHours
    swgRunHours: number;             // length of the daily run window used
    localSwgEntriesUsed: number;     // entries from the local SWG % change log that fed the calculation
    poolMathSwgEntriesReplaced: number; // PoolMath SWG entries ignored because a local entry was within an hour
    rationale: string[];
}

// A past SWG % change (an applied recommendation or a manual change), as recorded
// in the local history log (see AutoSwgHistory.ts). Shaped like a PoolMath SWG log
// entry so the two can be merged into a single step function of SWG rate over time.
export interface LocalSwgEntry {
    ts: string; ppmPerDay: number; hrs: number; pct: number;
    kind?: 'auto' | 'manual'; // applied recommendation vs manual change (default 'auto')
    record?: any;             // the full history record, carried along for display/export
}

export type SwgSource = 'poolmath' | 'local-auto' | 'local-manual';

interface FcEvent { ts: Date; value: number; }
interface SwgEvent { ts: Date; ppmPerDay: number; hrs: number; pct: number; source: SwgSource; record?: any; }

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

// A liquid chlorine addition logged in PoolMath: `percent` strength, `ml` volume added.
export interface ChlorineAddition { ts: Date; percent: number; ml: number; }

// Milliliters per unit PoolMath may show an amount in on the share page (the JSON reports a
// normalized mL amount directly).
const ML_PER_UNIT: { [unit: string]: number } = {
    'oz': 29.5735295625, 'fl oz': 29.5735295625, 'gal': 3785.411784, 'qt': 946.352946, 'pt': 473.176473,
    'cup': 236.5882365, 'cups': 236.5882365, 'ml': 1, 'l': 1000,
};
// "70 oz of Liquid Chlorine - 10%" as the share page's addition card reads once its markup is stripped.
const LIQUID_CHLORINE_PATTERN = /([\d.,]+)\s*(fl\s*oz|oz|gal|qt|pt|cups?|ml|l)\b\s*of\s*Liquid\s*Chlorine[^\d]*([\d.]+)\s*%/i;

// ppm of FC a liquid chlorine addition adds to a pool of `gallons`: strength x volume / pool
// volume (1 gal of 10% in 10,000 gal is 10 ppm).
export function chlorineAdditionPpm(a: { percent: number; ml: number }, gallons: number): number {
    return gallons > 0 ? (a.percent / 100) * 1_000_000 * a.ml / (gallons * 3785.411784) : 0;
}

interface ParsedCards {
    chlorineAdditions: ChlorineAddition[];
    fcEvents: FcEvent[];
    swgEvents: SwgEvent[];
    cyaEvents: FcEvent[];
    ccEvents: FcEvent[];
}

// What a read of the share page found, for refreshing the history archive (see
// AutoSwgPoolMathArchive.refreshPoolMathArchiveFromPage): the test readings it lists and the
// time its oldest entry of any kind goes back to -- everything newer is what the page vouches
// for, so edits and deletions made in PoolMath within that span show up here.
export interface PageReadings {
    coverageStart?: Date;
    fc: { ts: Date; value: number }[];
    cc: { ts: Date; value: number }[];
    cya: { ts: Date; value: number }[];
    swg: { ts: Date; ppmPerDay: number; hrs: number; pct: number }[];
    chlorine: ChlorineAddition[];
}

function pageReadings(p: ParsedCards): PageReadings {
    const all = [...p.fcEvents, ...p.ccEvents, ...p.cyaEvents, ...p.swgEvents, ...p.chlorineAdditions];
    const coverageStart = all.length ? new Date(Math.min(...all.map(e => e.ts.getTime()))) : undefined;
    return { coverageStart, fc: p.fcEvents, cc: p.ccEvents, cya: p.cyaEvents, swg: p.swgEvents.map(e => ({ ts: e.ts, ppmPerDay: e.ppmPerDay, hrs: e.hrs, pct: e.pct })), chlorine: p.chlorineAdditions };
}

function parseCards(html: string, poolHeading?: string): ParsedCards {
    const section = restrictToHeadingSection(html, poolHeading);
    const cards = extractDivBlocks(section, cls => /\blogCard\b/.test(cls));

    const fcEvents: FcEvent[] = [];
    const swgEvents: SwgEvent[] = [];
    const cyaEvents: FcEvent[] = [];
    const ccEvents: FcEvent[] = [];
    const chlorineAdditions: ChlorineAddition[] = [];

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

        const clMatch = LIQUID_CHLORINE_PATTERN.exec(text);
        if (clMatch) {
            const amount = parseFloat(clMatch[1].replace(/,/g, ''));
            const perUnit = ML_PER_UNIT[clMatch[2].toLowerCase().replace(/\s+/g, ' ')];
            const percent = parseFloat(clMatch[3]);
            if (isFinite(amount) && isFinite(percent) && perUnit) chlorineAdditions.push({ ts, percent, ml: amount * perUnit });
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
        chlorineAdditions: sortDedupe(chlorineAdditions),
    };
}

// The last page parse, kept so re-running the calculation many times over one page (the projection
// accuracy report and what-if sweep do) doesn't re-parse it each time. Matched by the page's content.
let parseCache: { html: string; heading?: string; parsed: ParsedCards } | undefined;
function parseCardsCached(html: string, heading?: string): ParsedCards {
    if (parseCache && parseCache.heading === heading && parseCache.html === html) return parseCache.parsed;
    const parsed = parseCards(html, heading);
    parseCache = { html, heading, parsed };
    return parsed;
}

// The share page lists only recent history, so the reports (projection accuracy and the what-if sweep) can also
// draw on the PoolMath archive -- up to 18 months of FC readings, SWG entries, CYA and liquid chlorine pulled from
// the JSON interface. Where both have an entry within two minutes the page's wins, so an edit isn't listed twice.
// The merge is remembered for the last (page, archive) pair, since the reports re-run the calculation many times.
let mergeCache: { base: ParsedCards; archive: ArchivedHistory; merged: ParsedCards } | undefined;
function parseWithArchive(html: string, heading: string | undefined, archive?: ArchivedHistory): ParsedCards {
    const base = parseCardsCached(html, heading);
    if (!archive) return base;
    if (mergeCache && mergeCache.base === base && mergeCache.archive === archive) return mergeCache.merged;
    const near = (list: { ts: Date }[], t: number) => list.some(e => Math.abs(e.ts.getTime() - t) <= 2 * 60 * 1000);
    const byTime = (a: { ts: Date }, b: { ts: Date }) => a.ts.getTime() - b.ts.getTime();
    const merged: ParsedCards = {
        fcEvents: [...base.fcEvents, ...archive.fc.filter(a => !near(base.fcEvents, a.ts.getTime()))].sort(byTime),
        swgEvents: [...base.swgEvents, ...archive.swg.filter(a => !near(base.swgEvents, a.ts.getTime())).map(a => ({ ts: a.ts, ppmPerDay: a.ppmPerDay, hrs: a.hrs, pct: a.pct, source: 'poolmath' as SwgSource }))].sort(byTime),
        cyaEvents: [...base.cyaEvents, ...archive.cya.filter(a => !near(base.cyaEvents, a.ts.getTime()))].sort(byTime),
        ccEvents: base.ccEvents,
        chlorineAdditions: [...base.chlorineAdditions, ...archive.chlorine.filter(a => !near(base.chlorineAdditions, a.ts.getTime()))].sort(byTime),
    };
    mergeCache = { base, archive, merged };
    return merged;
}

// Combines PoolMath SWG entries with locally logged applied recommendations. Local
// entries always count; a PoolMath entry is dropped only if a local entry lies
// within LOCAL_SWG_MATCH_MS of it (i.e. they describe the same change).
function mergeSwgEvents(poolMath: SwgEvent[], local: LocalSwgEntry[]): { events: SwgEvent[]; replaced: number; localUsed: number } {
    const localEvents: SwgEvent[] = [];
    for (const l of local) {
        const ts = new Date(l.ts);
        if (isNaN(ts.getTime()) || !isFinite(l.ppmPerDay) || !isFinite(l.hrs) || !isFinite(l.pct)) continue;
        localEvents.push({ ts, ppmPerDay: l.ppmPerDay, hrs: l.hrs, pct: l.pct, source: l.kind === 'manual' ? 'local-manual' : 'local-auto', record: l.record });
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

// The SWG event in effect at time t (same "most recent at-or-before" rule as
// swgRateAt, but returning the event itself rather than just its rate).
function swgEventAt(swgEvents: SwgEvent[], t: Date): SwgEvent | undefined {
    let event: SwgEvent | undefined;
    for (const e of swgEvents) {
        if (e.ts.getTime() <= t.getTime()) event = e;
        else break;
    }
    return event;
}

// Like generatedBetween(), but for the partial/in-progress period since the last FC
// reading rather than a complete historical interval: credits each SWG rate change
// only for the actual run-window hours (via dailyWindowOverlapHours) it was in
// effect during, instead of attributing the whole elapsed span to whatever rate is
// currently active. Without this, several manual % changes since the last FC
// reading would have the latest one silently backdated over the entire elapsed
// time.
function swgGeneratedSinceLastReading(swgEvents: SwgEvent[], t1: Date, t2: Date, swgStart: TimeOfDay, tz: string): number {
    if (swgEvents.length === 0 || t2.getTime() <= t1.getTime()) return 0;
    const points = Array.from(new Set(
        [t1.getTime(), ...swgEvents.filter(e => e.ts.getTime() > t1.getTime() && e.ts.getTime() < t2.getTime()).map(e => e.ts.getTime()), t2.getTime()]
    )).sort((a, b) => a - b);
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const segStart = new Date(points[i]);
        const segEnd = new Date(points[i + 1]);
        const event = swgEventAt(swgEvents, segStart);
        if (!event || event.hrs <= 0) continue;
        const ratePerHour = event.ppmPerDay / event.hrs;
        const hours = dailyWindowOverlapHours(segStart, segEnd, swgStart, event.hrs, tz);
        total += ratePerHour * hours;
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

// The next time (at least `minMs` from now) a periodic check should fire when checks are
// pinned to the clock: every `hours` hours counting from `startTime` (wall-clock, in
// `timeZone`), restarting at `startTime` each day -- e.g. start 06:00 every 12h = 06:00 and
// 18:00; start 06:00 every 5h = 06:00, 11:00, 16:00, 21:00, then 06:00 again. Only meaningful
// for intervals under 24h (a longer interval can't be pinned to a time of day this way).
export function nextScheduledCheck(now: Date, startTime: string, hours: number, timeZone: string, minMs: number): Date {
    const t = parseTimeOfDay(startTime);
    const intervalMs = hours * 3600000;
    const earliest = now.getTime() + minMs;
    const today = localYmd(now, timeZone);
    const anchorOn = (ymd: { year: number; month: number; day: number }) => zonedTimeToUtc(ymd.year, ymd.month, ymd.day, t, timeZone).getTime();
    for (let d = -1; d <= 1; d++) {
        const day = addDays(today, d);
        const anchor = anchorOn(day);
        const nextAnchor = anchorOn(addDays(day, 1));
        for (let k = 0; anchor + k * intervalMs < nextAnchor; k++) {
            const at = anchor + k * intervalMs;
            if (at >= earliest) return new Date(at);
        }
    }
    return new Date(earliest + intervalMs);
}

// 'YYYY-MM-DD HH:mm' wall-clock time of `instant` in `timeZone`.
export function formatLocalDateTime(instant: Date, timeZone: string): string {
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

// When the share endpoint was last asked for anything. PoolMath rate limits it (about one
// request a minute), so the background history sync (AutoSwgPoolMathArchive) leaves a gap
// after any request made here, and records its own.
let lastShareRequestAt = 0;
export function noteShareRequest() { lastShareRequestAt = Date.now(); }
export function msSinceLastShareRequest(): number { return Date.now() - lastShareRequestAt; }

function fetchHtml(shareCodeOrUrl: string): Promise<string> {
    noteShareRequest();
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

// Share (0..1) of a day's chlorine loss that falls in daylight under the parabolic model:
// loss rate follows a parabola over the 24h day, peaking at solar noon and falling to zero
// at midnight, so with a day of `dayHours` (half-length h) the daylight area is
// 2h - h^3/216 out of a 24h total of 16. ~0.56 for a 9.5h winter day, ~0.67 for 11.6h,
// ~0.78 for a 14h summer day.
export function parabolicDaytimeShare(dayHours: number): number {
    const h = Math.max(0, Math.min(12, dayHours / 2));
    return (2 * h - (h * h * h) / 216) / 16;
}

// Local wall-clock minutes since midnight (0..1440) of `instant` in `timeZone`.
function localMinuteOfDay(instant: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts: any = {};
    for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
    return (+parts.hour) * 60 + (+parts.minute) + (+parts.second) / 60;
}

// How many "days" of consumption the span [from, to] represents. Every whole 24h block
// counts as exactly 1 (whatever time of day it starts); only the leftover partial block is
// weighted -- daylight minutes carry `share` of a day's loss spread evenly over the day
// length, night minutes the rest spread over the night. Today's sunrise/sunset are used for
// every day, a few minutes' drift either way across a window.
export function consumptionDayEquivalents(from: Date, to: Date, timeZone: string, daylight: { sunriseMin: number; sunsetMin: number; share: number }): number {
    const spanMin = (to.getTime() - from.getTime()) / 60000;
    if (spanMin <= 0) return 0;
    const whole = Math.floor(spanMin / 1440);
    const leftover = spanMin - whole * 1440;
    if (leftover <= 0) return whole;
    const dayLen = daylight.sunsetMin - daylight.sunriseMin;
    const s = localMinuteOfDay(new Date(from.getTime() + whole * 86400000), timeZone);
    let dayMin = 0;
    for (const k of [0, 1]) {
        const lo = daylight.sunriseMin + 1440 * k, hi = daylight.sunsetMin + 1440 * k;
        dayMin += Math.max(0, Math.min(s + leftover, hi) - Math.max(s, lo));
    }
    const nightMin = leftover - dayMin;
    return whole + dayMin * (daylight.share / dayLen) + nightMin * ((1 - daylight.share) / (1440 - dayLen));
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

export async function computeRecommendation(params: AutoSwgParams, html?: string, localSwgEntries: LocalSwgEntry[] = [], onPageParsed?: (page: PageReadings) => void, archive?: ArchivedHistory): Promise<AutoSwgResult> {
    const rationale: string[] = [];
    const swgStart = parseTimeOfDay(params.swgStartTime);
    const swgStop = parseTimeOfDay(params.swgStopTime);
    const swgHours = durationHours(swgStart, swgStop);

    const pageHtml = html || await fetchHtml(params.shareCode);
    const parsedCards = parseWithArchive(pageHtml, params.poolName, archive);
    // With `asOf`, only what had been logged by then counts.
    const asOfMs = params.asOf ? params.asOf.getTime() : undefined;
    const upTo = <T extends { ts: Date }>(list: T[]): T[] => typeof asOfMs === 'undefined' ? list : list.filter(e => e.ts.getTime() <= asOfMs);
    const fcEvents = upTo(parsedCards.fcEvents);
    const poolMathSwgEvents = upTo(parsedCards.swgEvents);
    const cyaEvents = upTo(parsedCards.cyaEvents);
    if (typeof asOfMs !== 'undefined') localSwgEntries = localSwgEntries.filter(e => new Date(e.ts).getTime() <= asOfMs);
    if (onPageParsed) {
        try { onPageParsed(pageReadings(parsedCards)); }
        catch (err) { logger.warn(`AutoSwg: could not refresh the PoolMath history archive from the page: ${err.message}`); }
    }

    if (fcEvents.length === 0) throw new Error('No FC test readings found on the PoolMath page. The page markup may have changed, or the share code/pool name may be wrong.');
    const swgMerge = mergeSwgEvents(poolMathSwgEvents, localSwgEntries);
    const swgEvents = swgMerge.events;
    if (swgEvents.length === 0) throw new Error('No SWG log entries found on the PoolMath page or in the local SWG % change log. The page markup may have changed, or the share code/pool name may be wrong.');

    // Does the SWG rating njsPC converts a % with (swgLbsPerDay) agree with the one PoolMath credited its
    // recent SWG entries with? PoolMath credits an entry with % x rated lbs/day x hours/24 (as ppm for the
    // pool), so each recent entry implies a rating; if they agree with each other and not with the setting,
    // the setting is probably stale (a swapped cell, say) and every recommended % is off by about that much.
    // Entries whose credit is tiny are skipped (PoolMath rounds it to 0.1 ppm).
    let ratingNote: string | undefined;
    if (params.swgLbsPerDay > 0 && params.gallons > 0) {
        const perLb = 1_000_000 / (params.gallons * 8.34);
        const implied = poolMathSwgEvents.filter(e => e.pct > 0 && e.hrs > 0 && e.ppmPerDay >= 1.0)
            .slice(-6).map(e => e.ppmPerDay / (e.pct / 100) / (e.hrs / 24) / perLb);
        if (implied.length >= 3) {
            const sorted = implied.slice().sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            const agreeing = implied.filter(v => Math.abs(v / median - 1) <= SWG_RATING_TOLERANCE).length;
            const diff = params.swgLbsPerDay / median - 1;
            if (agreeing >= 3 && agreeing * 2 > implied.length && Math.abs(diff) > SWG_RATING_TOLERANCE) {
                ratingNote = `PoolMath's recent SWG entries imply a rated output of about ${median.toFixed(2)} lbs/day, but the SWG Rating here is ${params.swgLbsPerDay} lbs/day (${diff > 0 ? '+' : ''}${(diff * 100).toFixed(0)}%). `
                    + `njsPC turns a % into ppm using its own rating, so the recommended % will tend to be ${diff > 0 ? 'too low' : 'too high'}. If you changed the cell, update the SWG Rating here (and the rating in PoolMath).`;
                rationale.push(`WARNING: ${ratingNote}`);
            }
        }
    }

    // Daylight weighting for the partial days between FC readings (see
    // consumptionDayEquivalents); undefined when sunrise/sunset aren't known, in which case
    // time is counted by the clock.
    let daylight: { sunriseMin: number; sunsetMin: number; share: number; dayHours: number; auto: boolean } | undefined;
    if (params.sunriseTime && params.sunsetTime) {
        try {
            const sr = parseTimeOfDay(params.sunriseTime), ss = parseTimeOfDay(params.sunsetTime);
            const sunriseMin = sr.hour * 60 + sr.minute, sunsetMin = ss.hour * 60 + ss.minute;
            const dayMin = sunsetMin - sunriseMin;
            if (dayMin > 0 && dayMin < 1440) {
                const auto = !(params.daytimeSharePct > 0);
                const share = auto ? parabolicDaytimeShare(dayMin / 60) : Math.min(0.99, params.daytimeSharePct / 100);
                daylight = { sunriseMin, sunsetMin, share, dayHours: dayMin / 60, auto };
            }
        }
        catch (err) { logger.warn(`AutoSwg: ignoring unusable sunrise/sunset (${err.message}); counting time by the clock.`); }
    }
    const dayEquivalents = (a: Date, b: Date): number => daylight ? consumptionDayEquivalents(a, b, params.timezone, daylight) : (b.getTime() - a.getTime()) / 86400000;

    // Liquid chlorine added between two points counts as FC the SWG didn't make.
    const additions = upTo(parsedCards.chlorineAdditions);
    const creditAdditions = params.creditChlorineAdditions !== false && params.gallons > 0 && additions.length > 0;
    const addedBetween = (a: Date, b: Date): number => creditAdditions
        ? additions.filter(x => x.ts.getTime() > a.getTime() && x.ts.getTime() <= b.getTime()).reduce((sum, x) => sum + chlorineAdditionPpm(x, params.gallons), 0)
        : 0;

    // Time-weighted running average FC consumption over the last windowDays.
    const anomalyTolerance = typeof params.fcAnomalyTolerancePpm === 'number' && params.fcAnomalyTolerancePpm >= 0 ? params.fcAnomalyTolerancePpm : ANOMALY_TOLERANCE_PPM;
    // Before the first SWG entry there is no record of what the SWG was doing, and the output is treated as
    // zero -- so an interval that starts there would show a stretch with no chlorine generation. It is left
    // out of the average (the bad number would otherwise pass straight through to the burn rate).
    const firstSwgMs = swgEvents[0].ts.getTime();
    const intervals: { t1: Date; t2: Date; perDay: number; consumed: number; rise: number; suspect: boolean; uncovered: boolean }[] = [];
    for (let i = 0; i < fcEvents.length - 1; i++) {
        const [t1, fc1] = [fcEvents[i].ts, fcEvents[i].value];
        const [t2, fc2] = [fcEvents[i + 1].ts, fcEvents[i + 1].value];
        if (t2.getTime() <= t1.getTime()) continue;
        const gen = generatedBetween(swgEvents, t1, t2);
        const rawDelta = fc2 - fc1;
        const consumed = gen + addedBetween(t1, t2) - rawDelta;
        const days = dayEquivalents(t1, t2);
        intervals.push({ t1, t2, perDay: days > 0 ? consumed / days : 0, consumed, rise: rawDelta, suspect: anomalyTolerance > 0 && consumed < -anomalyTolerance, uncovered: t1.getTime() < firstSwgMs });
    }

    const rightNow = params.asOf ? new Date(params.asOf) : new Date();
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
    const suspects: typeof intervals = [];
    let uncoveredLeftOut = 0;
    const overlapOf = (iv: { t1: Date; t2: Date }): number => {
        const clipStart = new Date(Math.max(iv.t1.getTime(), windowStart.getTime()));
        const clipEnd = new Date(Math.min(iv.t2.getTime(), rightNow.getTime()));
        return clipEnd.getTime() > clipStart.getTime() ? dayEquivalents(clipStart, clipEnd) : 0;
    };
    for (const iv of intervals) {
        const overlapDays = overlapOf(iv);
        if (overlapDays <= 0) continue;
        if (iv.uncovered) { uncoveredLeftOut++; continue; } // no SWG record behind it
        if (iv.suspect) { suspects.push(iv); continue; } // left out of the average -- see fcAnomalyNote
        weightedTotal += iv.perDay * overlapDays;
        coveredDays += overlapDays;
    }
    // The flagged intervals only protect the average from a bad number. If they are ALL the window
    // holds there is nothing else to average, and assuming no consumption at all would be worse, so
    // keep them (and say so in the note).
    let anomalyKept = false;
    if (coveredDays === 0 && suspects.length) {
        anomalyKept = true;
        for (const iv of suspects) { const o = overlapOf(iv); weightedTotal += iv.perDay * o; coveredDays += o; }
    }
    const firstSwgLabel = formatLocalDateTime(new Date(firstSwgMs), params.timezone);
    if (coveredDays === 0 && uncoveredLeftOut > 0) {
        // Everything in the window predates the SWG record: there is nothing to base a burn rate on, and
        // assuming none would recommend as though the pool used no chlorine.
        throw new Error(`None of the FC intervals in the averaging window has an SWG record behind it (the first SWG entry, in PoolMath or the local log, is ${firstSwgLabel}), so consumption can't be estimated yet. Log the SWG % in PoolMath (or let AutoSwg log it) and check again after a few more FC readings.`);
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
    if (uncoveredLeftOut > 0) rationale.push(`${uncoveredLeftOut} FC interval${uncoveredLeftOut === 1 ? '' : 's'} in the averaging window start before the first SWG entry (${firstSwgLabel}) and ${uncoveredLeftOut === 1 ? 'was' : 'were'} left out of the average, since what the SWG was doing then isn't on record.`);
    let fcAnomalyNote: string | undefined;
    if (suspects.length) {
        // About how much 10% liquid chlorine would account for the unexplained rise at this pool volume.
        const oz = (ppm: number) => Math.round(ppm * params.gallons * 3785.411784 / (0.10 * 1_000_000) / 29.5735295625);
        const parts = suspects.map(s => `${formatLocalDateTime(s.t1, params.timezone)} to ${formatLocalDateTime(s.t2, params.timezone)}: FC rose ${s.rise.toFixed(1)} ppm, ${(-s.consumed).toFixed(1)} ppm more than the SWG output and logged additions explain (about ${oz(-s.consumed)} oz of 10% liquid chlorine)`);
        const lead = anomalyKept
            ? `${suspects.length === 1 ? 'An interval looks' : `${suspects.length} intervals look`} suspect because FC rose more than the SWG and logged chlorine can explain, but nothing else in the averaging window was available, so ${suspects.length === 1 ? 'it was' : 'they were'} kept in the average`
            : `${suspects.length === 1 ? 'An interval was' : `${suspects.length} intervals were`} left out of the average because FC rose more than the SWG and logged chlorine can explain`;
        fcAnomalyNote = `${lead} -- ${parts.join('; ')}. If you added chlorine, log it in PoolMath as Liquid Chlorine; if a reading is wrong, correct or delete it there. The next check picks the change up.`;
        rationale.push(`NOTE: ${fcAnomalyNote}`);
    }
    if (creditAdditions) {
        const inWindow = additions.filter(x => x.ts.getTime() >= windowStart.getTime());
        if (inWindow.length) rationale.push(`Liquid chlorine additions credited as FC added: ${inWindow.map(x => `${formatLocalDateTime(x.ts, params.timezone)} +${chlorineAdditionPpm(x, params.gallons).toFixed(2)} ppm`).join('; ')}.`);
    }
    if (daylight) rationale.push(`Daylight weighting: day length ${daylight.dayHours.toFixed(1)}h (${params.sunriseTime}-${params.sunsetTime} ${params.timezone}); ${(daylight.share * 100).toFixed(0)}% of a day's FC consumption counted as daytime (${daylight.auto ? 'parabolic estimate from the day length' : 'configured'}). Whole 24h blocks count as one day; only the partial block is weighted.`);
    if (swgMerge.localUsed > 0) {
        rationale.push(`SWG entries: ${swgMerge.localUsed} from the local SWG % change log, ${poolMathSwgEvents.length - swgMerge.replaced} from PoolMath; ${swgMerge.replaced} PoolMath ${swgMerge.replaced === 1 ? 'entry' : 'entries'} within 1h of a local entry ignored in favor of the local one.`);
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

    // Projected current FC, crediting the actual logged run duration of each SWG
    // rate change since the last FC reading (not the configured capacity window) --
    // see swg_percent_calcv5.py for why run duration matters here. Piecewise across
    // every rate change in [lastFc.ts, rightNow) rather than just the latest one, so
    // e.g. several manual % changes since the last reading are each credited only
    // for the time they were actually in effect.
    const lastFc = fcEvents[fcEvents.length - 1];
    const elapsedDays = (rightNow.getTime() - lastFc.ts.getTime()) / 86400000;
    const latestSwg = swgEvents[swgEvents.length - 1];
    const swgGeneratedSinceReading = swgGeneratedSinceLastReading(swgEvents, lastFc.ts, rightNow, swgStart, params.timezone);
    const elapsedEq = dayEquivalents(lastFc.ts, rightNow);
    const addedSinceReading = addedBetween(lastFc.ts, rightNow);
    const baseWeight = typeof params.projectionWeight === 'number' ? Math.max(0, Math.min(1, params.projectionWeight)) : 1;
    const effectiveWeight = projectionWeight(baseWeight, elapsedDays, typeof params.projectionTaperStartDays === 'number' ? params.projectionTaperStartDays : 3,
        typeof params.projectionTaperEndDays === 'number' ? params.projectionTaperEndDays : 0);
    const modelChange = swgGeneratedSinceReading - (avgPerDay * elapsedEq);
    const projectedCurrentFc = lastFc.value + effectiveWeight * modelChange + addedSinceReading;
    rationale.push(`Projected current FC: ${projectedCurrentFc.toFixed(2)} ppm (last reading ${lastFc.value} ppm, ${elapsedDays.toFixed(2)} days ago${daylight ? ` = ${elapsedEq.toFixed(2)} days of consumption, daylight-weighted` : ''}; minus ${(avgPerDay * elapsedEq).toFixed(2)} ppm consumed; plus ${swgGeneratedSinceReading.toFixed(2)} ppm generated${addedSinceReading > 0 ? `; plus ${addedSinceReading.toFixed(2)} ppm of liquid chlorine added` : ''}${effectiveWeight < 1 ? `; only ${Math.round(effectiveWeight * 100)}% of the modelled change is applied (Projection Weighting${effectiveWeight < baseWeight ? `, reduced because the last reading is ${elapsedDays.toFixed(1)} days old` : ''})` : ''}).`);
    // With the last reading this old, the projection is mostly extrapolation from an
    // average -- worth saying so rather than presenting it with the same confidence as one
    // anchored to a recent test.
    let staleFcNote: string | undefined;
    if (elapsedDays >= STALE_FC_DAYS) {
        staleFcNote = `The last FC reading is ${elapsedDays.toFixed(1)} days old, so the projected FC (${projectedCurrentFc.toFixed(2)} ppm) is mostly extrapolation from the average consumption -- log a fresh FC test in PoolMath for a more reliable result.`;
        rationale.push(`NOTE: ${staleFcNote}`);
    }

    // What to aim at. If there's an in-flight target and the projected FC is still within
    // its stray threshold of the configured target, stay on course for it: same FC, same
    // deadline, only the % gets re-worked from fresh data. Otherwise start a new target
    // from the configured FC, in the above/below window that applies to where the
    // projected FC is.
    let targetFc = params.targetFc;
    let targetDays: number;
    let targetDate: Date;
    let refreshed = false;
    const inFlight = params.inFlight;
    const strayedBy = Math.abs(projectedCurrentFc - params.targetFc);
    if (inFlight && strayedBy <= inFlight.strayPpm) {
        refreshed = true;
        targetFc = inFlight.targetFc;
        targetDate = inFlight.targetDate;
        targetDays = (targetDate.getTime() - rightNow.getTime()) / 86400000;
        const when = `${formatLocalDateTime(targetDate, params.timezone)} ${params.timezone}`;
        if (isFinite(inFlight.strayPpm)) rationale.push(`Projected current FC is within ${inFlight.strayPpm} ppm of the ${params.targetFc} ppm target: refreshing against the original ${targetFc} ppm target by ${when} (same deadline as the last apply).`);
        else rationale.push(`Refreshed against the original target of ${targetFc} ppm by ${when} (same deadline as the last apply, recalculated with fresh PoolMath data).`);
    }
    else {
        const above = projectedCurrentFc > params.targetFc;
        if (inFlight) rationale.push(`Projected current FC is ${strayedBy.toFixed(2)} ppm ${above ? 'above' : 'below'} the ${params.targetFc} ppm target, more than the ${inFlight.strayPpm} ppm new-target threshold: starting a new target instead of refreshing the old one.`);
        targetDays = above ? params.targetDaysAbove : params.targetDaysBelow;
        targetDate = new Date(rightNow.getTime() + targetDays * 86400000);
        rationale.push(`Projected current FC is ${above ? 'above' : 'at or below'} the ${params.targetFc} ppm target: using the ${targetDays}-day window for FC ${above ? 'above' : 'below'} target.`);
    }

    // FC that starts well ABOVE the target may not burn down to it by the deadline even with
    // the SWG off. Rather than aim at a date the target can't be reached by, move the target
    // date out to when consumption alone is projected to bring FC down to it (the SWG then
    // just stays off until then). Never moves a deadline earlier.
    let targetInfo: string | undefined;
    if (projectedCurrentFc - (avgPerDay * targetDays) > targetFc + 0.005) {
        const origWindow = `${Math.round(targetDays * 10) / 10} day${Math.round(targetDays * 10) / 10 === 1 ? '' : 's'}`;
        const origDate = targetDate;
        const head = `FC is projected at ${projectedCurrentFc.toFixed(2)} ppm, above the ${targetFc} ppm target.`;
        if (avgPerDay > 0) {
            const daysToTarget = (projectedCurrentFc - targetFc) / avgPerDay;
            targetDays = daysToTarget;
            targetDate = new Date(rightNow.getTime() + daysToTarget * 86400000);
            targetInfo = `${head} At the projected burn of ${avgPerDay.toFixed(2)} ppm/day it should reach the target in about ${daysToTarget.toFixed(1)} days, later than the ${origWindow} to the original deadline (${formatLocalDateTime(origDate, params.timezone)}) -- so the target date is moved to ${formatLocalDateTime(targetDate, params.timezone)}, and the SWG isn't needed and is held at 0% until then.`;
        }
        else targetInfo = `${head} No FC consumption was measured, so there's no burn rate to project when it will reach the target; the SWG isn't needed and is held at 0%.`;
        rationale.push(`NOTE: ${targetInfo}`);
    }

    // Duty cycle needed to reach targetFc in targetDays.
    const targetHours = targetDays * 24;
    const neededPpm = (targetFc - projectedCurrentFc) + (avgPerDay * targetDays);
    const producibleAtFull = maxDailyPpmAtFull * targetDays;
    let recommendedPctForTarget = recommendedPct;
    let targetWarning: string | undefined;
    if (producibleAtFull > 0) {
        const unclampedPct = (neededPpm / producibleAtFull) * 100;
        recommendedPctForTarget = Math.max(0, Math.min(100, unclampedPct));
        if (neededPpm <= 0) rationale.push(`Already at/above ${targetFc} ppm target given ongoing consumption.`);
        else rationale.push(`Recommended SWG duty cycle to reach ${targetFc} ppm FC in ${Math.round(targetHours * 10) / 10}h: ${recommendedPctForTarget.toFixed(1)}%.`);
        // The % above is capped at 100, so if even that isn't enough the target can't be hit
        // in the window -- say so, and how long it would really take, rather than leaving a
        // capped number that quietly reads like a plan that works.
        if (unclampedPct > 100.5) {
            const window = `${Math.round(targetDays * 10) / 10} day${Math.round(targetDays * 10) / 10 === 1 ? '' : 's'}`;
            const netGainPerDay = maxDailyPpmAtFull - avgPerDay;
            const gap = targetFc - projectedCurrentFc;
            if (netGainPerDay > 0 && gap > 0) targetWarning = `Even at 100%, the SWG can't bring FC from a projected ${projectedCurrentFc.toFixed(2)} ppm up to the ${targetFc} ppm target within ${window} -- at 100% it would take about ${(gap / netGainPerDay).toFixed(1)} days. The recommendation is capped at 100%.`;
            else targetWarning = `Even at 100%, the SWG (${maxDailyPpmAtFull.toFixed(2)} ppm/day) can't outpace the ${avgPerDay.toFixed(2)} ppm/day of consumption, so FC will not reach the ${targetFc} ppm target within ${window}, or at all, at this rate. The recommendation is capped at 100%.`;
            rationale.push(`WARNING: ${targetWarning}`);
        }
    }

    // What gets recorded as this result's inputs: the parameters, minus the in-flight
    // object (a Date and possibly Infinity -- neither survives being logged as JSON), with
    // the target actually aimed at in place of the configured one.
    const inputsUsed: any = Object.assign({}, params, { targetFc: targetFc, targetDays: targetDays });
    delete inputsUsed.inFlight;
    delete inputsUsed.asOf;

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
        fcModelChange: modelChange,
        fcAdded: addedSinceReading,
        projectionWeight: effectiveWeight,
        targetFcUsed: targetFc,
        targetDateUsed: targetDate.toISOString(),
        targetDaysUsed: targetDays,
        refreshed: refreshed,
        targetWarning: targetWarning,
        targetInfo: targetInfo,
        staleFcNote: staleFcNote,
        fcAnomalyNote: fcAnomalyNote,
        ratingNote: ratingNote,
        dataKey: hashString(JSON.stringify([
            fcEvents.map(e => [e.ts.getTime(), e.value]),
            additions.map(a => [a.ts.getTime(), a.percent, Math.round(a.ml)]),
            swgEvents.map(e => [e.ts.getTime(), e.ppmPerDay, e.hrs, e.pct]),
        ])),
        mostRecentFc: { value: lastFc.value, ts: lastFc.ts.toISOString() },
        mostRecentCya: cyaEvents.length ? { value: cyaEvents[cyaEvents.length - 1].value, ts: cyaEvents[cyaEvents.length - 1].ts.toISOString() } : undefined,
        mostRecentSwg: { ppmPerDay: latestSwg.ppmPerDay, hrs: latestSwg.hrs, pct: latestSwg.pct, ts: latestSwg.ts.toISOString(), source: latestSwg.source },
        inputs: inputsUsed,
        swgCapacityPpmPerDay: maxDailyPpmAtFull,
        swgRunHours: swgHours,
        localSwgEntriesUsed: swgMerge.localUsed,
        poolMathSwgEntriesReplaced: swgMerge.replaced,
        rationale,
    };
}

export interface CombinedHistoryEntry {
    ts: string;                  // ISO
    // 'CYA' rows are only the readings where the value changed (plus the first); 'CL' rows are liquid
    // chlorine additions.
    type: 'SWG' | 'FC' | 'CYA' | 'CL';
    source: SwgSource;           // FC readings always come from PoolMath
    pct?: number;                // SWG %
    ppmPerDay?: number;          // SWG: PoolMath-style "X ppm FC" per day
    hrs?: number;                // SWG: run hours
    value?: number;              // FC ppm (FC rows) or CYA ppm (CYA rows)
    previous?: number;           // CYA rows: the CYA reading before this one, when there was one
    percent?: number;            // CL rows: the chlorine's strength %
    ml?: number;                 // CL rows: the volume added, in mL
    ppm?: number;                // CL rows: the ppm FC it adds to the configured pool volume
    record?: any;                // local SWG entries only: the full history record (inputs/outputs)
}

export interface CombinedHistory {
    entries: CombinedHistoryEntry[];      // oldest first
    localSwgEntriesUsed: number;
    poolMathSwgEntriesReplaced: number;   // PoolMath SWG entries left out because a local entry is within an hour
    poolMathError?: string;               // set if PoolMath couldn't be read; entries then hold local data only
    // The CYA readings (oldest first) from the page plus the archive -- not part of `entries`
    // (which hold the FC and SWG rows the history dialog lists), kept for features that want to
    // relate chlorine consumption to the stabilizer level.
    cya?: { ts: string; value: number }[];
    // Liquid chlorine additions (oldest first) from the page plus the archive, with the ppm FC each
    // adds to the configured pool volume (when `gallons` was given) -- likewise kept for features
    // that relate consumption to what was added.
    chlorineAdditions?: { ts: string; percent: number; ml: number; ppm?: number }[];
}

// Older PoolMath history from the background-synced archive (see AutoSwgPoolMathArchive).
export interface ArchivedHistory {
    fc: { ts: Date; value: number }[];
    swg: { ts: Date; ppmPerDay: number; hrs: number; pct: number }[];
    cya: { ts: Date; value: number }[];
    chlorine: ChlorineAddition[];
}

// The SWG % and FC history exactly as a calculation would see it: FC readings
// from PoolMath, and SWG entries from the local log plus PoolMath's, with a
// PoolMath SWG entry dropped when a local one is within an hour of it. If
// PoolMath can't be read, the local SWG entries are still returned.
export async function buildCombinedHistory(params: { shareCode?: string; poolName?: string; gallons?: number }, html?: string, localSwgEntries: LocalSwgEntry[] = [], archive?: () => ArchivedHistory, onPageParsed?: (page: PageReadings) => void): Promise<CombinedHistory> {
    let fcEvents: FcEvent[] = [];
    let cyaEvents: FcEvent[] = [];
    let chlorine: ChlorineAddition[] = [];
    let poolMathSwgEvents: SwgEvent[] = [];
    let poolMathError: string;
    try {
        if (!html && !params.shareCode) throw new Error('No PoolMath share code is configured.');
        const parsed = parseCards(html || await fetchHtml(params.shareCode), params.poolName);
        if (onPageParsed) {
            try { onPageParsed(pageReadings(parsed)); }
            catch (err) { logger.warn(`AutoSwg: could not refresh the PoolMath history archive from the page: ${err.message}`); }
        }
        fcEvents = parsed.fcEvents;
        cyaEvents = parsed.cyaEvents;
        chlorine = parsed.chlorineAdditions;
        poolMathSwgEvents = parsed.swgEvents;
    }
    catch (err) { poolMathError = err.message; }
    // Older readings from the background-synced archive that the share page no longer lists.
    // The archive is read only now, after the page read above had its chance to refresh it, and
    // the page's own entry wins when both have one at (nearly) the same time -- so an edited
    // reading isn't listed twice.
    if (archive) {
        const arch = archive();
        const near = (list: { ts: Date }[], t: number) => list.some(e => Math.abs(e.ts.getTime() - t) <= 2 * 60 * 1000);
        fcEvents = [...fcEvents, ...arch.fc.filter(a => !near(fcEvents, a.ts.getTime()))];
        cyaEvents = [...cyaEvents, ...arch.cya.filter(a => !near(cyaEvents, a.ts.getTime()))];
        chlorine = [...chlorine, ...arch.chlorine.filter(a => !near(chlorine, a.ts.getTime()))];
        poolMathSwgEvents = [...poolMathSwgEvents, ...arch.swg.filter(a => !near(poolMathSwgEvents, a.ts.getTime())).map(a => ({ ts: a.ts, ppmPerDay: a.ppmPerDay, hrs: a.hrs, pct: a.pct, source: 'poolmath' as SwgSource }))];
    }
    const swgMerge = mergeSwgEvents(poolMathSwgEvents, localSwgEntries);
    const byTime = (a: { ts: string }, b: { ts: string }) => new Date(a.ts).getTime() - new Date(b.ts).getTime();
    const cya = cyaEvents.map(e => ({ ts: e.ts.toISOString(), value: e.value })).sort(byTime);
    const chlorineAdditions = chlorine.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime())
        .map(a => ({ ts: a.ts.toISOString(), percent: a.percent, ml: a.ml, ppm: params.gallons > 0 ? chlorineAdditionPpm(a, params.gallons) : undefined }));
    // Only the CYA readings that show a change (and the first, as the starting value) get a row.
    const cyaRows: CombinedHistoryEntry[] = [];
    cya.forEach((c, i) => {
        if (i === 0 || c.value !== cya[i - 1].value) cyaRows.push({ ts: c.ts, type: 'CYA', source: 'poolmath', value: c.value, previous: i > 0 ? cya[i - 1].value : undefined });
    });
    const entries: CombinedHistoryEntry[] = [
        ...fcEvents.map(e => ({ ts: e.ts.toISOString(), type: 'FC' as const, source: 'poolmath' as SwgSource, value: e.value })),
        ...swgEventsToEntries(swgMerge.events),
        ...cyaRows,
        ...chlorineAdditions.map(a => ({ ts: a.ts, type: 'CL' as const, source: 'poolmath' as SwgSource, percent: a.percent, ml: a.ml, ppm: a.ppm })),
    ].sort(byTime);
    return { entries, localSwgEntriesUsed: swgMerge.localUsed, poolMathSwgEntriesReplaced: swgMerge.replaced, poolMathError, cya, chlorineAdditions };
}

// Readings from before the SWG record starts have no SWG output to work from, so intervals around
// them can't be scored. Returns the first reading index k that can be: its previous reading has at
// least three covered intervals behind it. Infinity when there are no SWG entries at all.
function firstScorableReading(fc: FcEvent[], swgEvents: SwgEvent[], local: LocalSwgEntry[]): number {
    const times = [...swgEvents.map(e => e.ts.getTime()), ...local.map(e => new Date(e.ts).getTime())].filter(t => isFinite(t));
    if (!times.length) return Infinity;
    const first = Math.min(...times);
    const idx = fc.findIndex(e => e.ts.getTime() >= first);
    return idx < 0 ? Infinity : idx + 4;
}

// One FC reading and what the algorithm projected for that moment from only the data logged before it.
export interface ProjectionAccuracyRow {
    ts: string;                        // the FC reading's time
    previousTs: string;                // the reading the projection started from
    days: number;                      // days between them
    measured: number;                  // the FC actually measured
    projected: number;                 // the projected FC just before that reading
    error: number;                     // projected - measured (positive = projected too high)
    avgConsumptionPpmPerDay: number;   // the burn rate the projection used
    previous: number;                  // the FC at the previous reading
    modelChange: number;               // the modelled change since then, before weighting
    added: number;                     // liquid chlorine logged since then (ppm)
}

// A target an apply aimed at, and the FC measured nearest its deadline.
export interface TargetTrackingRow {
    appliedAt: string;
    targetFc: number;
    targetDate: string;
    passed: boolean;                   // the deadline is behind us
    nearest?: { ts: string; value: number; offsetHours: number };
    difference?: number;               // nearest.value - targetFc
}

// A projection weighting and its gap taper (taperEnd 0 = no taper).
export interface WeightingChoice { weight: number; taperStart: number; taperEnd: number; }

export interface ProjectionAccuracy {
    rows: ProjectionAccuracyRow[];     // oldest first
    summary: { count: number; meanAbsError?: number; rmse?: number; bias?: number; within1?: number; within2?: number;
        byGap: { label: string; count: number; meanAbsError?: number }[];
        unchangedMae?: number;         // error of the no-model baseline "FC is what it was at the last reading"
        skill?: number;                // 1 - meanAbsError / unchangedMae (positive = better than the baseline)
        weighting: { current: WeightingChoice; best?: WeightingChoice; suggested?: WeightingChoice; maeCurrent?: number; maeBest?: number; maeSuggested?: number };
        // The readings since the tuning settings last changed -- the ones they weren't tuned on, so an honest
        // read of how they are doing.
        sinceChange?: { since: string; count: number; meanAbsError?: number; unchangedMae?: number; bias?: number } };
    targets: TargetTrackingRow[];      // oldest first
    skipped: number;                   // readings that couldn't be scored (long gaps, too little history)
    history?: { readings: number; from?: string; archived: number };   // the FC readings available (page plus archive) and how many came from the archive
}

// How well the algorithm predicts FC, checked against what was measured: for each FC reading in
// the last `lookbackDays`, re-run the calculation as of a minute before it -- with only the data
// logged by then and today's settings -- and compare the projected FC with the measured one. Also
// matches each apply's target FC and deadline with the FC measured nearest the deadline.
// Limits: it reads the share page (so only what the page lists), and uses today's run window and
// sunrise/sunset for past days.
export async function buildProjectionAccuracy(params: AutoSwgParams, options: { lookbackDays: number; html?: string; localSwgEntries?: LocalSwgEntry[]; historyRecords?: any[]; tuningChangedAt?: string; archive?: ArchivedHistory }): Promise<ProjectionAccuracy> {
    const html = options.html || await fetchHtml(params.shareCode);
    const parsedPage = parseWithArchive(html, params.poolName, options.archive);
    const fc = parsedPage.fcEvents;
    const minK = firstScorableReading(fc, parsedPage.swgEvents, options.localSwgEntries || []);
    const from = Date.now() - options.lookbackDays * 86400000;
    const rows: ProjectionAccuracyRow[] = [];
    let skipped = 0;
    for (let k = 1; k < fc.length; k++) {
        const t1 = fc[k - 1].ts, t2 = fc[k].ts;
        if (t2.getTime() < from) continue;
        if (k < minK) { skipped++; continue; } // no SWG record behind this reading yet
        const days = (t2.getTime() - t1.getTime()) / 86400000;
        if (days < 0.1 || days > 14) { skipped++; continue; }
        try {
            const r = await computeRecommendation(Object.assign({}, params, { inFlight: undefined, asOf: new Date(t2.getTime() - 60000) }), html, options.localSwgEntries || [], undefined, options.archive);
            if (!r.mostRecentFc || r.mostRecentFc.ts !== t1.toISOString()) { skipped++; continue; }
            rows.push({
                ts: t2.toISOString(), previousTs: t1.toISOString(), days: Math.round(days * 100) / 100,
                measured: fc[k].value, projected: r.projectedCurrentFc, error: Math.round((r.projectedCurrentFc - fc[k].value) * 100) / 100,
                avgConsumptionPpmPerDay: r.avgConsumptionPpmPerDay,
                previous: fc[k - 1].value, modelChange: r.fcModelChange, added: r.fcAdded,
            });
        }
        catch (err) { skipped++; } // too little history before this reading
    }
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
    const round2 = (v: number | undefined) => typeof v === 'number' ? Math.round(v * 100) / 100 : undefined;
    const abs = rows.map(r => Math.abs(r.error));
    const bucket = (label: string, lo: number, hi: number) => {
        const e = rows.filter(r => r.days >= lo && r.days < hi).map(r => Math.abs(r.error));
        return { label, count: e.length, meanAbsError: round2(mean(e)) };
    };
    const summary = {
        count: rows.length,
        meanAbsError: round2(mean(abs)),
        rmse: rows.length ? round2(Math.sqrt(mean(rows.map(r => r.error * r.error)))) : undefined,
        bias: round2(mean(rows.map(r => r.error))),
        within1: rows.length ? Math.round(100 * abs.filter(e => e <= 1).length / rows.length) : undefined,
        within2: rows.length ? Math.round(100 * abs.filter(e => e <= 2).length / rows.length) : undefined,
        byGap: [bucket('under 2 days', 0, 2), bucket('2 to 5 days', 2, 5), bucket('5 to 14 days', 5, 15)],
        unchangedMae: undefined as number | undefined,
        skill: undefined as number | undefined,
        sinceChange: undefined as { since: string; count: number; meanAbsError?: number; unchangedMae?: number; bias?: number } | undefined,
        weighting: {
            current: {
                weight: typeof params.projectionWeight === 'number' ? params.projectionWeight : 1,
                taperStart: typeof params.projectionTaperStartDays === 'number' ? params.projectionTaperStartDays : 3,
                taperEnd: typeof params.projectionTaperEndDays === 'number' ? params.projectionTaperEndDays : 0,
            },
        } as { current: WeightingChoice; best?: WeightingChoice; suggested?: WeightingChoice; maeCurrent?: number; maeBest?: number; maeSuggested?: number },
    };
    if (rows.length) {
        // What would each weighting of the modelled change have scored on these same readings? The suggestion
        // shrinks the best one toward 0.5 until there are plenty of readings, since a few dozen is thin.
        // The taper (weight falling to zero for long gaps) is chosen from a few candidates, and only when it
        // beats no taper by a clear margin.
        const maeAt = (c: WeightingChoice) => mean(rows.map(r => Math.abs(r.previous + projectionWeight(c.weight, r.days, c.taperStart, c.taperEnd) * r.modelChange + r.added - r.measured))) as number;
        const tapers: [number, number][] = [[3, 0], [3, 8], [4, 10], [2, 6], [5, 12]];
        let best: WeightingChoice = { weight: 0, taperStart: 3, taperEnd: 0 }, bestMae = Infinity;
        for (let i = 0; i <= 20; i++) {
            for (const [ts, te] of tapers) {
                const c = { weight: i / 20, taperStart: ts, taperEnd: te };
                const m = maeAt(c);
                if (m < bestMae - 1e-9) { bestMae = m; best = c; }
            }
        }
        const w = rows.length / (rows.length + 30);
        const weight = Math.round((w * best.weight + (1 - w) * 0.5) * 20) / 20;
        let suggested: WeightingChoice = { weight, taperStart: 3, taperEnd: 0 };
        const noTaper = maeAt(suggested);
        for (const [ts, te] of tapers.slice(1)) {
            const c = { weight, taperStart: ts, taperEnd: te };
            if (maeAt(c) < maeAt(suggested) - 1e-9) suggested = c;
        }
        if (maeAt(suggested) > noTaper * 0.97) suggested = { weight, taperStart: 3, taperEnd: 0 }; // not clearly better: no taper
        const unchanged = mean(rows.map(r => Math.abs(r.previous - r.measured))) as number;
        summary.unchangedMae = round2(unchanged);
        summary.skill = round2(1 - (summary.meanAbsError as number) / unchanged);
        summary.weighting = { current: summary.weighting.current, best, suggested, maeCurrent: summary.meanAbsError, maeBest: round2(bestMae), maeSuggested: round2(maeAt(suggested)) };
    }

    if (options.tuningChangedAt && !isNaN(new Date(options.tuningChangedAt).getTime())) {
        const since = new Date(options.tuningChangedAt).getTime();
        const recent = rows.filter(r => new Date(r.ts).getTime() >= since);
        summary.sinceChange = {
            since: options.tuningChangedAt,
            count: recent.length,
            meanAbsError: recent.length ? round2(mean(recent.map(r => Math.abs(r.error)))) : undefined,
            unchangedMae: recent.length ? round2(mean(recent.map(r => Math.abs(r.previous - r.measured)))) : undefined,
            bias: recent.length ? round2(mean(recent.map(r => r.error))) : undefined,
        };
    }

    // Targets from the local log of applied recommendations (one row per distinct target).
    const targets: TargetTrackingRow[] = [];
    const seen = new Set<string>();
    for (const rec of (options.historyRecords || []).slice().sort((a, b) => new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime())) {
        const o = rec && rec.outputs;
        if (!o || o.autoStep || typeof o.lastAppliedTargetFc !== 'number' || !o.lastAppliedTargetDate) continue;
        const key = `${o.lastAppliedTargetDate}|${o.lastAppliedTargetFc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const when = new Date(o.lastAppliedTargetDate).getTime();
        if (isNaN(when)) continue;
        const row: TargetTrackingRow = { appliedAt: rec.appliedAt, targetFc: o.lastAppliedTargetFc, targetDate: new Date(when).toISOString(), passed: when <= Date.now() };
        if (row.passed) {
            let best: { ts: string; value: number; offsetHours: number } | undefined;
            for (const e of fc) {
                const off = (e.ts.getTime() - when) / 3600000;
                if (Math.abs(off) <= 72 && (!best || Math.abs(off) < Math.abs(best.offsetHours))) best = { ts: e.ts.toISOString(), value: e.value, offsetHours: Math.round(off * 10) / 10 };
            }
            if (best) { row.nearest = best; row.difference = Math.round((best.value - row.targetFc) * 100) / 100; }
        }
        targets.push(row);
    }
    return { rows, summary, targets, skipped, history: { readings: fc.length, from: fc.length ? fc[0].ts.toISOString() : undefined, archived: options.archive ? options.archive.fc.length : 0 } };
}

// One configuration the what-if sweep scored, and how it compared with the current settings.
export interface WhatIfVariant {
    key: string;
    label: string;
    count: number;                       // readings scored (the same readings for every variant)
    meanAbsError?: number;
    rmse?: number;
    bias?: number;                       // mean(projected - measured)
    diff?: number;                       // mean change in absolute error vs the current settings (negative = better)
    diffLow?: number;                    // 90% bootstrap interval of that change
    diffHigh?: number;
    verdict: 'current' | 'better' | 'worse' | 'no clear difference';
    settings?: { [setting: string]: number | boolean };   // the AutoSwg settings that make it differ from the current ones (none for e.g. daylight weighting, which is automatic)
}

export interface WhatIfSweep {
    count: number;                       // readings every variant could score
    skipped: number;
    variants: WhatIfVariant[];           // current settings first, then best to worst
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

// Re-scores the projection accuracy under alternative settings -- other averaging windows, daylight
// weighting off, the liquid chlorine credit toggled, other anomaly tolerances -- on the SAME FC
// readings as the current settings, so the comparison is like for like. Each variant's change in
// mean absolute error vs the current settings comes with a 90% bootstrap interval, and a verdict
// ("better"/"worse" only when that interval excludes zero). Yields to the event loop between
// calculations so it can't hold up the rest of njsPC.
export async function buildWhatIfSweep(params: AutoSwgParams, options: { lookbackDays: number; html?: string; localSwgEntries?: LocalSwgEntry[]; archive?: ArchivedHistory }): Promise<WhatIfSweep> {
    const html = options.html || await fetchHtml(params.shareCode);
    const parsedPage = parseWithArchive(html, params.poolName, options.archive);
    const fc = parsedPage.fcEvents;
    const minK = firstScorableReading(fc, parsedPage.swgEvents, options.localSwgEntries || []);
    const from = Date.now() - options.lookbackDays * 86400000;

    const variants: { key: string; label: string; params: AutoSwgParams }[] = [{ key: 'current', label: 'Current settings', params }];
    // A variant identical to the current settings (now that the defaults are a 50% weighting with a 3 to 8 day taper, a
    // couple of the candidates are) would only add a row that says nothing changes, so it is left out.
    const TUNING = ['windowDays', 'creditChlorineAdditions', 'fcAnomalyTolerancePpm', 'projectionWeight', 'projectionTaperStartDays', 'projectionTaperEndDays', 'sunriseTime', 'sunsetTime'];
    const add = (key: string, label: string, p: AutoSwgParams) => {
        if (TUNING.every(k => (p as any)[k] === (params as any)[k])) return;
        variants.push({ key, label, params: p });
    };
    for (const w of [7, 14, 21, 28, 42, 56]) if (w !== params.windowDays) add(`window${w}`, `Averaging window ${w} days`, Object.assign({}, params, { windowDays: w }));
    if (params.sunriseTime && params.sunsetTime) add('noDaylight', 'Daylight weighting off', Object.assign({}, params, { sunriseTime: undefined, sunsetTime: undefined }));
    add('creditToggle', params.creditChlorineAdditions !== false ? 'Liquid chlorine credit off' : 'Liquid chlorine credit on', Object.assign({}, params, { creditChlorineAdditions: params.creditChlorineAdditions === false }));
    const curWeight = typeof params.projectionWeight === 'number' ? params.projectionWeight : 1;
    for (const d of [0, 0.25, 0.5, 0.75, 1]) if (d !== curWeight) add(`weight${d}`, `Projection weighting ${Math.round(d * 100)}%`, Object.assign({}, params, { projectionWeight: d }));
    // Gap taper: the weight falls to zero as the last reading gets older (with the weighting as set, and at 50%).
    for (const [ts, te] of [[3, 8], [4, 10], [2, 6]]) {
        add(`taper${ts}_${te}`, `Taper off ${ts} to ${te} days`, Object.assign({}, params, { projectionTaperStartDays: ts, projectionTaperEndDays: te }));
        add(`taper${ts}_${te}_50`, `Weighting 50% + taper ${ts} to ${te} days`, Object.assign({}, params, { projectionWeight: 0.5, projectionTaperStartDays: ts, projectionTaperEndDays: te }));
    }
    const curTol = typeof params.fcAnomalyTolerancePpm === 'number' ? params.fcAnomalyTolerancePpm : ANOMALY_TOLERANCE_PPM;
    for (const t of [0, 1, 3]) if (t !== curTol) add(`tol${t}`, t === 0 ? 'FC anomaly check off' : `FC anomaly tolerance ${t} ppm`, Object.assign({}, params, { fcAnomalyTolerancePpm: t }));

    // Readings worth scoring: a previous reading 0.1 to 14 days earlier, within the lookback.
    const candidates: number[] = [];
    let skipped = 0;
    for (let k = 1; k < fc.length; k++) {
        if (fc[k].ts.getTime() < from) continue;
        const days = (fc[k].ts.getTime() - fc[k - 1].ts.getTime()) / 86400000;
        if (days < 0.1 || days > 14 || k < minK) { skipped++; continue; }
        candidates.push(k);
    }
    // error (projected - measured) per variant per reading
    const errors: Map<number, number>[] = variants.map(() => new Map<number, number>());
    for (const k of candidates) {
        for (let v = 0; v < variants.length; v++) {
            try {
                const r = await computeRecommendation(Object.assign({}, variants[v].params, { inFlight: undefined, asOf: new Date(fc[k].ts.getTime() - 60000) }), html, options.localSwgEntries || [], undefined, options.archive);
                if (r.mostRecentFc && r.mostRecentFc.ts === fc[k - 1].ts.toISOString()) errors[v].set(k, r.projectedCurrentFc - fc[k].value);
            }
            catch (err) { /* too little history before this reading */ }
            await yieldToEventLoop();
        }
    }
    const common = candidates.filter(k => errors.every(m => m.has(k)));
    skipped += candidates.length - common.length;

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const round2 = (x: number) => Math.round(x * 100) / 100;
    let seed = 12345; // deterministic bootstrap (mulberry32), so the same data gives the same intervals
    const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const baseAbs = common.map(k => Math.abs(errors[0].get(k)));
    // The settings a variant changes, by their config names, so a result can be applied as is. A taper
    // change always carries both of its days.
    const SETTABLE = ['windowDays', 'creditChlorineAdditions', 'fcAnomalyTolerancePpm', 'projectionWeight', 'projectionTaperStartDays', 'projectionTaperEndDays'];
    const settingsOf = (p: AutoSwgParams): { [setting: string]: number | boolean } | undefined => {
        const diff: { [setting: string]: number | boolean } = {};
        for (const k of SETTABLE) if ((p as any)[k] !== (params as any)[k] && typeof (p as any)[k] !== 'undefined') diff[k] = (p as any)[k];
        if (typeof diff.projectionTaperEndDays !== 'undefined' && typeof diff.projectionTaperStartDays === 'undefined') diff.projectionTaperStartDays = typeof p.projectionTaperStartDays === 'number' ? p.projectionTaperStartDays : 3;
        return Object.keys(diff).length ? diff : undefined;
    };
    const out: WhatIfVariant[] = variants.map((v, i) => {
        const e = common.map(k => errors[i].get(k));
        const row: WhatIfVariant = { key: v.key, label: v.label, count: e.length, verdict: 'current', settings: i > 0 ? settingsOf(v.params) : undefined };
        if (!e.length) return row;
        row.meanAbsError = round2(mean(e.map(Math.abs)));
        row.rmse = round2(Math.sqrt(mean(e.map(x => x * x))));
        row.bias = round2(mean(e));
        if (i > 0 && e.length >= 5) {
            const d = e.map((x, j) => Math.abs(x) - baseAbs[j]);
            const boots: number[] = [];
            for (let b = 0; b < 2000; b++) { let sum = 0; for (let j = 0; j < d.length; j++) sum += d[Math.floor(rand() * d.length)]; boots.push(sum / d.length); }
            boots.sort((a, b) => a - b);
            row.diff = round2(mean(d)); row.diffLow = round2(boots[100]); row.diffHigh = round2(boots[1899]);
            row.verdict = boots[1899] < 0 ? 'better' : (boots[100] > 0 ? 'worse' : 'no clear difference');
        }
        else if (i > 0) row.verdict = 'no clear difference';
        return row;
    });
    return { count: common.length, skipped, variants: [out[0], ...out.slice(1).sort((a, b) => (typeof a.meanAbsError === 'number' ? a.meanAbsError : Infinity) - (typeof b.meanAbsError === 'number' ? b.meanAbsError : Infinity))] };
}

// The one change a Tune run recommends, if any.
export interface TuneRecommendation {
    kind: 'window' | 'projection' | 'other';
    label: string;
    settings: { [setting: string]: number | boolean };
    currentMae: number;
    expectedMae: number;
    change: number;                      // expected change in mean absolute error (negative = better)
    low: number;                         // 90% range of that change
    high: number;
}

export interface TuneResult {
    status: 'good' | 'recommend' | 'insufficient';
    lookbackDays: number;                // how far back it scored (it widens when the last year holds too few readings)
    widened: boolean;
    readings: number;                    // readings every variant could score
    skipped: number;
    history?: { readings: number; from?: string; archived: number };
    meanAbsError?: number;               // with the current settings
    unchangedMae?: number;               // the no-model baseline "FC unchanged since the last reading"
    skill?: number;
    sinceChange?: { since: string; count: number; meanAbsError?: number; unchangedMae?: number; bias?: number };
    betterCount: number;                 // how many alternatives were clearly better
    recommendation?: TuneRecommendation;
}

// A guided version of the two reports: fetch the PoolMath page once, score the current settings and the
// alternatives, and boil it down to ONE recommendation. If a different averaging window is clearly better it comes
// first (the window interacts with the weighting and taper, so those are judged after it is applied); otherwise the
// best clearly-better alternative; otherwise the settings are fine. Fewer than 15 readings is too few to tune on.
export async function buildTune(params: AutoSwgParams, options: { lookbackDays: number; html?: string; localSwgEntries?: LocalSwgEntry[]; historyRecords?: any[]; tuningChangedAt?: string; archive?: ArchivedHistory }): Promise<TuneResult> {
    const html = options.html || await fetchHtml(params.shareCode);
    const score = async (days: number) => ({
        accuracy: await buildProjectionAccuracy(params, Object.assign({}, options, { html, lookbackDays: days })),
        sweep: await buildWhatIfSweep(params, { lookbackDays: days, html, localSwgEntries: options.localSwgEntries, archive: options.archive }),
    });
    let lookbackDays = options.lookbackDays;
    let { accuracy, sweep } = await score(lookbackDays);
    // A sparse pool can have too few readings in the last year to tune on; look back further (the whole history) then.
    if (sweep.count < 30 && lookbackDays < 3650) {
        const wider = await score(3650);
        if (wider.sweep.count > sweep.count) { accuracy = wider.accuracy; sweep = wider.sweep; lookbackDays = 3650; }
    }
    const cur = sweep.variants[0];
    const result: TuneResult = {
        status: 'good', lookbackDays, widened: lookbackDays > options.lookbackDays, readings: sweep.count, skipped: sweep.skipped, history: accuracy.history,
        meanAbsError: cur ? cur.meanAbsError : undefined,
        unchangedMae: accuracy.summary.unchangedMae, skill: accuracy.summary.skill, sinceChange: accuracy.summary.sinceChange,
        betterCount: 0,
    };
    if (sweep.count < 15 || !cur || typeof cur.meanAbsError !== 'number') { result.status = 'insufficient'; return result; }
    const better = sweep.variants.filter(v => v.verdict === 'better' && v.settings && Object.keys(v.settings).length > 0);
    result.betterCount = better.length;
    if (!better.length) return result;
    const keysOf = (v: WhatIfVariant) => Object.keys(v.settings as object);
    const windowRows = better.filter(v => keysOf(v).length === 1 && keysOf(v)[0] === 'windowDays');
    const pool = windowRows.length ? windowRows : better;
    const best = pool.slice().sort((a, b) => (a.meanAbsError as number) - (b.meanAbsError as number))[0];
    const kind: 'window' | 'projection' | 'other' = windowRows.length ? 'window' : (keysOf(best).every(k => k.indexOf('projection') === 0) ? 'projection' : 'other');
    result.status = 'recommend';
    result.recommendation = {
        kind, label: best.label, settings: best.settings as { [setting: string]: number | boolean },
        currentMae: cur.meanAbsError, expectedMae: best.meanAbsError as number,
        change: best.diff as number, low: best.diffLow as number, high: best.diffHigh as number,
    };
    return result;
}

function swgEventsToEntries(events: SwgEvent[]): CombinedHistoryEntry[] {
    return events.map(e => ({ ts: e.ts.toISOString(), type: 'SWG' as const, source: e.source, pct: e.pct, ppmPerDay: e.ppmPerDay, hrs: e.hrs, record: e.record }));
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
