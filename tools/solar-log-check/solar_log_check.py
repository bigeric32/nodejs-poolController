#!/usr/bin/env python3
"""solar_log_check.py -- analyze an njsPC solar log (logs/solarLog(<time>).log).

A standalone, standard-library-only Python 3.8+ script. With no arguments it finds the newest
solar log in njsPC's logs folder and reports on it; give it a name (or part of one) or a path to
analyze a different file.

    python3 tools/solar-log-check/solar_log_check.py                       newest solar log
    python3 tools/solar-log-check/solar_log_check.py 2026-10-03_12-32-48   a log by part of its name
    python3 tools/solar-log-check/solar_log_check.py "solarLog(2026-10-03_12-32-48).log"
    python3 tools/solar-log-check/solar_log_check.py /some/where/other.log
    python3 tools/solar-log-check/solar_log_check.py --list                the solar logs found
    python3 tools/solar-log-check/solar_log_check.py --timeline            add every run and off period
    python3 tools/solar-log-check/solar_log_check.py --since 13:00         only lines from 13:00 on

It reads the lines njsPC writes with log.solar.logToFile on (and, for the "why not running" and
settle delay lines, log.solar.explain on), and reports:
  - the runs (solar on) and off periods, with the readings at each change and why it stopped;
  - how long solar was held off, split by the reason it logged (at target, collector not warmer,
    run delta, reheat guard, ...), and whether it sat off with the collector well above the water;
  - bursts of repeated commands to the relay manager;
  - water temperature jumps right after the pump starts or solar switches (warm water standing in
    the pipes), and what the settle delays held back.
"""
import argparse
import glob
import os
import re
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timedelta

LINE = re.compile(r'^\[(\d{2}/\d{2}/\d{4}, \d{2}:\d{2}:\d{2})\]\s+(\w+):\s+(.*?)\s*$')
def N(name):
    return r'(?P<%s>-?\d+(?:\.\d+)?)' % name


DECISION = re.compile(
    r'^Solar (?P<heater>.+?) (?P<state>off|heating|cooling) \((?P<body>[^,]+), mode (?P<mode>\w+)\): '
    r'water ' + N('water') + r'(?: \(compared as -?\d+\))?, setpoint ' + N('sp') + r', cool setpoint ' + N('csp') +
    r', solar ' + N('solar') + r', collector minus water ' + N('diff') + r' \(run delta (?P<run>\d+)\), '
    r'collector at last off (?P<lastoff>n/a|-?\d+(?:\.\d+)?), collector minus last off (?:n/a|-?\d+(?:\.\d+)?) \(start delta (?P<start>\d+)\), night (?P<night>true|false)')
NOTRUN = re.compile(
    r'^Solar (?P<heater>.+?) \((?P<body>[^,]+), mode (?P<mode>\w+)\) is not (?P<kind>heating|nocturnal cooling): (?P<why>.*?)\. '
    r'Water ' + N('water') + r', solar ' + N('solar') + r', setpoint ' + N('sp') + r', cool setpoint ' + N('csp') + r', start/run delta (?P<start>\d+)/(?P<run>\d+), night (?P<night>true|false)\.?$')
SWITCH = re.compile(r'^Solar (?P<heater>.+?) \(heater (?P<id>\d+)\): switching (?P<to>on|off|to cooling)$')
CONFIRM = re.compile(r'^Solar (?P<heater>.+?): (?P<to>on|off) command confirmed by the relay manager')
FAILED = re.compile(r'^Solar (?P<heater>.+?): (?P<to>on|off) command FAILED')
OFFWHY = re.compile(r'^Solar (?P<heater>.+?) \((?P<body>[^)]+)\) turned off because (?P<why>.*?)\.$')
SETTLE = re.compile(r'^Solar (?P<heater>.+?) \((?P<body>[^)]+)\) settle delay (?P<what>(?:after|waiting) .*?)(?P<ended> ended)?(?:, (?P<left>\d+) s left of (?P<of>\d+) s)?: '
                    r'water ' + N('water') + r'(?: \(compared as -?\d+\))?, solar ' + N('solar') + r', collector minus water ' + N('diff'))
