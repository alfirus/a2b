// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Opt-in probe traffic: consent gating, anonymous aggregation, sparse-data guards, anti-gaming,
// opposite-carriageway separation, route slowdowns with a "why slow" breakdown, and nightly expiry.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createD1 } from './d1-shim.js';
import { segmentKey, segmentCell, levelFor, validPoint, probesRepo, annotateWithProbes, PROBE_MIN_POINTS, PROBE_MIN_DEVICES } from '../src/lib/probes.js';
import { encodePolyline as encode } from '../public/geo.js';

// ---------- Fake upstream services (routing only; no TomTom key, like a fresh deploy) ----------
const LINE = Array.from({ length: 21 }, (_, i) => [13.4, 52.5 + 0.00045 * i]); // ~1 km north

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/route')) {
    const body = JSON.parse(init.body);
    const [from, to] = body.locations;
    const line = LINE.filter(([, lat]) => lat >= Math.min(from.lat, to.lat) - 0.001 && lat <= Math.max(from.lat, to.lat) + 0.001);
    const coords = line.length > 1 ? line : LINE;
    return Response.json({
      trip: {
        summary: { length: 1, time: 120, has_toll: false, has_highway: false, has_ferry: false },
        legs: [{
          shape: encode(coords),
          maneuvers: [
            { type: 1, instruction: 'Drive north.', verbal_pre_transition_instruction: 'Drive north.', street_names: ['Test Street'], begin_shape_index: 0, end_shape_index: coords.length - 1, length: 1, time: 120 },
            { type: 4, instruction: 'You have arrived.', verbal_pre_transition_instruction: 'Arrived.', begin_shape_index: coords.length - 1, end_shape_index: coords.length - 1, length: 0, time: 0 },
          ],
        }],
      },
    });
  }
  if (u.includes('/trace_attributes')) return Response.json({ edges: [] });
  throw new Error(`unexpected fetch ${u}`);
};

const ASSETS = {
  async fetch() {
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  },
};
const env = { DB: createD1(), ASSETS, ROUTING_URL: 'https://routing.test/route', GEOCODER_URL: 'https://geo.test' };

