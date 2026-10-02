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
                     'swgLbsPerDay': pool.get('swgLbsPerDay') if isinstance(pool.get('swgLbsPerDay'), (int, float)) else None,
                     'swgModelId': pool.get('swgModelId') if isinstance(pool.get('swgModelId'), str) else None,
                     'lat': round(pool['lat'], 1) if isinstance(pool.get('lat'), (int, float)) else None,
                     'lon': round(pool['lon'], 1) if isinstance(pool.get('lon'), (int, float)) else None},
            'recentLogs': logs})
    return out


def cache_path(args, share):
    key = re.sub(r'[^A-Za-z0-9_-]+', '_', share.split('/')[-1].replace('.json', ''))
    return os.path.join(args.cache, key + '.json')


def load_data(args):
    if args.json:
        data = sanitize(json.load(open(args.json, encoding='utf-8')))
    else:
        if not args.share:
            sys.exit('give a share code/URL or --json FILE')
        os.makedirs(args.cache, exist_ok=True)
        path = cache_path(args, args.share)
        if os.path.exists(path) and not args.refresh:
            data = json.load(open(path, encoding='utf-8'))
            print('using cached data %s (use --refresh to re-fetch)' % path, file=sys.stderr)
        else:
            data = sanitize(fetch_share(args.share))
            if not data.get('pools'):
                sys.exit('no pools in the data (is the share code right, and sharing turned on?)')
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
        self.excluded = []   # spans whose SWG credit is ignored (see odd_swg_spans); set by main()
        self.pm_swg_lbs = pool['pool'].get('swgLbsPerDay')      # PoolMath's current SWG rating setting
        self.pm_swg_model = pool['pool'].get('swgModelId')
        self.lat = args.lat if args.lat is not None else pool['pool'].get('lat')
        self.lon = args.lon if args.lon is not None else pool['pool'].get('lon')

    def touches_excluded(self, t1, t2):
        return any(t1 < b and t2 > a for a, b in self.excluded)

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
        self.weight = 0.5               # weight on the modelled FC change since the last reading (1 = all of it); the app's default
        self.taper_start = 3.0           # days: full weight until the last reading is this old ...
        self.taper_end = 8.0             # ... falling to 0 at this many days (0 = no taper); the app's default
        self.swg_start = 8 * 60          # run window start, minutes after local midnight
        self.tz = timezone.utc
        self.today = datetime.now(timezone.utc)
        self.__dict__.update(kw)

    def copy(self, **kw):
        p = Params(**self.__dict__)
        p.__dict__.update(kw)
        return p


def projection_weight(base, days, start, end):
    """Weight on the modelled FC change when the last reading is `days` old: `base` up to `start` days, falling
    linearly to 0 at `end` days (end <= 0, or not past start, means no taper)."""
    b = max(0.0, min(1.0, base))
    if not (end > 0 and end > start):
        return b
    if days <= start:
        return b
    if days >= end:
        return 0.0
    return b * (end - days) / (end - start)


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


SWG_FIT_TOLERANCE = 0.15


def swg_entries(ds):
    """Each SWG entry with the rated lbs/day it implies: (ts, ppm/day, hours, %, implied lbs/day)."""
    k = 1e6 / (ds.gallons * 8.34)   # ppm per lb of chlorine in this pool
    return [(t, a, h, pc, a / (pc / 100.0) / (h / 24.0) / k) for t, a, h, pc in ds.swg if pc > 0 and h > 0 and a > 0], k


def swg_regimes(ents):
    """Split entries into periods of one implied rating (a step confirmed by the next two entries is a cell
    swap) and pick out entries that fit no period: returns (regimes, outliers[(entry, period rating, entries after)])."""
    regimes, outliers = [[ents[0]]], []
    i = 1
    while i < len(ents):
        cur = statistics.median([e[4] for e in regimes[-1][-5:]])
        e = ents[i]
        if abs(e[4] / cur - 1) <= SWG_FIT_TOLERANCE:
            regimes[-1].append(e)
        else:
            nxt = ents[i + 1:i + 3]
            if len(nxt) == 2 and all(abs(n[4] / e[4] - 1) <= SWG_FIT_TOLERANCE for n in nxt):
                regimes.append([e])
            else:
                outliers.append((e, cur, len(ents) - i - 1))
        i += 1
    return regimes, outliers


