// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// CAPTCHA on signup (and on login once a password looks guessed).
// Admin knob: CAPTCHA_ENABLED=true plus TURNSTILE_SITEKEY (public) and TURNSTILE_SECRET (wrangler secret).
// Off by default: when disabled this module is a no-op and never touches the network.

import { httpError } from './providers.js';

export function captchaEnabled(env) {
  return ['1', 'true', 'on', 'yes', 'required'].includes(String(env.CAPTCHA_ENABLED ?? '').trim().toLowerCase());
}

export function captchaSiteKey(env) {
  return String(env.TURNSTILE_SITEKEY ?? '').trim();
}

// Throws 400 when the token is missing or fails Cloudflare's check. Never called when disabled.
export async function verifyCaptcha(env, token, ip) {
  if (!captchaEnabled(env)) return;
  const t = String(token ?? '').trim();
  if (!t) {
    throw Object.assign(httpError('Complete the CAPTCHA and try again.', 400), { code: 'captcha_required' });
  }
  const secret = String(env.TURNSTILE_SECRET ?? '').trim();
  if (!secret) {
    console.error('a2b: CAPTCHA_ENABLED is on but TURNSTILE_SECRET is not set');
    throw Object.assign(httpError('Sign-up checks are misconfigured. Try again later.', 503), { code: 'captcha_misconfigured' });
  }
  const verifyURL = String(env.TURNSTILE_VERIFY_URL ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify').trim();
  let res;
  try {
    const form = new URLSearchParams({ secret, response: t });
    if (ip) form.set('remoteip', ip);
    res = await fetch(verifyURL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  } catch (e) {
    console.error('a2b: CAPTCHA verify request failed', e?.message ?? e);
    throw Object.assign(httpError("Couldn't check the CAPTCHA. Try again in a moment.", 503), { code: 'captcha_unavailable' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success !== true) {
    throw Object.assign(httpError('That CAPTCHA check failed. Try again.', 400), { code: 'captcha_failed' });
  }
}
