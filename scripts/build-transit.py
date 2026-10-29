#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
"""Builds src/lib/transit-data.json: the Klang Valley's trains (LRT, MRT, Monorail, BRT and KTM Komuter) from the
official GTFS timetables Malaysia publishes on data.gov.my, for A2B's transit trips (src/lib/transit.js).

Prasarana's Rapid Rail feed gives one sample trip per line and direction plus how often trains run ("every 3
minutes from 6am to 9am"); KTMB's gives every Komuter train's times. Both are kept that way. KTMB's intercity trains
(ETS and the like) are left out: they're long-distance trains you book, not ones you hop on. Each feed only runs to
an end date, printed below, so rebuild when it's near (npm run transit).

    python3 scripts/build-transit.py
"""

import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
import zipfile

FEEDS = {
    'prasarana': 'https://api.data.gov.my/gtfs-static/prasarana?category=rapid-rail-kl',
    'ktmb': 'https://api.data.gov.my/gtfs-static/ktmb',
}
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'lib', 'transit-data.json')
UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)'
KIND = {'LRT': 'LRT', 'MRT': 'MRT', 'MRL': 'Monorail', 'BRT': 'BRT'}
# Words kept in capitals when station names are turned from "BANDAR TASIK SELATAN" into "Bandar Tasik Selatan".
TRANSFER_M = 400  # stations this close are one interchange (Masjid Jamek, KL Sentral); TRANSFER_M in transit.js
R = 6371008.8  # metres, as public/geo.js
ACRONYMS = {'KL', 'KLCC', 'LRT', 'MRT', 'KTM', 'USJ', 'SS', 'IOI', 'UKM', 'UPM', 'UIA', 'TTDI', 'PJ', 'KLIA', 'TRX',
            'MRR2', 'BRT', 'TBS', 'JB', 'SA', 'PWTC', 'MAEPS', 'PPR', 'IKEA', 'KPJ', 'UITM', 'SJMC', 'KTMB', 'AU', 'II', 'III', 'UOA'}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return zipfile.ZipFile(io.BytesIO(r.read()))


def table(z, name):
    path = next((n for n in z.namelist() if n.endswith(name) and not n.startswith('__MACOSX')), None)
    if not path:
        return []
    text = z.read(path).decode('utf-8-sig')
    return [{k.strip(): (v or '').strip() for k, v in row.items() if k} for row in csv.DictReader(io.StringIO(text))]


def secs(t):
    h, m, s = (int(x) for x in t.split(':'))
    return h * 3600 + m * 60 + s


def title(name):
    name = re.sub(r'\s*-\s*redone$', '', name.strip(), flags=re.I)  # a working note left in one station's name
    words = re.split(r'(\s+|-|/|\(|\))', name)
    out = []
    for w in words:
        if w.upper() in ACRONYMS or re.search(r'\d', w):
            out.append(w.upper())
        elif w.isupper() or w.islower():
            out.append(w[:1].upper() + w[1:].lower())
        else:
            out.append(w)
    return ''.join(out).replace('  ', ' ')


def distance(a, b):
    # Haversine, as distance() in public/geo.js. a and b are (lat, lng).
    dlat, dlng = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(h)))


def encode(coords, precision=5):
    # Google's polyline encoding, as public/geo.js decodes it.
    out, plat, plng, f = [], 0, 0, 10 ** precision
    for lng, lat in coords:
        ilat, ilng = round(lat * f), round(lng * f)
        for d in (ilat - plat, ilng - plng):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return ''.join(out)


def simplify(coords, tol=0.00004):
    # Douglas-Peucker, enough to draw a line on the map (~4 m).
    if len(coords) < 3:
        return coords
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = coords[a], coords[b]
        best, idx = 0, None
        for i in range(a + 1, b):
            x, y = coords[i]
            dx, dy = x2 - x1, y2 - y1
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / (math.hypot(dx, dy) or 1e-12)
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [c for c, k in zip(coords, keep) if k]


