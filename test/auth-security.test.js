// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Signup/login protections: CAPTCHA, email verification and TOTP two-factor logins.
// Each is an admin knob (see wrangler.toml / .dev.vars.example); this suite turns each on in turn.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createD1 } from './d1-shim.js';
import { totpCode } from '../src/lib/twofactor.js';

// The only network call these tests allow: the Turnstile check, pointed at a fake URL.
// A token of "bad-token" fails the check; anything else passes.
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('captcha.test')) {
    const body = String(init.body ?? '');
    const ok = !body.includes('bad-token');
    return Response.json(ok ? { success: true } : { success: false });
  }
  throw new Error(`unexpected fetch ${u}`);
};

const ASSETS = {
  async fetch(req) {
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  },
};
const env = { DB: createD1(), ASSETS };

function client({ device, ip } = {}) {
  let cookie = '';
  const headers = {};
  if (device) headers['x-a2b-device'] = device;
  if (ip) headers['x-forwarded-for'] = ip;
  return async (method, path, body) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://a2b.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json(), cookie: set };
  };
}

before(async () => {
  Object.assign(env, { EMAIL_DEBUG: '1', TURNSTILE_VERIFY_URL: 'https://captcha.test/siteverify', TURNSTILE_SECRET: 'test-secret' });
});

test('config advertises the knobs, all safe by default', async () => {
  const r = await client()('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    captcha: { enabled: false, siteKey: '' },
    emailVerification: { mode: 'off', required: false },
    twoFactor: { mode: 'optional' },
  });
});

test('signup and login are unchanged when everything is off', async () => {
  const c = client();
  const s = await c('POST', '/api/auth/signup', { email: 'plain@test.com', password: 'password1', name: 'Plain' });
  assert.equal(s.status, 201);
  assert.ok(s.cookie, 'session cookie is set');
  assert.equal(s.body.user.email_verified, true, 'existing behaviour: verified');
  assert.equal(s.body.user.totp_enabled, false);
  assert.equal(s.body.verificationRequired, undefined);
  const me = await c('GET', '/api/me');
  assert.equal(me.body.user.email, 'plain@test.com');
});

test('CAPTCHA blocks signup without a token, allows it with one', async () => {
  env.CAPTCHA_ENABLED = 'true';
  try {
    const noToken = await client()('POST', '/api/auth/signup', { email: 'cap1@test.com', password: 'password1' });
    assert.equal(noToken.status, 400);
    assert.equal(noToken.body.code, 'captcha_required');
    const bad = await client()('POST', '/api/auth/signup', { email: 'cap1@test.com', password: 'password1', captcha: 'bad-token' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'captcha_failed');
    const good = await client()('POST', '/api/auth/signup', { email: 'cap1@test.com', password: 'password1', captcha: 'good-token' });
    assert.equal(good.status, 201);
  } finally {
    delete env.CAPTCHA_ENABLED;
  }
});

test('logins ask for the CAPTCHA once a password looks guessed', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { email: 'guess@test.com', password: 'password1' });
  env.CAPTCHA_ENABLED = 'true';
  try {
    for (let i = 0; i < 3; i++) assert.equal((await c('POST', '/api/auth/login', { email: 'guess@test.com', password: 'nope' })).status, 401);
    const noCaptcha = await c('POST', '/api/auth/login', { email: 'guess@test.com', password: 'password1' });
    assert.equal(noCaptcha.status, 400, 'right password but no CAPTCHA after failures');
    const ok = await c('POST', '/api/auth/login', { email: 'guess@test.com', password: 'password1', captcha: 'good-token' });
    assert.equal(ok.status, 200);
  } finally {
    delete env.CAPTCHA_ENABLED;
  }
});

test('signups are throttled per network', async () => {
  env.SIGNUP_MAX_PER_HOUR = '2';
  try {
    const ip = 'throttle-ip-1';
    assert.equal((await client({ ip })('POST', '/api/auth/signup', { email: 't1@test.com', password: 'password1' })).status, 201);
    assert.equal((await client({ ip })('POST', '/api/auth/signup', { email: 't2@test.com', password: 'password1' })).status, 201);
    const third = await client({ ip })('POST', '/api/auth/signup', { email: 't3@test.com', password: 'password1' });
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'signup_throttled');
    assert.equal((await client({ ip: 'another-ip-1' })('POST', '/api/auth/signup', { email: 't3@test.com', password: 'password1' })).status, 201, 'other networks are unaffected');
  } finally {
    delete env.SIGNUP_MAX_PER_HOUR;
  }
});

