// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Email verification for new accounts.
// Admin knob: EMAIL_VERIFICATION=false | optional | required (see wrangler.toml and .dev.vars.example).
//   off/optional: signup logs the driver straight in (optional still sends the email so they can confirm it).
//   required:    signup creates the account but no session; login stays blocked until the link is opened.
// Sending goes through Resend (RESEND_API_KEY secret + EMAIL_FROM var). With no key set the link is only
// logged server-side, so a self-hosted copy works without any email provider.

export function emailVerificationMode(env) {
  const v = String(env.EMAIL_VERIFICATION ?? 'false').trim().toLowerCase();
  if (['required', 'require', 'true', '1', 'on', 'yes', 'enforced'].includes(v)) return 'required';
  if (['optional', 'opt-in', 'notify', 'send'].includes(v)) return 'optional';
  return 'off';
}

export const emailVerificationRequired = (env) => emailVerificationMode(env) === 'required';

export function verificationBaseUrl(env, request) {
  const base = String(env.APP_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (base) return base;
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

export function verificationLink(env, request, token) {
  return `${verificationBaseUrl(env, request)}/verify/${token}`;
}

export async function sendVerificationEmail(env, to, token, request) {
  const link = verificationLink(env, request, token);
  const from = String(env.EMAIL_FROM ?? '').trim();
  const key = String(env.RESEND_API_KEY ?? '').trim();
  if (!key || !from) {
    console.log(`[a2b] email not configured — verification link for ${to}: ${link}`);
    return { sent: false, logged: true };
  }
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        subject: 'Verify your A2B email',
        text: `Welcome to A2B! Open this link to verify your email (it expires in 24 hours):\n\n${link}\n\nIf you didn't sign up, ignore this email.`,
        html: `<p>Welcome to A2B! Open the link below to verify your email (it expires in 24 hours):</p><p><a href="${link}">${link}</a></p><p>If you didn't sign up, ignore this email.</p>`,
      }),
    });
  } catch (e) {
    console.error('a2b: verification email request failed', e?.message ?? e);
    throw e;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '').then((t) => t.slice(0, 300));
    console.error('a2b: verification email refused', res.status, detail);
    throw new Error(`Email provider refused the message (${res.status}).`);
  }
  return { sent: true };
}
