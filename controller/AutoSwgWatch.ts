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

// What to tell someone looking at the dashboard while away: the ways the SWG can fail to hold FC that no recommendation can fix. It looks only at
// state njsPC already has (the chlorinator's status and output, the schedule's run window, the AutoSwg checks and the pending step) and shows them
// as alerts in the AutoSwg area of the dashboard (state.autoSwg.alerts). It changes nothing. Nothing leaves the controller: texts and email need a
// service outside njsPC (the dashboard alert is what is there for now).
//
// A chlorinator that loses power or flow when the pump stops is normal at night, so the chlorinator is judged only inside the SWG's daily run
// window (after a short start-up allowance), and a status or an output of zero must last before it is called an alert.

export interface AutoSwgAlert { id: string; level: 'alarm' | 'warning'; text: string; since: string; }

export interface AutoSwgWatchInput {
    now: number;
    inRunWindow: boolean;                 // inside the SWG's run window, after the start-up allowance
    chlorinator?: { status: number; statusDesc: string; currentOutput: number; setpoint: number; powered?: boolean; commAgeSec?: number };
    autoCheckEnabled: boolean;
    autoCheckHours: number;
    lastCheckedAt?: string;
    checkError?: string;
    stepAt?: string;
    outages?: { from: string; to: string; minutes: number; rebooted?: boolean }[];   // times njsPC was not running (state.autoSwg.outages)
    tempsUnchangedMs?: number;            // how long none of the air, water or solar temperatures has changed (only for sensors that report fractions)
    runWindow?: { start: string; stop: string; scheduleNote?: string };   // the daily SWG run window AutoSwg works from ('HH:MM'), and how it was found
}

// Chlorinator statuses (the chlorinatorStatus value map): 0 ok, 1 low flow, 2 low salt, 3 very low salt, 4 high current, 5 clean cell, 6 low voltage,
// 7 water temp low, 8 communication lost. The ones that stop chlorine being made are alarms; the ones that cut it down are warnings.
const STATUS_WARNING_ONLY = [2, 5, 7];
export const WATCH_STATUS_MIN = 30 * 60 * 1000;       // a bad status must last this long inside the run window
export const WATCH_SILENT_MS = 5 * 60 * 1000;        // a chlorinator that should have power (its body is on) and has not answered for this long
export const WATCH_WINDOW_MAX_H = 16;               // a daily SWG run window longer than this is almost certainly a mis-set schedule
export const WATCH_WINDOW_MIN_H = 1;                // so is one shorter than this
export const WATCH_NO_OUTPUT_MIN = 45 * 60 * 1000;    // so must an output of zero while a % is set
export const WATCH_STEP_OVERDUE_MS = 30 * 60 * 1000;
export const WATCH_OUTAGE_SHOWN_MS = 7 * 86400000;    // an outage stays on the dashboard this long
export const WATCH_TEMPS_FROZEN_MS = 15 * 60 * 1000;  // no air, water or solar temperature has changed for this long (sensors read to a fraction of a degree change every minute or so)

// The minutes after local midnight in `timeZone`.
export function minutesOfDayIn(timeZone: string, now: number): number {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' } as any).formatToParts(new Date(now));
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24, m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return h * 60 + m;
}

// Whether `now` is inside the run window ('HH:MM' to 'HH:MM', which may run past midnight), starting `allowanceMin` minutes after it opens.
export function inRunWindow(startTime: string, stopTime: string, timeZone: string, now: number, allowanceMin: number = 20): boolean {
    const toMin = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN; };
    const a = toMin(startTime), b = toMin(stopTime);
    if (isNaN(a) || isNaN(b)) return false;
    const t = minutesOfDayIn(timeZone, now), from = a + allowanceMin;
    return b > a ? (t >= from && t < b) : (t >= from || t < b);
}

