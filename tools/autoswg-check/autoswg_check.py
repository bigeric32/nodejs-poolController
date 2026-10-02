#!/usr/bin/env python3
"""autoswg_check.py -- check the AutoSwg algorithm against a pool's PoolMath history.

A standalone, standard-library-only Python 3.8+ script. Give it a PoolMath share code (or a saved
JSON file) and it re-runs a port of njsPC's AutoSwg calculation over the pool's FC readings,
SWG entries and liquid chlorine additions to answer: how well would the algorithm have
predicted each FC reading, and which settings (averaging window, daylight weighting, chlorine
credit, anomaly tolerance) would have done better?

It is an approximation-by-port of controller/AutoSwgService.ts, so run it on a pool you also have
in njsPC and compare with the app's Projection Accuracy / What-If dialogs to confirm they agree.

Examples
  python autoswg_check.py tfp-123456 --tz America/New_York --lat 40.7 --lon -74.0
  python autoswg_check.py --json saved.json --report whatif --csv out/

PoolMath's share endpoint is undocumented and rate limited (about one request a minute): this makes
one request per run and caches a sanitized copy (numbers and timestamps only: no names beyond the
pool's display name, no addresses, contacts or notes). Only use data from pools whose owners have
agreed. https://api.poolmathapp.com/share/<code>.json?recentLogs=N
"""
import argparse
import collections
import csv
import json
import math
import os
import random
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

DAY = 86400.0
POOLMATH_SWG_CHEMICAL = 27       # an SWG run: runTime hours, percent, amount (ppm FC)
POOLMATH_LIQUID_CHLORINE = 0     # percent strength, normalizedAmount in mL
MIN_FC_READINGS_IN_WINDOW = 3
ML_PER_GAL = 3785.411784


# --------------------------------------------------------------------------- time zones
def get_tz(name, utc_offset):
    if name:
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(name)
        except Exception as e:  # no zoneinfo, or no tz database (Windows needs `pip install tzdata`)
            print('warning: could not load time zone %r (%s); falling back to --utc-offset/UTC' % (name, e), file=sys.stderr)
    return timezone(timedelta(hours=utc_offset or 0.0))


def local_minute_of_day(dt, tz):
    l = dt.astimezone(tz)
    return l.hour * 60 + l.minute + l.second / 60.0


# --------------------------------------------------------------------------- fetch + sanitize
def parse_ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')) if s.endswith('Z') else datetime.fromisoformat(s)


def http_get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (autoswg-check)'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, b'', e.headers


def fetch_share(code_or_url):
    base = code_or_url if code_or_url.startswith('http') else 'https://api.poolmathapp.com/share/' + code_or_url
    base = base.split('?')[0]
    if not base.endswith('.json'):
        base += '.json'
    sizes = (5000, 1000, 250)
    for i, size in enumerate(sizes):
        status, body = 0, b''
        for attempt in range(4):
            status, body, headers = http_get('%s?recentLogs=%d' % (base, size))
            if status != 429:
                break
            if attempt == 3:  # out of retries: say so now instead of waiting one more time
                sys.exit('PoolMath is still rate limiting after several waits; try again in a few minutes '
                         '(a cached copy avoids new requests).')
            wait = int(headers.get('Retry-After') or 70) + 5
            print('PoolMath is rate limiting; waiting %ds ...' % wait, file=sys.stderr)
            time.sleep(wait)
        if status in (400, 413, 422):  # that many logs wasn't accepted: try fewer, but not straight away
            if i < len(sizes) - 1:
                print('PoolMath rejected recentLogs=%d; trying %d after a pause ...' % (size, sizes[i + 1]), file=sys.stderr)
                time.sleep(65)  # PoolMath allows about one request a minute
            continue
        if status != 200:
            sys.exit('PoolMath returned HTTP %d' % status)
        return json.loads(body)
    sys.exit('PoolMath did not accept any recentLogs size')