DEFERRED = re.compile(r'turn-on deferred: (.*)$')
RELAY = re.compile(r'^NCP: Setting Pump .*Relay 2: (on|off)')


def reason_key(why):
    """Reduce the text of a 'not heating' line to a short reason."""
    w = why.lower()
    if 'degree hysteresis' in w:
        return 'hysteresis (water must move back past the target)'
    if 'is not below the setpoint' in w:
        return 'at target (water not below setpoint)'
    if 'not warmer than the water' in w:
        return 'collector not warmer than water'
    if 'above the water and needs' in w:
        return 'collector lead under the run delta'
    if 'last turned off' in w and 'risen' in w:
        return 'reheat guard (collector must climb)'
    if 'daytime' in w:
        return 'cooling: daytime'
    if 'not cooler than the water' in w:
        return 'cooling: collector not cooler'
    if 'warmer than the collector' in w:
        return 'cooling: water lead under the run delta'
    if 'above the cool setpoint' in w:
        return 'cooling: water not far enough above cool setpoint'
    if 'dropped' in w and 'last turned off' in w:
        return 'cooling: reheat guard (collector must drop)'
    return why[:60]


def fmt_dur(sec):
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return '%dh%02dm' % (h, m)
    if m:
        return '%dm%02ds' % (m, s)
    return '%ds' % s


def fmt_t(t):
    return t.strftime('%H:%M:%S')


def logs_dir(arg):
    if arg:
        return arg
    if os.environ.get('NJSPC_LOGS'):
        return os.environ['NJSPC_LOGS']
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(here, '..', '..', 'logs'), os.path.join(os.getcwd(), 'logs'), os.getcwd()):
        cand = os.path.normpath(cand)
        if glob.glob(os.path.join(glob.escape(cand), 'solarLog(*).log')):
            return cand
    return os.path.normpath(os.path.join(here, '..', '..', 'logs'))


def find_logs(d):
    return sorted(glob.glob(os.path.join(glob.escape(d), 'solarLog(*).log')), key=os.path.getmtime)


def resolve(name, d):
    """A path, a file name in the logs folder, or part of a file name."""
    if name is None:
        found = find_logs(d)
        if not found:
            sys.exit('No solarLog(*).log files in %s. Turn on log.solar.logToFile in config.json, or pass a file or --logs-dir.' % d)
        return found[-1]
    if os.path.isfile(name):
        return name
    cand = os.path.join(d, name)
    if os.path.isfile(cand):
        return cand
    hits = [f for f in find_logs(d) if name in os.path.basename(f)]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        sys.exit('"%s" matches more than one log:\n  %s' % (name, '\n  '.join(os.path.basename(h) for h in hits)))
    sys.exit('No log named "%s" (looked at the path, in %s, and for part of a name there).' % (name, d))


