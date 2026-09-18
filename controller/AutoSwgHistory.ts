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

// Persistent log of SWG % changes on the AutoSwg chlorinator. A record is written
// (a) each time a recommendation is applied, capturing the inputs and outputs of
// the calculation behind it, and (b) each time the pool setpoint is changed some
// other way (API, socket, MQTT, the panel), with just the capacity inputs needed
// to interpret it. AutoSwgService merges these records with PoolMath's SWG log
// entries and prefers the local ones (see mergeSwgEvents there), so the
// calculation reflects what was actually set even if the change was never logged
// on PoolMath.
//
// Stored as a JSON array in data/autoSwgHistory.json (next to poolConfig.json,
// which -- unlike the logs/ folder -- is not rotated away). Records older than
// AUTO_SWG_HISTORY_MONTHS are pruned each time a record is added.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';
import type { LocalSwgEntry } from './AutoSwgService';

export const AUTO_SWG_HISTORY_MONTHS = 18;

export interface AutoSwgHistoryRecord {
    source: 'auto' | 'manual'; // 'auto' = applied via AutoSwg; 'manual' = changed some other way
    appliedAt: string;        // ISO time the setpoint was sent (auto) or the change was detected (manual)
    appliedPct: number;       // the SWG % now in effect
    recommendedPct?: number;  // auto only: what the calculation recommended (differs from appliedPct if overridden)
    previousPct?: number;     // the SWG % before this change
    ppmPerDay?: number;       // appliedPct x window capacity; PoolMath-style "X ppm FC" equivalent
    hrs?: number;             // run-window length used for ppmPerDay
    inputs?: any;             // the calculation's parameters (auto) or the capacity inputs (manual)
    outputs?: any;            // auto only: the calculation's results as of apply (see AutoSwgState)
}

function historyPath(): string { return path.join(process.cwd(), 'data', 'autoSwgHistory.json'); }

export function readAutoSwgHistory(): AutoSwgHistoryRecord[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`AutoSwg: could not read ${historyPath()}: ${err.message}`);
        return [];
    }
}

function pruneOld(records: AutoSwgHistoryRecord[], now: Date): AutoSwgHistoryRecord[] {
    const cutoff = new Date(now.getTime());
    cutoff.setMonth(cutoff.getMonth() - AUTO_SWG_HISTORY_MONTHS);
    return records.filter(r => {
        const t = new Date(r.appliedAt).getTime();
        return !isNaN(t) && t >= cutoff.getTime();
    });
}

// Appends `record`, drops anything older than AUTO_SWG_HISTORY_MONTHS, and writes
// the file via a temp file + rename so a crash can't leave it truncated.
export function appendAutoSwgHistory(record: AutoSwgHistoryRecord): AutoSwgHistoryRecord[] {
    const records = pruneOld([...readAutoSwgHistory(), record], new Date());
    const file = historyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return records;
}

// The records that carry enough data to stand in for a PoolMath SWG log entry.
export function toLocalSwgEntries(records: AutoSwgHistoryRecord[]): LocalSwgEntry[] {
    const entries: LocalSwgEntry[] = [];
    for (const r of records) {
        if (typeof r.ppmPerDay !== 'number' || typeof r.hrs !== 'number' || typeof r.appliedPct !== 'number') continue;
        entries.push({ ts: r.appliedAt, ppmPerDay: r.ppmPerDay, hrs: r.hrs, pct: r.appliedPct, kind: r.source === 'manual' ? 'manual' : 'auto', record: r });
    }
    return entries;
}