def sanitize(raw):
    """Keep only numbers and timestamps: drop contact fields, address, notes, ids and weather text."""
    out = {'pools': []}
    for p in raw.get('pools', []):
        pool = p.get('pool', {})
        logs = []
        for l in p.get('recentLogs', []):
            if l.get('deleted'):
                continue
            keep = {'type': l.get('type'), 'logTimestamp': l.get('logTimestamp')}
            for k in ('fc', 'cc', 'cya', 'ph', 'ta', 'ch', 'salt', 'waterTemp', 'chemical', 'runTime', 'percent', 'unit', 'amount', 'normalizedAmount'):
                if isinstance(l.get(k), (int, float)):
                    keep[k] = l[k]
            for k in ('weather_uvIndex', 'weather_cloudCover'):
                if isinstance(l.get(k), (int, float)):
                    keep[k] = l[k]
            w = l.get('weather') or {}
            for k in ('uvIndex', 'cloudCover'):
                if isinstance(w.get(k), (int, float)):
                    keep['weather_' + k] = w[k]
            logs.append(keep)
        out['pools'].append({
            'pool': {'name': pool.get('name'), 'volume': pool.get('volume'),
                     'lat': round(pool['lat'], 1) if isinstance(pool.get('lat'), (int, float)) else None,
                     'lon': round(pool['lon'], 1) if isinstance(pool.get('lon'), (int, float)) else None},
            'recentLogs': logs})
    return out


def load_data(args):
    if args.json:
        data = sanitize(json.load(open(args.json, encoding='utf-8')))
    else:
        if not args.share:
            sys.exit('give a share code/URL or --json FILE')
        os.makedirs(args.cache, exist_ok=True)
        key = re.sub(r'[^A-Za-z0-9_-]+', '_', args.share.split('/')[-1].replace('.json', ''))
        path = os.path.join(args.cache, key + '.json')
        if os.path.exists(path) and not args.refresh:
            data = json.load(open(path, encoding='utf-8'))
            print('using cached data %s (use --refresh to re-fetch)' % path, file=sys.stderr)
        else:
            data = sanitize(fetch_share(args.share))
            json.dump(data, open(path, 'w', encoding='utf-8'))
            print('fetched and cached %s' % path, file=sys.stderr)
    pools = data.get('pools', [])
    if not pools:
        sys.exit('no pools in the data')
    pick = pools[0]
    if args.pool:
        want = args.pool.lower()
        match = [p for p in pools if str(p['pool'].get('name') or '').lower() == want] or \
                [p for p in pools if want in str(p['pool'].get('name') or '').lower()]
        if not match:
            sys.exit('pool %r not found; pools: %s' % (args.pool, [p['pool'].get('name') for p in pools]))
        pick = match[0]
    return pick


# --------------------------------------------------------------------------- dataset
class Dataset:
    def __init__(self, pool, args):
        logs = [l for l in pool['recentLogs'] if l.get('logTimestamp')]
        ts = lambda l: parse_ts(l['logTimestamp'])
        tests = sorted([l for l in logs if l['type'] == 'testlog'], key=ts)
        self.fc = [(ts(l), l['fc']) for l in tests if isinstance(l.get('fc'), (int, float))]
        self.cya = [(ts(l), l['cya']) for l in tests if isinstance(l.get('cya'), (int, float))]
        self.swg = sorted([(ts(l), l['amount'], l['runTime'], l['percent']) for l in logs
                           if l['type'] == 'chemlog' and l.get('chemical') == POOLMATH_SWG_CHEMICAL
                           and 'amount' in l and 'runTime' in l and 'percent' in l], key=lambda x: x[0])
        self.gallons = args.gallons or pool['pool'].get('volume') or 12000
        self.adds = sorted([(ts(l), (l['percent'] / 100.0) * 1e6 * l['normalizedAmount'] / (self.gallons * ML_PER_GAL))
                            for l in logs if l['type'] == 'chemlog' and l.get('chemical') == POOLMATH_LIQUID_CHLORINE
                            and l.get('percent') and l.get('normalizedAmount')], key=lambda x: x[0])
        self.lat = args.lat if args.lat is not None else pool['pool'].get('lat')
        self.lon = args.lon if args.lon is not None else pool['pool'].get('lon')

    def first_covered_index(self):
        """Index of the first FC reading at/after the first SWG entry (earlier intervals have no SWG record)."""
        if not self.swg:
            return len(self.fc)
        first = self.swg[0][0]
        for i, (t, _) in enumerate(self.fc):
            if t >= first:
                return i
        return len(self.fc)