def parse(path, since):
    events = []
    with open(path, encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            m = LINE.match(raw.rstrip('\n'))
            if not m:
                continue
            t = datetime.strptime(m.group(1), '%d/%m/%Y, %H:%M:%S')
            if since is not None and t.time() < since and t.date() == (events[0]['t'].date() if events else t.date()):
                continue
            events.append({'t': t, 'level': m.group(2), 'msg': m.group(3)})
    return events


def analyze(events, timeline):
    out = []
    P = out.append
    if not events:
        P('No log lines to analyze.')
        return out
    t0, t1 = events[0]['t'], events[-1]['t']
    span = (t1 - t0).total_seconds()
    P('Log span: %s to %s (%s), %d lines' % (t0.strftime('%d/%m/%Y %H:%M:%S'), t1.strftime('%d/%m/%Y %H:%M:%S'), fmt_dur(span), len(events)))

    decisions, notrun, offwhy, settle = [], [], [], []
    switches, confirms, failures, deferrals = [], [], [], []
    relay = []
    for e in events:
        msg = e['msg']
        m = DECISION.match(msg)
        if m:
            decisions.append(dict(t=e['t'], state=m.group('state'), heater=m.group('heater'), mode=m.group('mode'),
                                  water=float(m.group('water')), setpoint=float(m.group('sp')), cool=float(m.group('csp')),
                                  solar=float(m.group('solar')), diff=float(m.group('diff')), run=int(m.group('run')),
                                  lastoff=None if m.group('lastoff') == 'n/a' else float(m.group('lastoff')),
                                  start=int(m.group('start')), night=m.group('night') == 'true'))
            continue
        m = NOTRUN.match(msg)
        if m:
            notrun.append(dict(t=e['t'], kind=m.group('kind'), why=m.group('why'), key=reason_key(m.group('why')),
                               water=float(m.group('water')), solar=float(m.group('solar')), setpoint=float(m.group('sp')),
                               cool=float(m.group('csp')), start=int(m.group('start')), run=int(m.group('run'))))
            continue
        m = SWITCH.match(msg)
        if m:
            switches.append((e['t'], m.group('to'), m.group('heater')))
            continue
        m = CONFIRM.match(msg)
        if m:
            confirms.append((e['t'], m.group('to'), m.group('heater')))
            continue
        m = FAILED.match(msg)
        if m:
            failures.append((e['t'], m.group('to'), m.group('heater')))
            continue
        m = OFFWHY.match(msg)
        if m:
            offwhy.append((e['t'], m.group('why')))
            continue
        m = SETTLE.match(msg)
        if m:
            settle.append(dict(t=e['t'], what=m.group('what'), ended=bool(m.group('ended')), left=m.group('left'), of=m.group('of'),
                               water=float(m.group('water')), solar=float(m.group('solar')), diff=float(m.group('diff')), text=msg))
            continue
        m = DEFERRED.search(msg)
        if m:
            deferrals.append((e['t'], m.group(1)))
            continue
        m = RELAY.match(msg)
        if m:
            relay.append((e['t'], m.group(1)))

    # ---- runs and off periods, from the decision lines (logged on each change)
    runs, offs = [], []
    cur_on = None
    cur_off_start = None
    last_off_dec = None
    for d in decisions:
        if d['state'] in ('heating', 'cooling'):
            if cur_off_start is not None:
                offs.append(dict(start=cur_off_start, end=d['t'], dec=last_off_dec, next=d))
                cur_off_start = None
            if cur_on is None:
                cur_on = d
        else:
            if cur_on is not None:
                runs.append(dict(start=cur_on['t'], end=d['t'], on=cur_on, off=d))
                cur_on = None
            if cur_off_start is None:
                cur_off_start = d['t']
                last_off_dec = d
    open_run = cur_on
    open_off = (cur_off_start, last_off_dec) if cur_off_start is not None else None

    P('')
    P('== Runs ==')
    if not runs and not open_run:
        P('Solar never turned on in this log.')
    else:
        run_time = sum((r['end'] - r['start']).total_seconds() for r in runs)
        if open_run:
            run_time += (t1 - open_run['t']).total_seconds()
        P('%d completed run(s)%s; solar was on %s of %s (%.0f%%).' % (
            len(runs), ', one still running at the end' if open_run else '', fmt_dur(run_time), fmt_dur(span), 100.0 * run_time / span if span else 0))
        brief = [r for r in runs if (r['end'] - r['start']).total_seconds() < 600]
        if len(brief) >= 3:
            P('  CYCLING: %d run(s) under 10 minutes (%.1f runs an hour). Solar is switching around the setpoint;' % (len(brief), len(runs) * 3600.0 / span if span else 0))
            P('  controller.solar.hysteresis (default 1) makes it stop a degree past the target and restart a degree back.')
        short = [r for r in runs if (r['end'] - r['start']).total_seconds() < 300]
        if short:
            P('  %d run(s) were shorter than 5 minutes: %s' % (len(short), ', '.join('%s (%s)' % (fmt_t(r['start']), fmt_dur((r['end'] - r['start']).total_seconds())) for r in short[:8])))
        if timeline:
            for r in runs:
                P('  on %s -> off %s (%s): water %.1f -> %.1f, collector %.1f -> %.1f, setpoint %g' % (
                    fmt_t(r['start']), fmt_t(r['end']), fmt_dur((r['end'] - r['start']).total_seconds()),
                    r['on']['water'], r['off']['water'], r['on']['solar'], r['off']['solar'], r['on']['setpoint']))
            if open_run:
                P('  on %s -> still on at the end: water %.1f, collector %.1f' % (fmt_t(open_run['t']), open_run['water'], open_run['solar']))
    if offwhy:
        c = Counter('collector lead fell to the run delta' if 'collector lead' in w else 'water stayed past the stop level' for _, w in offwhy)
        P('Why runs stopped (log.solar.explain lines): ' + '; '.join('%s x%d' % (k, v) for k, v in c.items()))

    # ---- off periods
    P('')
    P('== Off periods, by what the log said was holding solar off ==')
    ends = [(o['start'], o['end']) for o in offs]
    if open_off:
        ends.append((open_off[0], t1))
    reason_time = Counter()
    unexplained = 0.0
    stuck = []
    for (s, e) in ends:
        evs = [n for n in notrun if s <= n['t'] <= e]
        if not evs:
            unexplained += (e - s).total_seconds()
            continue
        unexplained += (evs[0]['t'] - s).total_seconds()
        for i, n in enumerate(evs):
            until = evs[i + 1]['t'] if i + 1 < len(evs) else e
            sec = (until - n['t']).total_seconds()
            reason_time[n['key']] += sec
            if n['key'].startswith('reheat') and n['solar'] - n['water'] >= 10 and n['water'] < n['setpoint']:
                stuck.append((n, sec))
    if not ends:
        P('No off periods recorded.')
    else:
        total_off = sum((e - s).total_seconds() for s, e in ends)
        P('%d off period(s), %s in all.' % (len(ends), fmt_dur(total_off)))
        for k, v in reason_time.most_common():
            P('  %-52s %s' % (k, fmt_dur(v)))
        if unexplained >= 1:
            P('  %-52s %s' % ('(no reason logged: turn on log.solar.explain)', fmt_dur(unexplained)))
        if stuck:
            tot = sum(sec for _, sec in stuck)
            lead = max(n['solar'] - n['water'] for n, _ in stuck)
            P('')
            P('  ATTENTION: for %s the reheat guard kept solar off while the water was below the setpoint and the collector was' % fmt_dur(tot))
            P('  at least 10 degrees above it (up to %.1f). First at %s, last at %s.' % (lead, fmt_t(stuck[0][0]['t']), fmt_t(stuck[-1][0]['t'])))
    if timeline:
        for o in offs:
            P('  off %s -> on %s (%s)' % (fmt_t(o['start']), fmt_t(o['end']), fmt_dur((o['end'] - o['start']).total_seconds())))
        if open_off:
            P('  off %s -> still off at the end (%s)' % (fmt_t(open_off[0]), fmt_dur((t1 - open_off[0]).total_seconds())))

    # ---- command bursts
    P('')
    P('== Commands to the relay manager ==')
    P('%d "switching" line(s), %d confirmed, %d FAILED.' % (len(switches), len(confirms), len(failures)))
    bursts = []
    by_sec = OrderedDict()
    for (t, to, h) in switches:
        by_sec.setdefault((t, to), 0)
        by_sec[(t, to)] += 1
    for (t, to), n in by_sec.items():
        if n > 1:
            bursts.append((t, to, n))
    if bursts:
        mx = max(b[2] for b in bursts)
        P('  %d change(s) were sent more than once in the same second (up to %d times): %s' % (
            len(bursts), mx, ', '.join('%s %s x%d' % (fmt_t(t), to, n) for t, to, n in bursts[:8])))
        P('  One command per change is enough: each repeat is another relay write (see rstrouse/relayEquipmentManager#126).')
    else:
        P('  No repeated commands within a second.')
    for t, why in deferrals[:5]:
        P('  deferred at %s: %s' % (fmt_t(t), why))

    # ---- water jumps
    P('')
    P('== Water temperature jumps ==')
    samples = [(d['t'], d['water']) for d in decisions] + [(n['t'], n['water']) for n in notrun] + [(s['t'], s['water']) for s in settle]
    samples.sort(key=lambda x: x[0])
    jumps = []
    for (ta, wa), (tb, wb) in zip(samples, samples[1:]):
        dt = (tb - ta).total_seconds()
        if 0 < dt <= 90 and abs(wb - wa) >= 1.0:
            jumps.append((ta, tb, wa, wb))
    if jumps:
        P('%d jump(s) of 1 degree or more within 90 seconds (warm or cool water standing in the pipes reaching the sensor):' % len(jumps))
        for ta, tb, wa, wb in sorted(jumps, key=lambda j: -abs(j[3] - j[2]))[:8]:
            P('  %s -> %s: %.2f -> %.2f (%+.2f)' % (fmt_t(ta), fmt_t(tb), wa, wb, wb - wa))
    else:
        P('None of 1 degree or more within 90 seconds.')
    if samples:
        ws = [w for _, w in samples]
        P('Water over the log: %.2f to %.2f (first %.2f, last %.2f).' % (min(ws), max(ws), ws[0], ws[-1]))

    # ---- settle delays
    P('')
    P('== Settle delays ==')
    if not settle:
        P('No settle delay lines (they need log.solar.explain on and controller.solar.settleMinutes above 0).')
    else:
        held = [s for s in settle if not s['ended']]
        kinds = Counter(s['what'] for s in held)
        P('%d delay line(s): %s' % (len(held), '; '.join('%s x%d' % (k, v) for k, v in kinds.items())))
        flips = 0
        for s in held:
            on_now = 'solar would be on' in s['text']
            if s['what'].startswith('waiting to stop') and not on_now:
                flips += 1       # without the delay solar would have stopped
        starts = sum(1 for s in held if not s['what'].startswith('waiting to stop') and 'solar would be on' in s['text'])
        P('  held a start that the readings called for: %d line(s); held a stop that the readings called for: %d line(s).' % (starts, flips))
        if timeline:
            for s in settle:
                P('  %s %s: water %.2f, collector %.1f, collector minus water %.1f%s' % (
                    fmt_t(s['t']), s['what'] + (' ended' if s['ended'] else ''), s['water'], s['solar'], s['diff'],
                    '' if s['ended'] else ', %s s left' % s['left']))
    if relay:
        P('')
        P('Pump relay 2 changed %d time(s).' % len(relay))
    return out


def main():
    ap = argparse.ArgumentParser(description='Analyze an njsPC solar log.')
    ap.add_argument('file', nargs='?', help='a path, a file name in the logs folder, or part of a name (default: the newest solarLog(*).log)')
    ap.add_argument('--logs-dir', help="njsPC's logs folder (default: ../../logs from this script, ./logs, or $NJSPC_LOGS)")
    ap.add_argument('--list', action='store_true', help='list the solar logs found and stop')
    ap.add_argument('--timeline', action='store_true', help='also list every run, off period and settle delay line')
    ap.add_argument('--since', help='only lines at or after HH:MM (of the first day in the log)')
    args = ap.parse_args()
    d = logs_dir(args.logs_dir)
    if args.list:
        found = find_logs(d)
        if not found:
            sys.exit('No solarLog(*).log files in %s' % d)
        for f in found:
            print('%s  %8d bytes  %s' % (datetime.fromtimestamp(os.path.getmtime(f)).strftime('%Y-%m-%d %H:%M'), os.path.getsize(f), os.path.basename(f)))
        return
    path = resolve(args.file, d)
    since = None
    if args.since:
        try:
            since = datetime.strptime(args.since, '%H:%M').time()
        except ValueError:
            sys.exit('--since wants HH:MM, for example 13:00')
    print('Analyzing %s' % path)
    print('\n'.join(analyze(parse(path, since), args.timeline)))


if __name__ == '__main__':
    main()
