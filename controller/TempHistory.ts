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

// A rolling record of each body's water temperature for the last 24 hours, kept so the average can be shown on the
// dashboard (BodyTempState.avgTemp24h). One sample is kept per body per minute, and the record is saved to
// data/tempHistory.json (next to poolConfig.json) at most every five minutes and when the process exits, so a restart
// does not start the average over. Readings in the file are in the units they were taken in, so the average is off
// for up to a day after the temperature units are changed.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SAMPLE_MS = 60 * 1000;
const SAVE_MS = 5 * 60 * 1000;

interface TempSample { t: number; v: number; }

class TempHistory {
    private samples: { [bodyId: number]: TempSample[] } = {};
    private loaded: boolean = false;
    private dirty: boolean = false;
    private lastSave: number = 0;
    constructor() {
        process.on('exit', () => { try { this.save(Date.now()); } catch (err) { /* nothing more can be done at exit */ } });
    }
    private file(): string { return path.join(process.cwd(), 'data', 'tempHistory.json'); }
    private load() {
        this.loaded = true;
        try {
            const f = this.file();
            if (!fs.existsSync(f)) return;
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            const cutoff = Date.now() - WINDOW_MS;
            for (const id of Object.keys(data || {})) {
                const arr: any[] = Array.isArray(data[id]) ? data[id] : [];
                this.samples[parseInt(id, 10)] = arr.filter(s => s && typeof s.t === 'number' && typeof s.v === 'number' && isFinite(s.v) && s.t >= cutoff);
            }
        } catch (err) { logger.warn(`Could not read the temperature history: ${err.message}`); }
    }
    private save(now: number) {
        if (!this.dirty) return;
        try {
            const f = this.file();
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.samples), 'utf8');
            fs.renameSync(tmp, f);
            this.dirty = false;
            this.lastSave = now;
        } catch (err) { logger.warn(`Could not save the temperature history: ${err.message}`); this.lastSave = now; }
    }
    // Adds a reading for a body (at most one a minute is kept) and drops anything older than 24 hours.
    public record(bodyId: number, temp: number, now: number = Date.now()) {
        if (!this.loaded) this.load();
        const arr = this.samples[bodyId] || (this.samples[bodyId] = []);
        const last = arr[arr.length - 1];
        if (typeof last === 'undefined' || now - last.t >= SAMPLE_MS) {
            arr.push({ t: now, v: temp });
            const cutoff = now - WINDOW_MS;
            while (arr.length > 0 && arr[0].t < cutoff) arr.shift();
            this.dirty = true;
        }
        if (this.dirty && now - this.lastSave >= SAVE_MS) this.save(now);
    }
    // The mean of the readings in the last 24 hours, to a tenth of a degree, or undefined when there are none.
    public average(bodyId: number, now: number = Date.now()): number | undefined {
        const arr = this.samples[bodyId];
        if (typeof arr === 'undefined') return undefined;
        const cutoff = now - WINDOW_MS;
        let sum = 0, count = 0;
        for (let i = 0; i < arr.length; i++) if (arr[i].t >= cutoff) { sum += arr[i].v; count++; }
        return count > 0 ? Math.round((sum / count) * 10) / 10 : undefined;
    }
    // How many hours of readings the average covers (up to 24), to a tenth, so a short record is not mistaken for a full day.
    public hours(bodyId: number, now: number = Date.now()): number | undefined {
        const arr = this.samples[bodyId];
        if (typeof arr === 'undefined' || arr.length === 0) return undefined;
        const first = arr.find(s => s.t >= now - WINDOW_MS);
        if (typeof first === 'undefined') return undefined;
        return Math.round(Math.min(24, (now - first.t) / 3600000) * 10) / 10;
    }
}
export const tempHistory = new TempHistory();