# --------------------------------------------------------------------------- port of the calculation
class Params:
    def __init__(self, **kw):
        self.window_days = 21
        self.tolerance = 2.0
        self.credit = True
        self.daylight = True
        self.daytime_share_pct = 0
        self.swg_start = 8 * 60          # run window start, minutes after local midnight
        self.tz = timezone.utc
        self.today = datetime.now(timezone.utc)
        self.__dict__.update(kw)

    def copy(self, **kw):
        p = Params(**self.__dict__)
        p.__dict__.update(kw)
        return p


def parabolic_share(day_hours):
    h = max(0.0, min(12.0, day_hours / 2.0))
    return (2 * h - h ** 3 / 216.0) / 16.0


def sun_minutes(date, lat, lon, tz):
    """Local sunrise/sunset minutes after midnight for `date` (NOAA algorithm), or None."""
    n = date.timetuple().tm_yday
    g = 2 * math.pi / 365 * (n - 1)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    la = math.radians(lat)
    c = math.cos(math.radians(90.833)) / (math.cos(la) * math.cos(decl)) - math.tan(la) * math.tan(decl)
    if c < -1 or c > 1:
        return None
    ha = math.degrees(math.acos(c))
    off = (datetime(date.year, date.month, date.day, 12, tzinfo=tz).utcoffset() or timedelta(0)).total_seconds() / 60.0
    sunrise = 720 - 4 * (lon + ha) - eqtime + off
    sunset = 720 - 4 * (lon - ha) - eqtime + off
    return sunrise % 1440, sunset % 1440