function client(device) {
  let cookie = '';
  return async (method, path, body) => {
    const headers = device ? { 'x-a2b-device': device } : {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://a2b.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

// Probe writes need a checked-in device (needSpot), like every other heavy endpoint: check in first.
async function driver(device) {
  const c = client(device);
  const res = await c('POST', '/api/presence', {});
  assert.equal(res.status, 200, 'test device checks in');
  assert.ok(res.body.admitted, 'test device is admitted');
  return c;
}

const slowFix = (lat, lng = 13.4, speed = 4, heading = 0) => ({ lat, lng, speed, heading, accuracy: 8, at: Date.now() });
const cellFixes = (lat, n, opts = {}) => Array.from({ length: n }, (_, i) => slowFix(lat + i * 0.00002, opts.lng ?? 13.4, opts.speed ?? 4, opts.heading ?? 0));

before(async () => {
  await env.DB.prepare('SELECT 1').first().catch(() => {});
});

// Each worker test starts with empty probe tables: blocks from one test never leak into another.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM probe_segments').run().catch(() => {});
  await env.DB.prepare('DELETE FROM probe_devices').run().catch(() => {});
  await env.DB.prepare('DELETE FROM probe_limits').run().catch(() => {});
});

// ---------- Pure helpers ----------
test('probe blocks quantize position and split directions', () => {
  assert.equal(segmentKey(52.5004, 13.4004, 10), segmentKey(52.5009, 13.4009, 80), 'same block, same slice');
  assert.notEqual(segmentKey(52.5004, 13.4004, 10), segmentKey(52.5004, 13.4004, 190), 'opposite carriageway lands apart');
  assert.notEqual(segmentKey(52.5004, 13.4004, 10), segmentKey(52.5024, 13.4004, 10), 'next block lands apart');
  const cell = segmentCell(segmentKey(52.5004, 13.4004, 10));
  assert.ok(Math.abs(cell.lat - 52.5005) < 1e-9 && Math.abs(cell.lng - 13.4005) < 1e-9, 'stored position is the block centre');
});

test('probe congestion levels and fix validation', () => {
  assert.equal(levelFor(30 / 3.6), 0, 'flowing at 30 km/h');
  assert.equal(levelFor(17 / 3.6), 2, 'queuing below 18 km/h');
  assert.equal(levelFor(8 / 3.6), 3, 'crawling below 9 km/h');
  assert.ok(validPoint(slowFix(52.5)));
  assert.equal(validPoint({ ...slowFix(52.5), speed: 60 }), null, 'faster than ~200 km/h is a glitch');
  assert.equal(validPoint({ ...slowFix(52.5), speed: 0 }), null, 'standing still carries no signal');
  assert.equal(validPoint({ ...slowFix(52.5), heading: NaN }), null, 'a fix without heading cannot pick a side');
  assert.equal(validPoint({ ...slowFix(52.5), accuracy: 500 }), null, 'a vague fix is useless');
  assert.equal(validPoint({ ...slowFix(52.5), at: Date.now() - 3600_000 }), null, 'stale fixes are dropped');
});

// ---------- Endpoint: consent and devices ----------
test('probe batches need a device and per-batch consent', async () => {
  assert.equal((await client()('POST', '/api/probe', { consent: true, points: [slowFix(52.5)] })).status, 400, 'no device id');
  const noConsent = await driver('probe-dev-noconsent');
  assert.equal((await noConsent('POST', '/api/probe', { points: [slowFix(52.5)] })).status, 403, 'consent flag missing');
  assert.equal((await noConsent('POST', '/api/probe', { consent: false, points: [slowFix(52.5)] })).status, 403, 'consent refused');
  const empty = await (await driver('probe-dev-empty'))('POST', '/api/probe', { consent: true, points: 'not-a-list' });
  assert.equal(empty.status, 202);
  assert.equal(empty.body.stored, 0);
});

// ---------- Aggregation: anonymous, averaged, rate-capped ----------
test('probe batches fold into anonymous block totals', async () => {
  const d = await driver('probe-dev-agg1');
  const r = await d('POST', '/api/probe', { consent: true, points: cellFixes(52.502, 6) });
  assert.equal(r.status, 202);
  assert.equal(r.body.stored, 6);
  const rows = (await env.DB.prepare('SELECT * FROM probe_segments').all()).results;
  assert.equal(rows.length, 1, 'one batch in one block is one row');
  const row = rows[0];
  assert.ok(Math.abs(row.avg_speed - 4) < 1e-9, 'running average of the fixes');
  assert.equal(row.probes, 6);
  assert.ok(Math.abs(row.lat - 52.5025) < 1e-9, 'block centre stored, never the raw fix');
  const devs = (await env.DB.prepare('SELECT * FROM probe_devices').all()).results;
  assert.equal(devs.length, 1, 'one device row for the one driver');
  assert.ok(devs[0].device_hash && !devs[0].device_hash.includes('probe-dev'), 'driver stored as a hash, not the device');
  const raw = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((t) => t.name);
  assert.ok(!raw.some((t) => /fix|trace|position|gps/i.test(t)), 'no table keeps raw fixes');
});

test('probe writes need a checked-in device', async () => {
  const r = await client('probe-dev-stranger')('POST', '/api/probe', { consent: true, points: [slowFix(52.5)] });
  assert.equal(r.status, 503, 'a device that never checked in takes no spot');
});

test('probe devices are rate-capped but not traced', async () => {
  const c = await driver('probe-dev-cap');
  assert.equal((await c('POST', '/api/probe', { consent: true, points: [slowFix(52.503)] })).status, 202);
  assert.equal((await c('POST', '/api/probe', { consent: true, points: [slowFix(52.503)] })).status, 429, 'a second instant batch is too fast');
  const lim = (await env.DB.prepare('SELECT * FROM probe_limits').all()).results;
  assert.ok(lim.length >= 1 && lim.every((l) => l.device_hash && !l.device_hash.includes('probe-dev')), 'rate state keeps a hash, not the device');
});

// ---------- Quality: sparse data, anomalies, parked cars ----------
test('sparse blocks never count as congested', async () => {
  const d = await driver('probe-dev-sparse');
  await d('POST', '/api/probe', { consent: true, points: cellFixes(52.62, PROBE_MIN_POINTS - 1, { lng: 13.5 }) });
  const segs = await probesRepo(env.DB).congested([13.4, 52.61, 13.6, 52.63]);
  assert.equal(segs.length, 0, `${PROBE_MIN_POINTS - 1} fixes stay silent`);
});

test('one driver flooding fixes cannot fake a jam', async () => {
  const d = await driver('probe-dev-spam');
  const r = await d('POST', '/api/probe', { consent: true, points: cellFixes(52.621, 12, { lng: 13.5 }) });
  assert.equal(r.status, 202, 'a full batch is accepted');
  const segs = await probesRepo(env.DB).congested([13.4, 52.61, 13.6, 52.63]);
  assert.equal(segs.length, 0, 'a dozen fixes from one driver stay silent');
});

test('a driver counts once per block, however often they pass it', async () => {
  const repo = probesRepo(env.DB);
  const t0 = Date.now();
  await repo.contribute('hash-same-driver', cellFixes(52.622, 6, { lng: 13.5 }), t0);
  await repo.contribute('hash-same-driver', cellFixes(52.622, 6, { lng: 13.5 }), t0 + 60_000);
  await repo.contribute('hash-second-driver', cellFixes(52.622, 6, { lng: 13.5 }), t0 + 60_000);
  const segs = await repo.congested([13.4, 52.61, 13.6, 52.63], t0 + 60_000);
  assert.equal(segs.length, 0, `two batches from one driver plus one more is only two drivers, below ${PROBE_MIN_DEVICES}`);
  await repo.contribute('hash-third-driver', cellFixes(52.622, 6, { lng: 13.5 }), t0 + 120_000);
  const now = await repo.congested([13.4, 52.61, 13.6, 52.63], t0 + 120_000);
  assert.equal(now.length, 1, 'three distinct drivers mark the block');
});

test('glitches and parked cars are ignored', async () => {
  const c = await driver('probe-dev-glitch');
  const now = Date.now();
  const r = await c('POST', '/api/probe', {
    consent: true,
    points: [
      { ...slowFix(52.63, 13.5), at: now - 10000 },
      { ...slowFix(52.64, 13.5), at: now }, // ~11 km in 10 s: a teleport, dropped
      { ...slowFix(52.631, 13.5), speed: 300, at: now }, // absurd speed, dropped
      { ...slowFix(52.632, 13.5), speed: 0, at: now }, // parked, carries no signal
    ],
  });
  assert.equal(r.body.stored, 1, 'only the honest fix survives');
});

// ---------- Opposite carriageway ----------
test('the other side of the road does not slow your route', async () => {
  await (await driver('probe-dev-south1'))('POST', '/api/probe', { consent: true, points: cellFixes(52.507, 6, { heading: 180 }) });
  await (await driver('probe-dev-south2'))('POST', '/api/probe', { consent: true, points: cellFixes(52.507, 6, { heading: 180 }) });
  await (await driver('probe-dev-south3'))('POST', '/api/probe', { consent: true, points: cellFixes(52.507, 6, { heading: 180 }) });
  const anon = client();
  const r = await anon('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509], heading: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.routes[0].probe_jams.length, 0, 'southbound crawl stays off the northbound route');
});

// ---------- Route integration: ETA, colouring data, why-slow ----------
test('crawling blocks slow the route and say why', async () => {
  // Two cells along the test street, each with enough slow fixes from three drivers.
  for (const [dev, lat] of [['probe-dev-n1', 52.503], ['probe-dev-n2', 52.503], ['probe-dev-n3', 52.503], ['probe-dev-n4', 52.505], ['probe-dev-n5', 52.505], ['probe-dev-n6', 52.505]]) {
    await (await driver(dev))('POST', '/api/probe', { consent: true, points: cellFixes(lat, 6) });
  }
  const r = await client()('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509], heading: 0 });
  assert.equal(r.status, 200);
  const route = r.body.routes[0];
  assert.ok(route.probe_jams.length >= 1, 'slow blocks become jams on the route');
  assert.ok(route.probe_delay > 0, 'the crawl adds seconds');
  assert.ok(route.duration >= 120 + route.probe_delay, 'ETA includes the probe delay');
  assert.ok(route.slow.some((s) => s.kind === 'probe' && s.delay === route.probe_delay), 'why-slow names probes');
  for (const j of route.probe_jams) {
    assert.ok(j.from >= 0 && j.to <= 1 && j.to >= j.from, 'jam fractions sit on the route');
    assert.ok([1, 2, 3].includes(j.level), 'jam level is slow, queuing or stationary');
  }
});

test('fast blocks and old blocks do not slow the route', async () => {
  await (await driver('probe-dev-fast'))('POST', '/api/probe', { consent: true, points: cellFixes(52.7, 6, { lng: 13.6, speed: 15 }) });
  await env.DB.prepare(
    'INSERT INTO probe_segments (segment, lat, lng, dir, avg_speed, probes, window_start, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind('old,block,0', 52.701, 13.601, 0, 2, 50, Date.now() - 3600_000, Date.now() - 3600_000).run();
  const segs = await probesRepo(env.DB).congested([13.5, 52.69, 13.7, 52.71]);
  assert.equal(segs.length, 0, 'flowing traffic and stale totals are invisible');
});

test('annotateWithProbes spreads the delay over steps so the drive countdown agrees', () => {
  const routes = [{ coords: [[0, 0], [0.01, 0]], duration: 100, steps: [{ begin: 0, end: 1, time: 100 }], traffic: null }];
  annotateWithProbes(routes, [
    { lng: 0.005, lat: 0, dir: 4, avg_speed: 3, probes: 9, level: 2 },
  ]);
  const [r] = routes;
  assert.ok(r.probe_delay > 0, 'the crawl adds seconds');
  assert.equal(r.duration, 100 + r.probe_delay);
  const stepsTotal = r.steps.reduce((x, s) => x + s.time, 0);
  assert.ok(Math.abs(stepsTotal - r.duration) < 0.01, 'steps carry the probe delay, the way TomTom timing does');
  assert.ok(!('_mid' in r.probe_jams[0]) && !('_len' in r.probe_jams[0]) && !('_exact' in r.probe_jams[0]), 'no working fields leak into probe_jams');
});

test('annotateWithProbes merges nearby blocks into one jam', () => {
  const routes = [{ coords: [[0, 0], [0.01, 0]], duration: 100, traffic: null }];
  annotateWithProbes(routes, [
    { lng: 0.002, lat: 0, dir: 4, avg_speed: 3, probes: 9, level: 2 },
    { lng: 0.003, lat: 0, dir: 4, avg_speed: 2, probes: 9, level: 3 },
    { lng: 0.009, lat: 0, dir: 4, avg_speed: 3, probes: 9, level: 2 },
  ]);
  const [r] = routes;
  assert.equal(r.probe_jams.length, 2, 'a far block is its own jam');
  assert.equal(r.probe_jams[0].level, 3, 'the merged jam takes the worst crawl');
  assert.ok(r.probe_delay > 0 && r.duration === 100 + r.probe_delay);
});

// ---------- Retention and settings ----------
test('the nightly job deletes old probe data', async () => {
  const now = Date.now();
  const insert = (seg, lat, at) => env.DB.prepare(
    'INSERT INTO probe_segments (segment, lat, lng, dir, avg_speed, probes, window_start, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(seg, lat, 13.4, 0, 3, 9, at, at).run();
  await insert('fresh-seg-0', 52.51, now);
  await insert('old-seg-0', 52.52, now - 25 * 3600_000);
  const insertDev = (seg, hash, at) => env.DB.prepare(
    'INSERT INTO probe_devices (segment, device_hash, updated_at) VALUES (?, ?, ?)',
  ).bind(seg, hash, at).run();
  await insertDev('fresh-seg-0', 'hash-fresh', now);
  await insertDev('old-seg-0', 'hash-old', now - 25 * 3600_000);
  await worker.scheduled({}, env);
  const left = (await env.DB.prepare('SELECT segment FROM probe_segments').all()).results.map((r) => r.segment);
  assert.deepEqual(left, ['fresh-seg-0'], 'old blocks are gone, fresh ones stay');
  const leftDevs = (await env.DB.prepare('SELECT device_hash FROM probe_devices').all()).results.map((r) => r.device_hash);
  assert.deepEqual(leftDevs, ['hash-fresh'], 'old driver rows are gone, fresh ones stay');
});

test('traffic_probe is a synced account setting, off by default', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { email: 'probe@test.com', password: 'password1', name: 'Probo' });
  assert.equal((await c('GET', '/api/me')).body.user.settings.traffic_probe ?? false, false);
  const r = await c('PATCH', '/api/me', { settings: { traffic_probe: true } });
  assert.equal(r.body.user.settings.traffic_probe, true);
});