export class AutoSwgWatch {
    private since: { [id: string]: number } = {};
    // Evaluates the input and returns the alerts that hold now, each with when it was first seen (a condition that clears and comes back starts over).
    public evaluate(i: AutoSwgWatchInput): AutoSwgAlert[] {
        const found: { id: string; level: 'alarm' | 'warning'; text: string; minMs: number; since?: string }[] = [];
        const c = i.chlorinator;
        // Every figure AutoSwg produces (daily capacity, run periods, deadlines) rests on the SWG run window, which it reads from the SWG schedule. A start
        // or end set against the wrong sun event, or an offset the wrong way round, gives a window that is far too long or too short (a start after sunset
        // with an end before it runs about 20 hours) and silently skews the calculation; a missing or disabled schedule means the typed-in times are used.
        const w = i.runWindow;
        if (w) {
            const toMin = (s: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN; };
            const a = toMin(w.start), b = toMin(w.stop);
            if (!isNaN(a) && !isNaN(b)) {
                const hours = (b > a ? b - a : 1440 - a + b) / 60;
                if (hours > WATCH_WINDOW_MAX_H || hours < WATCH_WINDOW_MIN_H) {
                    found.push({ id: 'swg-window', level: 'warning', minMs: 0,
                        text: `The SWG run window AutoSwg is using is ${w.start} to ${w.stop}, ${hours.toFixed(1)} hours a day, which does not look right. Check the SWG schedule's start and end (the sun event, such as sunrise for the start and sunset for the end, and the offsets). The run periods, daily capacity and deadlines all depend on this window.` });
                }
            }
            if (w.scheduleNote && /^Configured schedule/.test(w.scheduleNote)) {
                found.push({ id: 'swg-window-schedule', level: 'warning', minMs: 0,
                    text: `AutoSwg cannot use the SWG schedule it is set to follow, so it is working from the typed-in run times ${w.start} to ${w.stop}: ${w.scheduleNote}` });
            }
        }
        // With power on to the SWG it must answer, whatever the time of day: njsPC then cannot control it and it falls back to the % set on the unit itself.
        // This is judged at any hour and quickly (the status alerts below wait 30 minutes and only look inside the run window).
        if (c && c.powered && typeof c.commAgeSec === 'number' && c.commAgeSec * 1000 >= WATCH_SILENT_MS) {
            found.push({ id: 'swg-silent', level: 'alarm', minMs: 0, since: new Date(i.now - c.commAgeSec * 1000).toISOString(),
                text: `The chlorinator has not answered njsPC for ${Math.round(c.commAgeSec / 60)} minutes while it should have power, so njsPC cannot control it and it may be running at the % set on the unit itself.` });
        }
        if (i.inRunWindow && c) {
            if (c.status !== 0 && typeof c.status === 'number') {
                found.push({ id: 'swg-status', level: STATUS_WARNING_ONLY.indexOf(c.status) >= 0 ? 'warning' : 'alarm', minMs: WATCH_STATUS_MIN,
                    text: `The chlorinator reports "${c.statusDesc}" during its run window${c.status === 8 ? ', so njsPC cannot see or control it' : ', so it may not be making the chlorine the SWG % calls for'}.` });
            }
            else if (c.setpoint > 0 && c.currentOutput === 0) {
                found.push({ id: 'swg-no-output', level: 'alarm', minMs: WATCH_NO_OUTPUT_MIN,
                    text: `The SWG is set to ${c.setpoint}% but reports no output during its run window. Check the pump, the flow and the cell.` });
            }
        }
        if (i.autoCheckEnabled && i.lastCheckedAt) {
            const last = new Date(i.lastCheckedAt).getTime();
            const limit = (2 * i.autoCheckHours + 1) * 3600000;
            if (!isNaN(last) && i.now - last > limit) {
                found.push({ id: 'check-stale', level: 'warning', minMs: 0,
                    text: `The automatic PoolMath check has not run for ${Math.round((i.now - last) / 3600000)} hours (it should run every ${i.autoCheckHours} hours), so the SWG % may be out of date.` });
            }
        }
        if (i.checkError) found.push({ id: 'check-error', level: 'warning', minMs: 0, text: `The last AutoSwg check failed: ${i.checkError}` });
        if (i.stepAt) {
            const at = new Date(i.stepAt).getTime();
            if (!isNaN(at) && i.now - at > WATCH_STEP_OVERDUE_MS) {
                found.push({ id: 'step-overdue', level: 'alarm', minMs: 0, text: `The step to the maintenance % that was due ${Math.round((i.now - at) / 60000)} minutes ago has not happened.` });
            }
        }
        // Sensors read to a fraction of a degree (REM) move every minute or so, so all of them reading exactly the same for this long means the
        // readings stopped arriving (the feed from REM, or REM itself), not that nothing changed. Solar heating and the 24 hour average then work from old values.
        if (typeof i.tempsUnchangedMs === 'number' && i.tempsUnchangedMs >= WATCH_TEMPS_FROZEN_MS) {
            found.push({ id: 'temps-frozen', level: 'warning', minMs: 0, since: new Date(i.now - i.tempsUnchangedMs).toISOString(),
                text: `None of the air, water or solar temperatures has changed for ${Math.round(i.tempsUnchangedMs / 60000)} minutes, so njsPC is probably not receiving new readings (check the sensor feed from REM). Solar heating and the 24 hour water average are working from old values.` });
        }
        for (const o of i.outages || []) {
            const to = new Date(o.to).getTime();
            if (isNaN(to) || i.now - to > WATCH_OUTAGE_SHOWN_MS) continue;
            found.push({ id: 'outage-' + o.to, level: 'warning', minMs: 0, since: o.from,
                text: `njsPC was not running for ${o.minutes} minutes, so the pool equipment was off${o.rebooted ? ' and the computer restarted (a power loss or a reboot)' : ''}.` } as any);
        }
        const alerts: AutoSwgAlert[] = [];
        const present = new Set<string>();
        for (const f of found) {
            present.add(f.id);
            if (typeof this.since[f.id] === 'undefined') this.since[f.id] = f.since ? new Date(f.since).getTime() : i.now;
            if (f.since || i.now - this.since[f.id] >= f.minMs) alerts.push({ id: f.id, level: f.level, text: f.text, since: new Date(this.since[f.id]).toISOString() });
        }
        for (const id of Object.keys(this.since)) if (!present.has(id)) delete this.since[id];
        return alerts;
    }
}