class Calc:
    """The calculation for one dataset and parameter set."""

    def __init__(self, ds, p):
        self.ds, self.p = ds, p
        self.daylight = None
        if p.daylight and ds.lat is not None and ds.lon is not None:
            sm = sun_minutes(p.today.astimezone(p.tz).date(), ds.lat, ds.lon, p.tz)
            if sm and 0 < sm[1] - sm[0] < 1440:
                share = parabolic_share((sm[1] - sm[0]) / 60.0) if not p.daytime_share_pct else min(0.99, p.daytime_share_pct / 100.0)
                self.daylight = (sm[0], sm[1], share)

    # ---- day equivalents (daylight-weighted days)
    def day_eq(self, a, b):
        span = (b - a).total_seconds() / 60.0
        if span <= 0:
            return 0.0
        if not self.daylight:
            return span / 1440.0
        sr, ss, share = self.daylight
        whole = int(span // 1440)
        left = span - whole * 1440
        if left <= 0:
            return float(whole)
        s = local_minute_of_day(a + timedelta(days=whole), self.p.tz)
        day_len = ss - sr
        day_min = 0.0
        for k in (0, 1):
            lo, hi = sr + 1440 * k, ss + 1440 * k
            day_min += max(0.0, min(s + left, hi) - max(s, lo))
        night = left - day_min
        return whole + day_min * (share / day_len) + night * ((1 - share) / (1440 - day_len))

    # ---- SWG generation
    @staticmethod
    def _rate_at(swg, t):
        rate = 0.0
        for e in swg:
            if e[0] <= t:
                rate = e[1]
            else:
                break
        return rate

    @staticmethod
    def _event_at(swg, t):
        ev = None
        for e in swg:
            if e[0] <= t:
                ev = e
            else:
                break
        return ev

    def generated_between(self, swg, t1, t2):
        pts = sorted({t1, t2, *[e[0] for e in swg if t1 < e[0] < t2]})
        return sum(self._rate_at(swg, a) * (b - a).total_seconds() / DAY for a, b in zip(pts, pts[1:]))

    def window_overlap_hours(self, t1, t2, hrs):
        """Hours the daily run window [swg_start, swg_start+hrs] overlaps [t1, t2]."""
        if t2 <= t1 or hrs <= 0:
            return 0.0
        tz = self.p.tz
        total = 0.0
        d0 = t1.astimezone(tz).date() - timedelta(days=1)
        d1 = t2.astimezone(tz).date() + timedelta(days=1)
        d = d0
        while d <= d1:
            start = datetime(d.year, d.month, d.day, tzinfo=tz) + timedelta(minutes=self.p.swg_start)
            end = start + timedelta(hours=hrs)
            a, b = max(start, t1), min(end, t2)
            if b > a:
                total += (b - a).total_seconds() / 3600.0
            d += timedelta(days=1)
        return total

    def generated_since(self, swg, t1, t2):
        if not swg or t2 <= t1:
            return 0.0
        pts = sorted({t1, t2, *[e[0] for e in swg if t1 < e[0] < t2]})
        total = 0.0
        for a, b in zip(pts, pts[1:]):
            ev = self._event_at(swg, a)
            if not ev or ev[2] <= 0:
                continue
            total += (ev[1] / ev[2]) * self.window_overlap_hours(a, b, ev[2])
        return total

    # ---- the as-of calculation
    def project(self, as_of):
        ds, p = self.ds, self.p
        fc = [e for e in ds.fc if e[0] <= as_of]
        swg = [e for e in ds.swg if e[0] <= as_of]
        adds = [e for e in ds.adds if e[0] <= as_of] if p.credit else []
        if not fc or not swg:
            return None
        added = lambda a, b: sum(x[1] for x in adds if a < x[0] <= b)
        ivs = []
        for (t1, f1), (t2, f2) in zip(fc, fc[1:]):
            if t2 <= t1:
                continue
            consumed = self.generated_between(swg, t1, t2) + added(t1, t2) - (f2 - f1)
            d = self.day_eq(t1, t2)
            ivs.append((t1, t2, consumed / d if d > 0 else 0.0, consumed, p.tolerance > 0 and consumed < -p.tolerance))
        window_start = as_of - timedelta(days=p.window_days)
        in_window = [e for e in fc if window_start <= e[0] <= as_of]
        if len(in_window) < MIN_FC_READINGS_IN_WINDOW and len(fc) >= MIN_FC_READINGS_IN_WINDOW:
            window_start = fc[-MIN_FC_READINGS_IN_WINDOW][0]

        def overlap(iv):
            a, b = max(iv[0], window_start), min(iv[1], as_of)
            return self.day_eq(a, b) if b > a else 0.0
        wt = cov = 0.0
        suspects = []
        for iv in ivs:
            o = overlap(iv)
            if o <= 0:
                continue
            if iv[4]:
                suspects.append(iv)
                continue
            wt += iv[2] * o
            cov += o
        if cov == 0 and suspects:
            for iv in suspects:
                o = overlap(iv)
                wt += iv[2] * o
                cov += o
        avg = wt / cov if cov > 0 else 0.0
        last_t, last_v = fc[-1]
        elapsed_eq = self.day_eq(last_t, as_of)
        projected = last_v - avg * elapsed_eq + self.generated_since(swg, last_t, as_of) + added(last_t, as_of)
        return {'projected': projected, 'avg': avg, 'last_ts': last_t, 'suspects': suspects}


# --------------------------------------------------------------------------- scoring
def scored_readings(ds, lookback_days, include_uncovered):
    """Indexes k whose reading can be predicted from reading k-1: 0.1 to 14 days apart, within the lookback,
    and (unless told otherwise) with at least 3 intervals of SWG-covered history before the previous reading."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    first_cov = ds.first_covered_index()
    out, skipped = [], 0
    for k in range(1, len(ds.fc)):
        t1, t2 = ds.fc[k - 1][0], ds.fc[k][0]
        if t2 < cutoff:
            continue
        days = (t2 - t1).total_seconds() / DAY
        if days < 0.1 or days > 14 or (not include_uncovered and k - 1 < first_cov + 3):
            skipped += 1
            continue
        out.append(k)
    return out, skipped


def run_errors(ds, p, ks):
    calc = Calc(ds, p)
    errs = {}
    for k in ks:
        r = calc.project(ds.fc[k][0] - timedelta(minutes=1))
        if r and r['last_ts'] == ds.fc[k - 1][0]:
            errs[k] = (r['projected'] - ds.fc[k][1], r)
    return errs


def mean(xs):
    return sum(xs) / len(xs)


def stats(errs):
    e = [x for x in errs]
    return {'n': len(e), 'mae': mean([abs(x) for x in e]), 'rmse': math.sqrt(mean([x * x for x in e])), 'bias': mean(e),
            'within1': 100.0 * sum(1 for x in e if abs(x) <= 1) / len(e), 'within2': 100.0 * sum(1 for x in e if abs(x) <= 2) / len(e)}


# --------------------------------------------------------------------------- reports
def report_summary(ds, p):
    print('\n== Dataset ==')
    print('FC readings %d (%s .. %s) | SWG entries %d | liquid chlorine additions %d | CYA readings %d | pool %d gal' % (
        len(ds.fc), ds.fc[0][0].date() if ds.fc else '-', ds.fc[-1][0].date() if ds.fc else '-', len(ds.swg), len(ds.adds), len(ds.cya), ds.gallons))
    if ds.swg:
        fcov = ds.first_covered_index()
        print('first SWG entry %s: %d of %d FC readings come before it (no SWG record, so those intervals cannot be used)' % (
            ds.swg[0][0].date(), fcov, len(ds.fc)))
    else:
        print('no SWG entries: consumption cannot be derived')
        return
    calc = Calc(ds, p)
    print('daylight weighting: %s' % ('on (day %.1f h, daytime share %.0f%%)' % ((calc.daylight[1] - calc.daylight[0]) / 60, calc.daylight[2] * 100) if calc.daylight
                                      else 'off (give --lat/--lon/--tz to enable)'))
    swg = ds.swg
    rows = collections.defaultdict(list)
    for (t1, f1), (t2, f2) in zip(ds.fc[ds.first_covered_index():], ds.fc[ds.first_covered_index() + 1:]):
        d = (t2 - t1).total_seconds() / DAY
        if d < 0.25 or d > 14:
            continue
        gen = calc.generated_between(swg, t1, t2)
        add = sum(x[1] for x in ds.adds if t1 < x[0] <= t2) if p.credit else 0.0
        cons = gen + add - (f2 - f1)
        rows[t1.strftime('%Y-%m')].append((d, cons / d, gen / d, f2))
    if rows:
        print('\nconsumption by month (covered intervals, day-weighted): month  intervals  consumption ppm/day  SWG ppm/day  median FC')
        for m in sorted(rows):
            rs = rows[m]
            w = sum(r[0] for r in rs)
            print('  %s  %4d   %5.2f   %5.2f   %5.1f' % (m, len(rs), sum(r[1] * r[0] for r in rs) / w, sum(r[2] * r[0] for r in rs) / w, statistics.median(r[3] for r in rs)))
    if ds.cya:
        ch = [(t, v) for i, (t, v) in enumerate(ds.cya) if i == 0 or v != ds.cya[i - 1][1]]
        print('\nCYA changes: ' + ', '.join('%s %g' % (t.date(), v) for t, v in ch[-8:]))


def report_accuracy(ds, p, args, csv_dir):
    ks, skipped = scored_readings(ds, args.days, args.include_uncovered)
    errs = run_errors(ds, p, ks)
    print('\n== Projection accuracy (window %d d, tolerance %g, credit %s, daylight %s) ==' % (p.window_days, p.tolerance, 'on' if p.credit else 'off', 'on' if Calc(ds, p).daylight else 'off'))
    if not errs:
        print('nothing to score (need SWG-covered history before the readings)')
        return
    s = stats([e for e, _ in errs.values()])
    print('%d readings scored (%d skipped) | MAE %.2f ppm | RMSE %.2f | bias %+.2f | within 1 ppm %.0f%% | within 2 ppm %.0f%%' % (
        s['n'], skipped + len(ks) - len(errs), s['mae'], s['rmse'], s['bias'], s['within1'], s['within2']))
    for label, lo, hi in (('under 2 days', 0, 2), ('2 to 5 days', 2, 5), ('5 to 14 days', 5, 15)):
        e = [abs(x) for k, (x, _) in errs.items() if lo <= (ds.fc[k][0] - ds.fc[k - 1][0]).total_seconds() / DAY < hi]
        if e:
            print('  %-13s MAE %.2f ppm (%d)' % (label, mean(e), len(e)))
    if csv_dir:
        with open(os.path.join(csv_dir, 'accuracy.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['reading', 'previous reading', 'days', 'projected', 'measured', 'error', 'burn used ppm/day'])
            for k, (e, r) in sorted(errs.items()):
                w.writerow([ds.fc[k][0].isoformat(), ds.fc[k - 1][0].isoformat(), round((ds.fc[k][0] - ds.fc[k - 1][0]).total_seconds() / DAY, 2),
                            round(r['projected'], 2), ds.fc[k][1], round(e, 2), round(r['avg'], 2)])


def report_whatif(ds, p, args, csv_dir):
    ks, skipped = scored_readings(ds, args.days, args.include_uncovered)
    variants = [('Current settings', p)]
    for w in (7, 14, 21, 28, 42, 56):
        if w != p.window_days:
            variants.append(('Averaging window %d days' % w, p.copy(window_days=w)))
    if p.daylight and ds.lat is not None and ds.lon is not None:
        variants.append(('Daylight weighting off', p.copy(daylight=False)))
    variants.append(('Liquid chlorine credit %s' % ('off' if p.credit else 'on'), p.copy(credit=not p.credit)))
    for t in (0, 1, 3):
        if t != p.tolerance:
            variants.append(('FC anomaly check off' if t == 0 else 'FC anomaly tolerance %d ppm' % t, p.copy(tolerance=float(t))))
    results = [run_errors(ds, v[1], ks) for v in variants]
    common = [k for k in ks if all(k in r for r in results)]
    print('\n== What-if sweep ==')
    if len(common) < 5:
        print('too few readings scorable under every variant (%d)' % len(common))
        return
    print('%d readings scored under every variant (%d skipped). Change = mean abs error vs current (negative is better), 90%% bootstrap range.' % (len(common), skipped + len(ks) - len(common)))
    base = [abs(results[0][k][0]) for k in common]
    rng = random.Random(12345)
    rows = []
    for (label, _), r in zip(variants, results):
        e = [r[k][0] for k in common]
        st = stats(e)
        row = [label, st['mae'], st['rmse'], st['bias'], None, None, None, 'current']
        if label != 'Current settings':
            d = [abs(x) - b for x, b in zip(e, base)]
            boots = sorted(mean([d[rng.randrange(len(d))] for _ in d]) for _ in range(2000))
            lo, hi = boots[100], boots[1899]
            row[4:8] = [mean(d), lo, hi, 'better' if hi < 0 else ('worse' if lo > 0 else 'no clear difference')]
        rows.append(row)
    rows = [rows[0]] + sorted(rows[1:], key=lambda r: r[1])
    print('  %-32s %7s %7s %7s   %-24s %s' % ('settings', 'MAE', 'RMSE', 'bias', 'change [90% range]', 'verdict'))
    for r in rows:
        ch = '' if r[4] is None else '%+.2f [%+.2f, %+.2f]' % (r[4], r[5], r[6])
        print('  %-32s %7.2f %7.2f %+7.2f   %-24s %s' % (r[0], r[1], r[2], r[3], ch, r[7]))
    if csv_dir:
        with open(os.path.join(csv_dir, 'whatif.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['settings', 'MAE', 'RMSE', 'bias', 'change', 'range low', 'range high', 'verdict'])
            for r in rows:
                w.writerow([r[0]] + [('' if v is None else round(v, 3) if isinstance(v, float) else v) for v in r[1:]])


def report_anomalies(ds, p):
    calc = Calc(ds, p)
    print('\n== FC rises the SWG output and logged additions do not explain ==')
    first = ds.first_covered_index()
    for tol in (1.0, 2.0, 3.0):
        n = 0
        listing = []
        for (t1, f1), (t2, f2) in zip(ds.fc[first:], ds.fc[first + 1:]):
            if not (0.1 <= (t2 - t1).total_seconds() / DAY <= 14):
                continue
            cons = calc.generated_between(ds.swg, t1, t2) + (sum(x[1] for x in ds.adds if t1 < x[0] <= t2) if p.credit else 0.0) - (f2 - f1)
            if cons < -tol:
                n += 1
                listing.append('%s -> %s: FC %.1f -> %.1f, unexplained %.1f ppm' % (t1.date(), t2.date(), f1, f2, -cons))
        print('tolerance %.1f ppm: %d interval(s)' % (tol, n))
        if tol == 2.0:
            for l in listing:
                print('    ' + l)


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description='Check the AutoSwg algorithm against a pool\'s PoolMath history.')
    ap.add_argument('share', nargs='?', help='PoolMath share code (tfp-123456) or share URL')
    ap.add_argument('--json', help='use a saved PoolMath share JSON instead of fetching')
    ap.add_argument('--pool', help='pool name when the account has several (default: the first)')
    ap.add_argument('--cache', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache'), help='where sanitized fetched data is cached')
    ap.add_argument('--refresh', action='store_true', help='re-fetch even if cached')
    ap.add_argument('--report', choices=['all', 'summary', 'accuracy', 'whatif', 'anomalies'], default='all')
    ap.add_argument('--days', type=int, default=365, help='how far back to score readings (default 365)')
    ap.add_argument('--include-uncovered', action='store_true', help='also score readings before the SWG record starts (not recommended)')
    ap.add_argument('--csv', help='write accuracy.csv / whatif.csv into this folder')
    ap.add_argument('--gallons', type=float, help='pool volume (default: from PoolMath)')
    ap.add_argument('--lat', type=float); ap.add_argument('--lon', type=float)
    ap.add_argument('--tz', help='IANA time zone, e.g. America/New_York (needed for daylight weighting and the SWG run window)')
    ap.add_argument('--utc-offset', type=float, help='fixed UTC offset in hours if --tz is unavailable')
    ap.add_argument('--window', type=int, default=21, help='averaging window in days (default 21)')
    ap.add_argument('--tolerance', type=float, default=2.0, help='FC anomaly tolerance in ppm, 0 = off (default 2)')
    ap.add_argument('--no-credit', action='store_true', help='do not credit liquid chlorine additions')
    ap.add_argument('--no-daylight', action='store_true', help='count time by the clock')
    ap.add_argument('--daytime-share', type=float, default=0, help='daytime share of FC loss in %%, 0 = parabolic estimate from day length')
    ap.add_argument('--swg-start', default='08:00', help='SWG daily run window start, HH:MM local (default 08:00; the run length comes from each PoolMath SWG entry)')
    args = ap.parse_args()

    pool = load_data(args)
    ds = Dataset(pool, args)
    hh, mm = (int(x) for x in args.swg_start.split(':'))
    p = Params(window_days=args.window, tolerance=args.tolerance, credit=not args.no_credit, daylight=not args.no_daylight,
               daytime_share_pct=args.daytime_share, swg_start=hh * 60 + mm, tz=get_tz(args.tz, args.utc_offset))
    csv_dir = None
    if args.csv:
        os.makedirs(args.csv, exist_ok=True)
        csv_dir = args.csv
    if not ds.fc:
        sys.exit('no FC readings in the data')
    if args.report in ('all', 'summary'):
        report_summary(ds, p)
    if args.report in ('all', 'accuracy'):
        report_accuracy(ds, p, args, csv_dir)
    if args.report in ('all', 'whatif'):
        report_whatif(ds, p, args, csv_dir)
    if args.report in ('all', 'anomalies'):
        report_anomalies(ds, p)


if __name__ == '__main__':
    main()
