// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Opt-in probe traffic: drivers who switch it on share small batches of recent speed fixes, and the server
// folds them straight into anonymous per-street totals. A raw fix is never written to the database: it is
// validated, dropped into its street block's running average, and forgotten. What is kept per block is only
// the block itself, the direction of travel, the average speed, how many fixes went in, and when. Routes
// then slow down over blocks where enough drivers crawled, next to the jams drivers reported by hand.

import { bearing, angleDiff, cumulative } from '../../public/geo.js';
import { pointAlong } from '../../public/nav.js';

export const PROBE_CELL_DEG = 0.001; // ~111 m: a street block, too coarse to pick out a house
export const PROBE_DIR_BUCKETS = 4; // 90-degree slices: the two sides of a dual carriageway land apart
export const PROBE_UNKNOWN_DIR = 4; // a fix with no usable heading
export const PROBE_WINDOW_MS = 10 * 60_000; // only this-fresh totals slow a route down
export const PROBE_RETENTION_MS = 24 * 3600_000; // the nightly job deletes anything older than this
export const PROBE_MIN_POINTS = 5; // sparse-data guard: fewer fixes than this never counts as congested
export const PROBE_MIN_DEVICES = 3; // anti-gaming guard: one driver (or script) alone can never mark a block congested
export const PROBE_MAX_SPEED_MS = 55.6; // ~200 km/h: faster is a glitch, not a car
export const PROBE_STILL_MS = 1; // slower than a walk carries no signal: a jam and a parked car look the same
export const PROBE_MAX_POINTS = 12; // per batch: a phone sends a sip, not the whole drive
export const PROBE_MIN_INTERVAL_MS = 20_000; // per device: at most a batch every so often (phones send every 30 s)
export const PROBE_MAX_PER_DAY = 1200; // per device: about 10 hours of driving at a batch every 30 seconds
export const PROBE_MATCH_M = 75; // a block centre sits at most ~80 m from the road it describes
export const PROBE_MERGE_GAP_M = 150; // congested blocks this close along a route are one jam
export const PROBE_REF_KMH = 40; // delays are measured against this: what a clear urban street flows at
export const PROBE_MAX_DELAY_S = 1800; // sanity cap: probes never add more than 30 minutes to one route
const COUNT_CAP = 10000; // a block's running average stops counting past this: old news fades, nothing overflows

// `latCell,lngCell,dir`: which street block a fix belongs to, and which way it was heading.
export function segmentKey(lat, lng, heading) {
  const dir = Number.isFinite(heading) ? Math.floor((((heading % 360) + 360) % 360) / (360 / PROBE_DIR_BUCKETS)) : PROBE_UNKNOWN_DIR;
  return `${Math.floor(lat / PROBE_CELL_DEG)},${Math.floor(lng / PROBE_CELL_DEG)},${dir}`;
}

// Back to a centre point ([lng, lat]) and a compass middle of the slice (null when unknown).
export function segmentCell(key) {
  const [a, b, d] = key.split(',').map(Number); // key is latCell,lngCell,dir
  return { lat: (a + 0.5) * PROBE_CELL_DEG, lng: (b + 0.5) * PROBE_CELL_DEG, heading: d === PROBE_UNKNOWN_DIR ? null : d * 90 + 45 };
}

// 1 slow, 2 queuing, 3 crawling. 0 means flowing: not congested.
export function levelFor(avgMs) {
  const kmh = avgMs * 3.6;
  if (!(kmh > 0)) return 0;
  if (kmh < 9) return 3;
  if (kmh < 18) return 2;
  if (kmh < 30) return 1;
  return 0;
}

// A raw fix, or null when it carries no signal: out of range, absurdly fast, stale, vague, or standing still.
export function validPoint(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat), lng = Number(p.lng), speed = Number(p.speed), at = Number(p.at ?? now);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return null;
  if (!(speed >= 0 && speed <= PROBE_MAX_SPEED_MS) || speed < PROBE_STILL_MS) return null;
  if (!(at <= now + 60_000 && at >= now - 5 * 60_000)) return null;
  if (p.accuracy != null && !(Number(p.accuracy) <= 100)) return null;
  const heading = Number(p.heading);
  if (!Number.isFinite(heading)) return null;
  return { lat, lng, speed, heading, at };
}