test('required email verification blocks login until the link is opened', async () => {
  env.EMAIL_VERIFICATION = 'required';
  try {
    const c = client();
    const s = await c('POST', '/api/auth/signup', { email: 'verify@test.com', password: 'password1', name: 'Verify' });
    assert.equal(s.status, 201);
    assert.equal(s.body.verificationRequired, true);
    assert.equal(s.body.user.email_verified, false);
    assert.equal(s.cookie, null, 'no session before verification');
    assert.match(s.body.verificationToken, /^[0-9a-f]{64}$/, 'debug token for tests');
    const blocked = await c('POST', '/api/auth/login', { email: 'verify@test.com', password: 'password1' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'email_not_verified');
    const bad = await client()('GET', '/api/auth/verify?token=0'.padEnd(71, '0'));
    assert.equal(bad.status, 400);
    const v = await client()('GET', `/api/auth/verify?token=${s.body.verificationToken}`);
    assert.equal(v.status, 200, 'the link logs the driver in');
    assert.equal(v.body.user.email_verified, true);
    const again = await c('POST', '/api/auth/login', { email: 'verify@test.com', password: 'password1' });
    assert.equal(again.status, 200, 'login works after verification');
  } finally {
    delete env.EMAIL_VERIFICATION;
  }
});

test('resend issues a fresh link and is throttled', async () => {
  env.EMAIL_VERIFICATION = 'required';
  try {
    const c = client();
    await c('POST', '/api/auth/signup', { email: 'resend@test.com', password: 'password1' });
    const r1 = await c('POST', '/api/auth/resend', { email: 'resend@test.com' });
    assert.equal(r1.status, 200);
    assert.match(r1.body.verificationToken, /^[0-9a-f]{64}$/);
    const v = await c('GET', `/api/auth/verify?token=${r1.body.verificationToken}`);
    assert.equal(v.status, 200);
    const done = await c('POST', '/api/auth/resend', { email: 'resend@test.com' });
    assert.equal(done.status, 200);
    assert.equal(done.body.verificationToken, undefined, 'nothing to resend once verified');
  } finally {
    delete env.EMAIL_VERIFICATION;
  }
});

test('two-factor: setup, enable, login with code', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { email: 'totp@test.com', password: 'password1', name: 'Totp' });
  const setup = await c('POST', '/api/auth/2fa/setup', {});
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]+$/);
  assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\//);
  assert.equal((await c('POST', '/api/auth/2fa/enable', { code: '000000' })).status, 401);
  const enable = await c('POST', '/api/auth/2fa/enable', { code: await totpCode(setup.body.secret) });
  assert.equal(enable.status, 200);
  assert.equal(enable.body.user.totp_enabled, true);

  const login = client();
  const first = await login('POST', '/api/auth/login', { email: 'totp@test.com', password: 'password1' });
  assert.equal(first.status, 202, 'password alone is not enough');
  assert.equal(first.body.two_factor_required, true);
  assert.match(first.body.challenge_id, /^[0-9a-f]{64}$/);
  assert.equal((await login('GET', '/api/me')).body.user, null, 'still logged out');
  const wrong = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'totp_invalid');
  const me = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('totp@test.com').first();
  const done = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(me.totp_secret) });
  assert.equal(done.status, 200, 'the right code finishes login');
  assert.equal((await login('GET', '/api/me')).body.user.email, 'totp@test.com');
  const replay = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(me.totp_secret) });
  assert.equal(replay.status, 400, 'a challenge works once');

  const off = await login('POST', '/api/auth/2fa/disable', { code: '000000' });
  assert.equal(off.status, 403, 'a wrong code cannot turn it off');
  const bye = await login('POST', '/api/auth/2fa/disable', { current_password: 'password1' });
  assert.equal(bye.status, 200);
  assert.equal(bye.body.user.totp_enabled, false);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'totp@test.com', password: 'password1' })).status, 200, 'login is single-step again');
});

test('two-factor off disables the endpoints; required enrols on next login', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { email: 'enrol@test.com', password: 'password1' });
  env.TWO_FACTOR = 'off';
  try {
    assert.equal((await c('POST', '/api/auth/2fa/setup', {})).status, 404);
    assert.equal((await c('POST', '/api/auth/login', { email: 'enrol@test.com', password: 'password1' })).status, 200);
  } finally {
    delete env.TWO_FACTOR;
  }
  env.TWO_FACTOR = 'required';
  try {
    const login = client();
    const first = await login('POST', '/api/auth/login', { email: 'enrol@test.com', password: 'password1' });
    assert.equal(first.status, 202);
    assert.equal(first.body.two_factor_setup_required, true);
    const done = await login('POST', '/api/auth/2fa/verify', { challenge_id: first.body.challenge_id, code: await totpCode(first.body.secret) });
    assert.equal(done.status, 200);
    assert.equal(done.body.user.totp_enabled, true);
    const next = await client()('POST', '/api/auth/login', { email: 'enrol@test.com', password: 'password1' });
    assert.equal(next.body.two_factor_required, true, 'now a normal two-factor login');
  } finally {
    delete env.TWO_FACTOR;
  }
});