def odd_swg_spans(ds):
    """(start, end) spans during which the SWG credit rests on an entry that doesn't fit its period."""
    ents, _ = swg_entries(ds)
    if len(ents) < 3:
        return []
    _, outliers = swg_regimes(ents)
    spans = []
    for (e, _, _) in outliers:
        later = [x[0] for x in ds.swg if x[0] > e[0]]
        spans.append((e[0], later[0] if later else datetime.now(timezone.utc)))
    return spans


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
            odd = ds.touches_excluded(t1, t2)
            ivs.append((t1, t2, consumed / d if d > 0 else 0.0, consumed, odd or (p.tolerance > 0 and consumed < -p.tolerance)))
        window_start = as_of - timedelta(days=p.window_days)
        in_window = [e for e in fc if window_start <= e[0] <= as_of]
        if len(in_window) < MIN_FC_READINGS_IN_WINDOW and len(fc) >= MIN_FC_READINGS_IN_WINDOW:
            window_start = fc[-MIN_FC_READINGS_IN_WINDOW][0]

        def overlap(iv):
            a, b = max(iv[0], window_start), min(iv[1], as_of)
            return self.day_eq(a, b) if b > a else 0.0
        wt = cov = 0.0
        suspects = []
        uncovered = 0
        first_swg = swg[0][0]
        for iv in ivs:
            o = overlap(iv)
            if o <= 0:
                continue
            if iv[0] < first_swg:       # starts before the SWG record: no output on record, so left out
                uncovered += 1
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
        if cov == 0 and uncovered:       # nothing but pre-record intervals: the app reports this as an error
            return None
        avg = wt / cov if cov > 0 else 0.0
        last_t, last_v = fc[-1]
        elapsed_eq = self.day_eq(last_t, as_of)
        gen_since = self.generated_since(swg, last_t, as_of)
        add_since = added(last_t, as_of)
        model_change = gen_since - avg * elapsed_eq
        elapsed_days = (as_of - last_t).total_seconds() / DAY
        projected = last_v + projection_weight(p.weight, elapsed_days, p.taper_start, p.taper_end) * model_change + add_since
        return {'projected': projected, 'avg': avg, 'last_ts': last_t, 'suspects': suspects,
                'prev': last_v, 'model_change': model_change, 'added': add_since}


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
        if days < 0.1 or days > 14 or (not include_uncovered and k - 1 < first_cov + 3) or ds.touches_excluded(t1, t2):
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
        if d < 0.25 or d > 14 or ds.touches_excluded(t1, t2):
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
    # the no-model baseline, and what each weighting of the modelled change would have scored
    prevs = [(r['prev'], r['model_change'], r['added'], ds.fc[k][1]) for k, (e, r) in errs.items()]
    unchanged = mean([abs(pv - m) for pv, mc, ad, m in prevs])
    print('baseline "FC unchanged since the last reading": MAE %.2f ppm -> the algorithm is %.0f%% %s than that' % (
        unchanged, abs(100 * (1 - s['mae'] / unchanged)), 'better' if s['mae'] < unchanged else 'worse'))
    gaps = [(ds.fc[k][0] - ds.fc[k - 1][0]).total_seconds() / DAY for k in errs]
    def mae_at(lam, ts, te):
        return mean([abs(pv + projection_weight(lam, g, ts, te) * mc + ad - m) for (pv, mc, ad, m), g in zip(prevs, gaps)])
    tapers = [(3, 0), (3, 8), (4, 10), (2, 6), (5, 12)]
    best = min(((i / 20.0, ts, te, mae_at(i / 20.0, ts, te)) for i in range(21) for ts, te in tapers), key=lambda x: x[3])
    wgt = len(prevs) / (len(prevs) + 30.0)
    sw = round((wgt * best[0] + (1 - wgt) * 0.5) * 20) / 20.0
    st = min(((ts, te, mae_at(sw, ts, te)) for ts, te in tapers), key=lambda x: x[2])
    if st[2] > mae_at(sw, 3, 0) * 0.97:
        st = (3, 0, mae_at(sw, 3, 0))
    desc = lambda w, ts, te: '%.0f%%%s' % (w * 100, (', taper %d to %d days' % (ts, te)) if te > 0 else ', no taper')
    print('projection weighting: current %s (MAE %.2f) | best on these readings %s (MAE %.2f) | suggested %s (MAE %.2f), weighting shrunk toward 50%% for the small sample' % (
        desc(p.weight, p.taper_start, p.taper_end), s['mae'], desc(best[0], best[1], best[2]), best[3], desc(sw, st[0], st[1]), st[2]))
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
    for wgt in (0.0, 0.25, 0.5, 0.75, 1.0):
        if wgt != p.weight:
            variants.append(('Projection weighting %d%%' % round(wgt * 100), p.copy(weight=wgt)))
    for ts, te in ((3, 8), (4, 10), (2, 6)):
        variants.append(('Taper off %d to %d days' % (ts, te), p.copy(taper_start=float(ts), taper_end=float(te))))
        variants.append(('Weighting 50%% + taper %d to %d days' % (ts, te), p.copy(weight=0.5, taper_start=float(ts), taper_end=float(te))))
    for t in (0, 1, 3):
        if t != p.tolerance:
            variants.append(('FC anomaly check off' if t == 0 else 'FC anomaly tolerance %d ppm' % t, p.copy(tolerance=float(t))))
    key = lambda q: (q.window_days, q.credit, q.tolerance, q.weight, q.taper_start, q.taper_end, q.daylight)
    variants = [variants[0]] + [v for v in variants[1:] if key(v[1]) != key(p)]    # skip variants identical to the current settings
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