export function probesRepo(db) {
  // Folds one batch into the block totals. Returns { stored }.
  async function contribute(deviceHash, points, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const seen = await db.prepare('SELECT last_at, day, n FROM probe_limits WHERE device_hash = ?').bind(deviceHash).first();
    if (seen) {
      if (now - seen.last_at < PROBE_MIN_INTERVAL_MS) {
        const e = new Error('Too many probe batches. Slow down.');
        e.status = 429;
        throw e;
      }
      if (seen.day === day && seen.n >= PROBE_MAX_PER_DAY) {
        const e = new Error('Probe limit reached for today.');
        e.status = 429;
        throw e;
      }
    }
    await db
      .prepare(
        `INSERT INTO probe_limits (device_hash, last_at, day, n) VALUES (?, ?, ?, 1)
         ON CONFLICT(device_hash) DO UPDATE SET last_at = excluded.last_at, day = excluded.day, n = CASE WHEN day = excluded.day THEN n + 1 ELSE 1 END`,
      )
      .bind(deviceHash, now, day)
      .run();

    const fixes = (Array.isArray(points) ? points : []).slice(0, PROBE_MAX_POINTS).map((p) => validPoint(p, now)).filter(Boolean);
    // A teleport between two fixes is a glitch (tunnel, spoofed GPS): keep the first, drop the jump.
    const kept = [];
    for (const f of fixes.sort((a, b) => a.at - b.at)) {
      const prev = kept.at(-1);
      if (prev && f.at > prev.at) {
        const dt = (f.at - prev.at) / 1000;
        const dx = Math.hypot(f.lng - prev.lng, f.lat - prev.lat) * 111_000;
        if (dx / dt > 83.4) continue; // ~300 km/h between fixes
      }
      kept.push(f);
    }
    const bySeg = new Map();
    for (const f of kept) {
      const key = segmentKey(f.lat, f.lng, f.heading);
      const g = bySeg.get(key) ?? { n: 0, sum: 0 };
      g.n++;
      g.sum += f.speed;
      bySeg.set(key, g);
    }
    if (!bySeg.size) return { stored: 0 };
    const stmts = [];
    for (const [key, g] of bySeg) {
      const avg = g.sum / g.n;
      const cell = segmentCell(key); // stored position is the block centre, never the raw fix
      stmts.push(
        db.prepare(
          `INSERT INTO probe_segments (segment, lat, lng, dir, avg_speed, probes, window_start, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(segment) DO UPDATE SET
             lat = excluded.lat, lng = excluded.lng,
             avg_speed = CASE WHEN window_start < ? THEN excluded.avg_speed
               ELSE (avg_speed * probes + excluded.avg_speed * excluded.probes) / (probes + excluded.probes) END,
             probes = CASE WHEN window_start < ? THEN excluded.probes ELSE min(probes + excluded.probes, ${COUNT_CAP}) END,
             window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END,
             updated_at = excluded.updated_at`,
        ).bind(key, cell.lat, cell.lng, Number(key.split(',')[2]), avg, g.n, now, now, now - PROBE_WINDOW_MS, now - PROBE_WINDOW_MS, now - PROBE_WINDOW_MS),
        // One row per device per block: the same driver re-driving a block still counts once towards its
        // distinct-driver guard, so a script minting fixes (but not drivers) can't fake a jam alone.
        db.prepare(
          `INSERT INTO probe_devices (segment, device_hash, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(segment, device_hash) DO UPDATE SET updated_at = excluded.updated_at`,
        ).bind(key, deviceHash, now),
      );
    }
    await db.batch(stmts);
    return { stored: kept.length };
  }

  // Blocks in a box that are congested right now: fresh, enough fixes, crawling on average, and seen by
  // enough distinct drivers that one phone (or script) alone can't mark a block.
  async function congested([w, s, e, n], now = Date.now()) {
    const cutoff = now - PROBE_WINDOW_MS;
    const rows = (
      await db
        .prepare(
          `SELECT s.segment, s.lat, s.lng, s.dir, s.avg_speed, s.probes, COUNT(d.device_hash) AS devices
           FROM probe_segments s JOIN probe_devices d ON d.segment = s.segment AND d.updated_at > ?
           WHERE s.updated_at > ? AND s.probes >= ${PROBE_MIN_POINTS} AND s.avg_speed < ? AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?
           GROUP BY s.segment HAVING devices >= ${PROBE_MIN_DEVICES}
           ORDER BY s.updated_at DESC LIMIT 500`,
        )
        .bind(cutoff, cutoff, 30 / 3.6, s, n, w, e)
        .all()
    ).results;
    return rows.map((r) => ({ ...r, level: levelFor(r.avg_speed) })).filter((r) => r.level > 0);
  }

  return { contribute, congested };
}