def main():
    data = {'built': time.strftime('%Y-%m-%d'), 'feeds': {}, 'lines': {}, 'stops': [], 'services': {}, 'patterns': [], 'shapes': {}}
    stop_index = {}

    def stop(feed, s):
        key = f"{feed}:{s['stop_id']}"
        if key not in stop_index:
            stop_index[key] = len(data['stops'])
            data['stops'].append([title(s['stop_name']), round(float(s['stop_lat']), 6), round(float(s['stop_lon']), 6), s['stop_id']])
        return stop_index[key]

    for feed, url in FEEDS.items():
        print(f'Downloading {feed}…', flush=True)
        z = fetch(url)
        routes = {r['route_id']: r for r in table(z, 'routes.txt')}
        stops = {s['stop_id']: s for s in table(z, 'stops.txt')}
        trips = table(z, 'trips.txt')
        times = {}
        for st in table(z, 'stop_times.txt'):
            times.setdefault(st['trip_id'], []).append(st)
        freqs = {}
        for f in table(z, 'frequencies.txt'):
            freqs.setdefault(f['trip_id'], []).append([secs(f['start_time']), secs(f['end_time']), int(f['headway_secs'])])
        ends = []
        for c in table(z, 'calendar.txt'):
            days = [int(c[d]) for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
            data['services'][f"{feed}:{c['service_id']}"] = {'days': days, 'start': c['start_date'], 'end': c['end_date'], 'add': [], 'remove': []}
            ends.append(c['end_date'])
        for c in table(z, 'calendar_dates.txt'):
            svc = data['services'].setdefault(f"{feed}:{c['service_id']}", {'days': [0] * 7, 'start': c['date'], 'end': c['date'], 'add': [], 'remove': []})
            svc['add' if c['exception_type'] == '1' else 'remove'].append(c['date'])
        for s in table(z, 'shapes.txt'):
            data['shapes'].setdefault(f"{feed}:{s['shape_id']}", []).append((int(s['shape_pt_sequence']), float(s['shape_pt_lon']), float(s['shape_pt_lat'])))

        # Lines, then patterns: one per line, direction, service and run of stops; KTM's trains of a pattern together.
        groups = {}
        for t in trips:
            r = routes.get(t['route_id'])
            if not r or r['route_type'] not in ('0', '1', '12') or t['trip_id'] not in times:
                continue  # intercity (route_type 2) and anything else left out
            line = f"{feed}:{r['route_id']}"
            kind = KIND.get(r.get('category', ''), 'KTM Komuter' if feed == 'ktmb' else 'Train')
            data['lines'][line] = {
                'short': r['route_short_name'] or r['route_id'], 'name': r['route_long_name'] if feed == 'prasarana' else r['route_short_name'],
                'color': '#' + (r.get('route_color') or '555555'), 'text': '#' + (r.get('route_text_color') or 'FFFFFF'), 'kind': kind,
            }
            st = sorted(times[t['trip_id']], key=lambda x: int(x['stop_sequence']))
            ids = tuple(stop(feed, stops[x['stop_id']]) for x in st if x['stop_id'] in stops)
            if len(ids) < 2:
                continue
            arr = [secs(x['arrival_time']) for x in st if x['stop_id'] in stops]
            dep = [secs(x['departure_time']) for x in st if x['stop_id'] in stops]
            key = (line, t.get('direction_id', '0'), f"{feed}:{t['service_id']}", ids)
            g = groups.setdefault(key, {'line': line, 'service': key[2], 'stops': list(ids), 'headsign': '', 'shape': None, 'trips': [], 'freq': None})
            g['headsign'] = title(data['stops'][ids[-1]][0])
            if t.get('shape_id'):
                g['shape'] = f"{feed}:{t['shape_id']}"
            if t['trip_id'] in freqs:
                # Times from the start of the sample trip, and when trains leave its first stop how often.
                g['offsets'] = [a - dep[0] for a in arr]
                g['freq'] = sorted(freqs[t['trip_id']])
            else:
                g['trips'].append(dep)
        for g in groups.values():
            if g['freq'] is None:
                g['trips'].sort(key=lambda d: d[0])
                del g['freq']
            else:
                del g['trips']
            data['patterns'].append(g)
        data['feeds'][feed] = {'until': max(ends) if ends else None, 'source': url}
        print(f"  {feed}: timetable runs until {data['feeds'][feed]['until']}", flush=True)

    # For each station, the others close enough to change trains on foot, and how far: [[station, metres], ...].
    # Worked out here rather than when the Worker starts, which would spend its CPU on it.
    pts = [(s[1], s[2]) for s in data['stops']]
    data['nearby'] = [[[j, round(distance(a, b))] for j, b in enumerate(pts) if j != i and distance(a, b) <= TRANSFER_M] for i, a in enumerate(pts)]

    used = {g['shape'] for g in data['patterns'] if g.get('shape')}
    data['shapes'] = {k: encode(simplify([(lng, lat) for _, lng, lat in sorted(v)])) for k, v in data['shapes'].items() if k in used}
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    print(f"Wrote {len(data['lines'])} lines, {len(data['stops'])} stations, {len(data['patterns'])} patterns "
          f"({os.path.getsize(OUT) / 1000:.0f} KB) to {os.path.relpath(OUT)}")


if __name__ == '__main__':
    sys.exit(main())