def report_capacity(ds, p, args):
    """Does each SWG entry's ppm credit agree with one rated capacity (lbs/day)? PoolMath credits each entry
    with ppm = % x rated lbs/day x hours/24 (in ppm for this pool), so the rating each entry implies should
    be steady; a step change is a cell swap and a lone odd entry is probably mis-logged."""
    print('\n== SWG capacity agreement ==')
    ents, k = swg_entries(ds)
    if len(ents) < 3:
        print('too few SWG entries to check')
        return
    TOL = SWG_FIT_TOLERANCE
    med = statistics.median
    regimes, outliers = swg_regimes(ents)
    print('PoolMath rating setting: %s lbs/day%s | %d SWG entries, %d level(s)' % (
        ds.pm_swg_lbs if ds.pm_swg_lbs else 'unknown', (' (%s)' % ds.pm_swg_model) if ds.pm_swg_model else '', len(ents), len(regimes)))
    print('\n  implied rated capacity by period (lbs/day over 24 h):')
    for r in regimes:
        # entries whose ppm is tiny are rounded to 0.1, so prefer the larger ones for the level
        use = [e[4] for e in r if e[1] >= 1.5] or [e[4] for e in r]
        print('    %s .. %s   %2d entries   %.2f lbs/day' % (r[0][0].date(), r[-1][0].date(), len(r), med(use)))
    if len(regimes) > 1:
        print('  -> the level changes between periods: a cell swap or a changed rating setting. PoolMath keeps each entry\'s own credit, so the history stays consistent.')
    latest = med([e[4] for e in regimes[-1] if e[1] >= 1.5] or [e[4] for e in regimes[-1]])
    if args.njspc_lbs:
        diff = 100.0 * (args.njspc_lbs / latest - 1)
        verdict = 'agrees' if abs(diff) <= 5 else ('is somewhat off' if abs(diff) <= 15 else 'DISAGREES')
        print('\n  njsPC rating %.2f lbs/day vs PoolMath\'s latest implied %.2f: %+.0f%% -> %s' % (args.njspc_lbs, latest, diff, verdict))
        if abs(diff) > 5:
            print('     njsPC turns a % into ppm with its own rating, so a mismatch shifts both the recommended % and the SWG output it logs locally.')
    else:
        print('\n  latest implied rating %.2f lbs/day. Pass --njspc-lbs <your njsPC SWG rating> to compare.' % latest)
    if outliers:
        calc = Calc(ds, p)
        first_swg = ds.swg[0][0]
        typical_list = []
        for (t1, f1), (t2, f2) in zip(ds.fc, ds.fc[1:]):
            d = (t2 - t1).total_seconds() / DAY
            if 0.25 <= d <= 14 and t1 >= first_swg:
                typical_list.append((calc.generated_between(ds.swg, t1, t2) - (f2 - f1)) / d)
        typical = med(typical_list) if typical_list else None
        print('\n  entries that do not fit their period (rating off by more than %d%%)%s:' % (
            int(TOL * 100), ' -- flagged and IGNORED (the intervals they affect are left out of the averages and scoring; --keep-odd-swg to include them)' if ds.excluded else ''))
        for (e, cur, after) in outliers:
            nxt = [x[0] for x in ds.swg if x[0] > e[0]]
            hold_end = nxt[0] if nxt else datetime.now(timezone.utc)
            hold_days = (hold_end - e[0]).total_seconds() / DAY
            expected = e[3] / 100.0 * cur * (e[2] / 24.0) * k
            note = '' if after >= 2 else ' (among the latest entries: a new level can\'t be told from a typo yet)'
            print('    %s  %.0f%% for %.0f h credited %.1f ppm/day, but %.2f lbs/day would give %.1f (held %.1f days)%s' % (
                e[0].date(), e[3], e[2], e[1], cur, expected, hold_days, note))
            # which credit do the FC readings support? compare the implied consumption with the typical level
            mod = [(t, expected if t == e[0] else a, h, pc) for t, a, h, pc in ds.swg]
            lg, ex = [], []
            for (t1, f1), (t2, f2) in zip(ds.fc, ds.fc[1:]):
                d = (t2 - t1).total_seconds() / DAY
                ov = (min(t2, hold_end) - max(t1, e[0])).total_seconds() / DAY
                if d >= 0.25 and ov >= 0.5 * d:
                    lg.append((calc.generated_between(ds.swg, t1, t2) - (f2 - f1)) / d)
                    ex.append((calc.generated_between(mod, t1, t2) - (f2 - f1)) / d)
            if lg and typical is not None:
                a, b = mean(lg), mean(ex)
                better = 'the LOGGED credit' if abs(a - typical) <= abs(b - typical) else "the rating's credit"
                print('       FC over that period implies consumption of %.2f ppm/day with the logged credit, %.2f with the rating\'s (typical for this pool %.2f): %s fits the FC readings better.' % (a, b, typical, better))
                if better == 'the LOGGED credit':
                    print('       So the credit may be right and the % or run hours entered may not reflect what actually ran (or the credit was edited).')
                else:
                    print('       So the credit looks too %s: fix the entry in PoolMath.' % ('large' if e[1] > expected else 'small'))
        print('     A wrong credit on an entry makes the consumption around it come out too low or too high; the FC check above says which way to look.')
    else:
        print('\n  every entry fits its period within %d%%.' % int(TOL * 100))