// Slows routes over congested blocks, next to the jams drivers reported by hand. Sets r.probe_jams
// ([{from, to, level, delay, probes}] as fractions of the route) and r.probe_delay, and folds the delay
// into the duration when live traffic isn't already timing the route. r.slow says why each route is slow.
export function annotateWithProbes(routes, segments, box = null) {
  for (const r of routes) {
    const cum = cumulative(r.coords);
    const total = cum.at(-1) || 1;
    const hits = [];
    for (const g of segments) {
      if (box && (g.lng < box[0] || g.lat < box[1] || g.lng > box[2] || g.lat > box[3])) continue;
      const best = pointAlong(r.coords, cum, [g.lng, g.lat]);
      if (best.dist > PROBE_MATCH_M) continue;
      // The block's direction should roughly match the road's, or it's the opposite carriageway's jam.
      if (g.dir !== PROBE_UNKNOWN_DIR) {
        const road = bearing(r.coords[Math.max(0, best.seg - 1)], r.coords[best.seg]);
        if (Math.abs(angleDiff(g.dir * 90 + 45, road)) > 70) continue;
      }
      hits.push({ along: best.along, avg: g.avg_speed, probes: g.probes, level: g.level });
    }
    hits.sort((a, b) => a.along - b.along);
    // Nearby blocks are one jam; its delay is the crawl against a clear street over its length.
    const jams = [];
    for (const h of hits) {
      const open = jams.at(-1);
      if (open && h.along - open.endM <= PROBE_MERGE_GAP_M) {
        open.endM = h.along;
        open.avg = Math.min(open.avg, h.avg);
        open.probes = Math.min(open.probes, h.probes);
      } else {
        jams.push({ startM: h.along, endM: h.along, avg: h.avg, probes: h.probes });
      }
    }
    const refMs = PROBE_REF_KMH / 3.6;
    let exact = 0;
    const out = jams.map((j) => {
      const len = Math.max(0, j.endM - j.startM) || PROBE_CELL_DEG * 111_000;
      const d = Math.max(0, len * (1 / Math.max(j.avg, 0.5) - 1 / refMs));
      const level = levelFor(j.avg);
      exact += d;
      return { from: round(j.startM / total), to: round(j.endM / total), level, delay: Math.round(d), probes: j.probes, _mid: (j.startM + j.endM) / 2, _len: len, _exact: d }; /* _len: point hits count a block's width */
    });
    const delay = Math.min(Math.round(exact), PROBE_MAX_DELAY_S);
    r.probe_jams = out.map(({ _mid, _len, _exact, ...j }) => j);
    r.probe_delay = r.traffic ? 0 : delay;
    if (!r.traffic && delay) {
      r.duration += delay;
      if (Array.isArray(r.steps) && r.steps.length) {
        // The drive screen counts down the steps plus route.delay, so the probe delay is spread over the
        // steps each jam covers (like applyTraffic does for TomTom), instead of living only in the list total.
        const scale = exact > 0 ? delay / exact : 0;
        for (const j of out) {
          const a = j._mid - j._len / 2, b = j._mid + j._len / 2, span = Math.max(j._len, 1);
          const share = j._exact * scale;
          r.steps.forEach((s) => {
            const overlap = Math.min(b, cum[s.end]) - Math.max(a, cum[s.begin]);
            if (overlap > 0) s.time += (share * overlap) / span;
          });
        }
      } // no steps (tests): the duration above carries the ETA on its own
    }
    r.slow = [
      ...(r.traffic?.delay ? [{ kind: 'live', delay: r.traffic.delay }] : []),
      ...(r.delay ? [{ kind: 'report', delay: r.delay }] : []),
      ...(delay ? [{ kind: 'probe', delay }] : []),
    ];
  }
  return routes;
}

const round = (f) => Math.round(Math.min(1, Math.max(0, f)) * 10000) / 10000;
