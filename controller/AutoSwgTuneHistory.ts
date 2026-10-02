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

// A short local log of Tune runs (see buildTune in AutoSwgService): when each ran, the tuning settings at the time,
// how many readings it scored and how they did, what it recommended, and whether the recommendation was applied --
// so the results can be compared over time and looked back on. The Projection Accuracy and What-If Sweep reports
// are not recorded; they are computed on demand.
//
// Stored as a JSON array in data/autoSwgTuneHistory.json (next to poolConfig.json), newest last, keeping the most
// recent AUTO_SWG_TUNE_HISTORY_MAX records.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/Logger';

export const AUTO_SWG_TUNE_HISTORY_MAX = 20;

export interface TuneHistoryRecord {
    ts: string;                                        // when Tune ran
    settings: { [setting: string]: number | boolean }; // the tuning settings in force when it ran
    readings: number;                                  // FC readings it scored
    history?: { readings: number; from?: string; archived: number };
    meanAbsError?: number;                             // with those settings
    unchangedMae?: number;                             // the "FC unchanged" baseline over the same readings
    skill?: number;
    status: 'good' | 'recommend' | 'insufficient';
    recommendation?: { kind: string; label: string; settings: { [setting: string]: number | boolean }; expectedMae: number; change: number; low: number; high: number };
    applied?: { at: string };                          // set when the recommendation was applied from the Tune dialog
    manualChangeSinceLastTune?: boolean;               // the settings had been changed by hand since the previous Tune
    readingsSinceLastTune?: number;                    // FC readings that had arrived since the previous Tune (when known)
}

function historyPath(): string { return path.join(process.cwd(), 'data', 'autoSwgTuneHistory.json'); }

export function readTuneHistory(): TuneHistoryRecord[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
        if (err && err.code !== 'ENOENT') logger.warn(`AutoSwg: could not read ${historyPath()}: ${err.message}`);
        return [];
    }
}

function writeTuneHistory(records: TuneHistoryRecord[]) {
    const file = historyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

// Appends a record and drops all but the most recent AUTO_SWG_TUNE_HISTORY_MAX.
export function appendTuneHistory(record: TuneHistoryRecord): TuneHistoryRecord[] {
    const records = [...readTuneHistory(), record].slice(-AUTO_SWG_TUNE_HISTORY_MAX);
    writeTuneHistory(records);
    return records;
}

// Marks the most recent run as applied (the user pressed Apply on its recommendation).
export function markLastTuneApplied(at: string) {
    const records = readTuneHistory();
    const last = records[records.length - 1];
    if (!last || last.applied || !last.recommendation) return;
    last.applied = { at };
    writeTuneHistory(records);
}