def screen(codes, args):
    """One line per candidate pool: is there enough logged (SWG % changes, FC readings with SWG behind them) to check the
    algorithm against? One polite request per pool (cached afterwards); a pool that cannot be read is reported, not fatal."""
    import copy
    if not codes:
        sys.exit('give one or more share codes (or URLs) after --screen')
    rows = []
    for i, code in enumerate(codes):
        a = copy.copy(args)
        a.share, a.json = code, None
        fresh = not os.path.exists(cache_path(args, code)) or args.refresh
        if i > 0 and fresh:
            time.sleep(args.screen_pause)        # be polite to PoolMath between fresh requests
        label = code.split('/')[-1].replace('.json', '')
        try:
            ds = Dataset(load_data(a), a)
        except SystemExit as e:
            rows.append({'code': label, 'verdict': 'unavailable: %s' % (e.code if isinstance(e.code, str) else 'could not be read')})
            continue
        now = datetime.now(timezone.utc)
        year = now - timedelta(days=365)
        ks_all, _ = scored_readings(ds, 100000, False)
        ks_year, _ = scored_readings(ds, 365, False)
        odd = len(odd_swg_spans(ds))
        recent = [t for t, _ in ds.fc if t >= year]
        gaps = [(b - a_).total_seconds() / DAY for a_, b in zip(recent, recent[1:])]
        last_fc = ds.fc[-1][0] if ds.fc else None
        r = {
            'code': label, 'gallons': ds.gallons, 'fc': len(ds.fc), 'fc_year': len(recent),
            'span': '%s..%s' % (ds.fc[0][0].date(), ds.fc[-1][0].date()) if ds.fc else '-',
            'swg': len(ds.swg), 'swg_year': sum(1 for e in ds.swg if e[0] >= year), 'adds': len(ds.adds),
            'scorable_year': len(ks_year), 'scorable_all': len(ks_all), 'odd': odd,
            'gap': round(statistics.median(gaps), 1) if gaps else None,
            'last_days': (now - last_fc).days if last_fc else None,
        }
        # the verdict, from the most useful fact first
        if not ds.swg:
            r['verdict'] = 'no SWG logged: consumption cannot be derived'
        elif len(ds.fc) < 20:
            r['verdict'] = 'too few FC readings'
        elif r['scorable_all'] < 15:
            r['verdict'] = 'too sparse: %d readings with SWG history behind them' % r['scorable_all']
        elif r['last_days'] is not None and r['last_days'] > 120:
            r['verdict'] = 'stale: last FC reading %d days ago' % r['last_days']
        elif r['scorable_all'] >= 30 and r['scorable_year'] >= 15:
            r['verdict'] = 'GOOD'
        elif r['scorable_all'] >= 30:
            r['verdict'] = 'usable (most of the data is older than a year)'
        else:
            r['verdict'] = 'marginal'
        rows.append(r)
    print('\n== Screening %d pool%s ==' % (len(rows), '' if len(rows) == 1 else 's'))
    print('  %-14s %7s %9s %5s %5s %8s %9s %5s %5s  %s' % ('share code', 'gallons', 'FC (1yr)', 'SWG', 'adds', 'scorable', 'median', 'odd', 'last', 'verdict'))
    print('  %-14s %7s %9s %5s %5s %8s %9s %5s %5s' % ('', '', '', '', '', '(1yr/all)', 'gap (d)', 'SWG', 'FC (d)'))
    for r in rows:
        if 'fc' not in r:
            print('  %-14s %s' % (r['code'], r['verdict']))
            continue
        print('  %-14s %7s %9s %5d %5d %8s %9s %5d %5s  %s' % (
            r['code'], '%d' % r['gallons'], '%d (%d)' % (r['fc'], r['fc_year']), r['swg'], r['adds'],
            '%d/%d' % (r['scorable_year'], r['scorable_all']), '%.1f' % r['gap'] if r['gap'] is not None else '-', r['odd'],
            r['last_days'] if r['last_days'] is not None else '-', r['verdict']))
    print('\nSWG = SWG % entries logged; scorable = FC readings with at least three SWG-covered intervals behind them; odd SWG = entries ignored as not fitting the pool\'s rating.')
    if args.csv:
        os.makedirs(args.csv, exist_ok=True)
        keys = ['code', 'gallons', 'fc', 'fc_year', 'span', 'swg', 'swg_year', 'adds', 'scorable_year', 'scorable_all', 'odd', 'gap', 'last_days', 'verdict']
        with open(os.path.join(args.csv, 'screen.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(keys)
            for r in rows:
                w.writerow([r.get(k, '') for k in keys])


def report_anomalies(ds, p):
    calc = Calc(ds, p)
    print('\n== FC rises the SWG output and logged additions do not explain ==')
    first = ds.first_covered_index()
    for tol in (1.0, 2.0, 3.0):
        n = 0
        listing = []
        for (t1, f1), (t2, f2) in zip(ds.fc[first:], ds.fc[first + 1:]):
            if not (0.1 <= (t2 - t1).total_seconds() / DAY <= 14) or ds.touches_excluded(t1, t2):
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
    ap.add_argument('share', nargs='*', help='PoolMath share code (tfp-123456) or share URL; with --screen, any number of them')
    ap.add_argument('--screen', action='store_true', help='screen the given pools: one line each saying whether there is enough logged to check the algorithm against')
    ap.add_argument('--screen-pause', type=float, default=10.0, help='seconds to pause between fresh PoolMath requests when screening (default 10)')
    ap.add_argument('--json', help='use a saved PoolMath share JSON instead of fetching')
    ap.add_argument('--pool', help='pool name when the account has several (default: the first)')
    ap.add_argument('--cache', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache'), help='where sanitized fetched data is cached')
    ap.add_argument('--refresh', action='store_true', help='re-fetch even if cached')
    ap.add_argument('--report', choices=['all', 'summary', 'capacity', 'accuracy', 'whatif', 'anomalies'], default='all')
    ap.add_argument('--keep-odd-swg', action='store_true', help="don't ignore SWG entries that don't fit their period's rating (see the capacity report)")
    ap.add_argument('--njspc-lbs', type=float, help="njsPC's AutoSwg SWG rating (lbs/day), to compare with what PoolMath's entries imply")
    ap.add_argument('--days', type=int, default=365, help='how far back to score readings (default 365)')
    ap.add_argument('--include-uncovered', action='store_true', help='also score readings before the SWG record starts (not recommended)')
    ap.add_argument('--csv', help='write accuracy.csv / whatif.csv into this folder')
    ap.add_argument('--gallons', type=float, help='pool volume (default: from PoolMath)')
    ap.add_argument('--lat', type=float); ap.add_argument('--lon', type=float)
    ap.add_argument('--tz', help='IANA time zone, e.g. America/New_York (needed for daylight weighting and the SWG run window)')
    ap.add_argument('--utc-offset', type=float, help='fixed UTC offset in hours if --tz is unavailable')
    ap.add_argument('--window', type=int, default=21, help='averaging window in days (default 21)')
    ap.add_argument('--tolerance', type=float, default=2.0, help='FC anomaly tolerance in ppm, 0 = off (default 2)')
    ap.add_argument('--weight', '--damping', dest='weight', type=float, default=0.5, help='weight on the modelled FC change since the last reading, 0 to 1 (default 0.5, the app default; 1 = all of it)')
    ap.add_argument('--taper-start', type=float, default=3.0, help='days: full projection weight until the last reading is this old (default 3)')
    ap.add_argument('--taper-end', type=float, default=8.0, help='days at which the weight reaches 0 (default 8, the app default; 0 = no taper)')
    ap.add_argument('--no-credit', action='store_true', help='do not credit liquid chlorine additions')
    ap.add_argument('--no-daylight', action='store_true', help='count time by the clock')
    ap.add_argument('--daytime-share', type=float, default=0, help='daytime share of FC loss in %%, 0 = parabolic estimate from day length')
    ap.add_argument('--swg-start', default='08:00', help='SWG daily run window start, HH:MM local (default 08:00; the run length comes from each PoolMath SWG entry)')
    args = ap.parse_args()
    if args.screen:
        screen(args.share, args)
        return
    if len(args.share) > 1:
        sys.exit('give one share code (use --screen for several)')
    args.share = args.share[0] if args.share else None

    pool = load_data(args)
    ds = Dataset(pool, args)
    hh, mm = (int(x) for x in args.swg_start.split(':'))
    p = Params(window_days=args.window, tolerance=args.tolerance, credit=not args.no_credit, daylight=not args.no_daylight,
               daytime_share_pct=args.daytime_share, swg_start=hh * 60 + mm, tz=get_tz(args.tz, args.utc_offset), weight=args.weight,
               taper_start=args.taper_start, taper_end=args.taper_end)
    if not args.keep_odd_swg:
        ds.excluded = odd_swg_spans(ds)
        if ds.excluded:
            n = len(ds.excluded)
            print("note: ignoring %d SWG %s that %s fit the pool's rating (run --report capacity for details; --keep-odd-swg to include)" % (
                n, 'entry' if n == 1 else 'entries', "doesn't" if n == 1 else "don't"), file=sys.stderr)
    csv_dir = None
    if args.csv:
        os.makedirs(args.csv, exist_ok=True)
        csv_dir = args.csv
    if not ds.fc:
        sys.exit('no FC readings in the data')
    if args.report in ('all', 'summary'):
        report_summary(ds, p)
    if args.report in ('all', 'capacity'):
        report_capacity(ds, p, args)
    if args.report in ('all', 'accuracy'):
        report_accuracy(ds, p, args, csv_dir)
    if args.report in ('all', 'whatif'):
        report_whatif(ds, p, args, csv_dir)
    if args.report in ('all', 'anomalies'):
        report_anomalies(ds, p)


if __name__ == '__main__':
    main()
