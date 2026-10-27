// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// "My A2B" menu, sign in / sign up, settings, saved places, leaderboard and about.

import { $, state, api, appConfig, local, toast, esc, initials, saveSettings, setHomeWork, removePlace, renamePlace, armBack, speak } from './core.js';
import { pickVoice } from './voice.js';
import { appVersion } from './update.js';
import { VEHICLES, COLORS, DEFAULT_COLOR } from './vehicle3d.js';
import { onlineLine } from './presence.js';

let ctx; // callbacks from app.js
let authMode = 'signup';
let authReason = null;
let installPrompt = null;
let pendingChallenge = null; // second login step: { id, setup, secret, otpauth_url }
let turnstileWidget = null;

export function initPanels(callbacks) {
  ctx = callbacks;
  $('menu-backdrop').onclick = closeMenu;
  $('m-settings').onclick = () => (closeMenu(), openSettings());
  $('m-places').onclick = () => (closeMenu(), openSavedPlaces());
  $('m-leaders').onclick = () => (closeMenu(), openLeaders());
  $('m-about').onclick = () => (closeMenu(), openAbout());
  $('m-logout').onclick = logout;
  $('m-install').onclick = install;
  $('auth-switch').onclick = () => setAuthMode(authMode === 'signup' ? 'login' : 'signup');
  $('auth-form').onsubmit = submitAuth;
  $('auth-resend').onclick = async () => {
    const email = new FormData($('auth-form')).get('email');
    try {
      await api('/api/auth/resend', { method: 'POST', body: { email } });
      toast('Email sent — if that address still needs verifying, the link is on its way.');
    } catch (e) {
      toast(e.message);
    }
  };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });
}

export async function refreshMe() {
  try {
    const { user, stats, tester } = await api('/api/me');
    state.user = user;
    state.stats = stats ?? null;
    state.tester = Boolean(tester);
    if (user) {
      // The account's settings win over this device's, so they follow the driver between phones.
      Object.assign(state.settings, user.settings);
      local.set('settings', state.settings);
    }
  } catch {
    state.user = null;
    state.tester = false;
  }
  if (!state.tester) state.simulate = false; // testing tools only for tester accounts
}

export function renderAvatar() {
  $('avatar').textContent = state.user ? initials(state.user.name) : '?';
  $('m-logout').classList.toggle('hidden', !state.user);
}

// ================= Menu =================
export function openMenu() {
  renderProfile();
  $('m-online').innerHTML = onlineLine();
  $('menu').classList.remove('hidden');
  $('menu-backdrop').classList.remove('hidden');
  armBack();
  if (state.user) refreshMe().then(renderProfile);
}

function closeMenu() {
  $('menu').classList.add('hidden');
  $('menu-backdrop').classList.add('hidden');
}

function renderProfile() {
  const box = $('profile');
  const u = state.user;
  if (!u) {
    box.innerHTML = `<div class="who"><span class="avatar">?</span><div><b>Guest driver</b><small>Sign up to report, earn points and keep your places on every device.</small></div></div>
      <div class="sheet-actions" style="margin-top:4px"><button class="btn ghost small" id="p-login">Log in</button><button class="btn primary small" id="p-signup">Sign up</button></div>`;
    $('p-login').onclick = () => (closeMenu(), openAuth(null, 'login'));
    $('p-signup').onclick = () => (closeMenu(), openAuth(null, 'signup'));
    return;
  }
  const s = state.stats ?? { reports: 0, thanks: 0 };
  box.innerHTML = `<div class="who"><span class="avatar">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b><small>${esc(u.email)}</small></div></div>
    <div class="stats"><div class="stat"><b>${u.points}</b><small>points</small></div><div class="stat"><b>${s.reports}</b><small>reports</small></div><div class="stat"><b>${s.thanks}</b><small>thanks</small></div></div>`;
}

// ================= Auth =================
const REASONS = {
  report: 'Sign up to report what you see. Other drivers can thank you, and you earn points.',
  vote: 'Sign up to confirm or dismiss reports from other drivers.',
  share: 'Sign up to share your drive and ETA with friends.',
};

export function openAuth(reason = null, mode = 'signup') {
  authReason = reason;
  setAuthMode(mode);
  $('auth-why').textContent = REASONS[reason] ?? 'Join other drivers. Report what you see on the road and get thanked for it.';
  $('auth-error').classList.add('hidden');
  $('auth').classList.remove('hidden');
  armBack();
}

function setAuthMode(mode) {
  authMode = mode;
  pendingChallenge = null;
  const signup = mode === 'signup';
  $('auth-title').textContent = signup ? 'Sign up' : 'Log in';
  $('auth-submit').textContent = signup ? 'Create account' : 'Log in';
  $('auth-switch').textContent = signup ? 'Already have an account? Log in' : 'New here? Create an account';
  document.querySelector('#auth-form .name-row').classList.toggle('hidden', !signup);
  document.querySelector('#auth-form [name=password]').autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-2fa-row').classList.add('hidden');
  $('auth-verify-note').classList.add('hidden');
  $('auth-resend').classList.add('hidden');
  $('auth-error').classList.add('hidden');
  renderCaptcha();
}

// Cloudflare Turnstile, only when the server switched it on (see /api/config).
function renderCaptcha() {
  const box = $('captcha-box');
  box.innerHTML = '';
  box.classList.add('hidden');
  turnstileWidget = null;
  const cfg = appConfig?.captcha;
  if (!cfg?.enabled || !cfg?.siteKey) return;
  box.classList.remove('hidden');
  const render = () => {
    try {
      if (window.turnstile && box.isConnected) turnstileWidget = window.turnstile.render(box, { sitekey: cfg.siteKey });
    } catch {}
  };
  if (window.turnstile) render();
  else if (!document.querySelector('script[data-turnstile]')) {
    const s = document.createElement('script');
    s.dataset.turnstile = '1';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.defer = true;
    s.onload = render;
    document.head.appendChild(s);
  }
}

function captchaToken() {
  try {
    return window.turnstile && turnstileWidget !== null ? window.turnstile.getResponse(turnstileWidget) : '';
  } catch {
    return '';
  }
}

function resetCaptcha() {
  try {
    if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
  } catch {}
}

async function submitAuth(e) {
  e.preventDefault();
  const f = new FormData($('auth-form'));
  const btn = $('auth-submit');
  const label = pendingChallenge ? 'Verify code' : btn.textContent;
  const fields = $('auth-form').querySelectorAll('input, button');
  // Show progress in the button (and lock the form) so a slow network doesn't look like a frozen screen.
  const busy = (text) => (btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(text)}`);
  fields.forEach((x) => (x.disabled = true));
  btn.classList.add('busy');
  busy(authMode === 'signup' && !pendingChallenge ? 'Creating account…' : pendingChallenge ? 'Checking code…' : 'Logging in…');
  $('auth-error').classList.add('hidden');
  try {
    // Second login step: the password already passed, now the authenticator code.
    if (pendingChallenge) {
      await api('/api/auth/2fa/verify', { method: 'POST', body: { challenge_id: pendingChallenge.id, code: String(f.get('totp') ?? '').trim() } });
      pendingChallenge = null;
      await finishAuth('Welcome back');
      return;
    }
    const body = { email: f.get('email'), password: f.get('password') };
    if (authMode === 'signup') Object.assign(body, { name: f.get('name'), settings: state.settings });
    const captcha = captchaToken();
    if (captcha) body.captcha = captcha;
    const data = await api(`/api/auth/${authMode}`, { method: 'POST', body });
    if (data.verificationRequired) {
      // The account exists, but the inbox check comes first.
      setAuthMode('login');
      $('auth-verify-note').textContent = 'Check your email for the verification link (it lasts a day), then log in below.';
      $('auth-verify-note').classList.remove('hidden');
      $('auth-resend').classList.remove('hidden');
      toast('Check your email to verify the account');
      return;
    }
    if (data.two_factor_required || data.two_factor_setup_required) {
      pendingChallenge = { id: data.challenge_id, setup: Boolean(data.two_factor_setup_required) };
      $('auth-2fa-row').classList.remove('hidden');
      document.querySelector('#auth-form .name-row').classList.add('hidden');
      btn.textContent = 'Verify code';
      $('auth-switch').textContent = 'Back to log in';
      const note = $('auth-verify-note');
      if (data.two_factor_setup_required) {
        note.innerHTML = `Two-factor is now required: add this secret to your authenticator app, then enter the code.<br><b>${esc(data.secret)}</b>`;
      } else {
        note.textContent = 'Enter the 6-digit code from your authenticator app.';
      }
      note.classList.remove('hidden');
      // The auth-switch button doubles as "start over" while a challenge is pending.
      $('auth-switch').onclick = () => {
        pendingChallenge = null;
        $('auth-switch').onclick = () => setAuthMode(authMode === 'signup' ? 'login' : 'signup');
        setAuthMode('login');
      };
      return;
    }
    await refreshMe();
    if (authMode === 'signup') {
      busy('Copying your places…');
      await bringGuestPlaces();
    }
    $('auth').classList.add('hidden');
    $('auth-form').reset();
    await ctx.onUserChanged();
    ctx.applyTheme();
    ctx.refreshSound();
    toast(authMode === 'signup' ? `Welcome, ${state.user.name}!` : `Welcome back, ${state.user.name}!`);
    if (authReason === 'report') $('btn-report').click();
  } catch (err) {
    if (err.code === 'email_not_verified') {
      $('auth-verify-note').textContent = 'That email is not verified yet. Open the link in your inbox, or send it again below.';
      $('auth-verify-note').classList.remove('hidden');
      $('auth-resend').classList.remove('hidden');
    }
    $('auth-error').textContent = err.message;
    $('auth-error').classList.remove('hidden');
  } finally {
    resetCaptcha();
    fields.forEach((x) => (x.disabled = false));
    btn.classList.remove('busy');
    btn.textContent = pendingChallenge ? 'Verify code' : label;
  }
}

// The /verify/<token> link from the email lands here (see public/app.js).
export async function verifyEmailToken(token) {
  try {
    await api(`/api/auth/verify?token=${encodeURIComponent(token)}`, { method: 'GET' });
    await refreshMe();
    await ctx.onUserChanged();
    toast(`Email verified — welcome, ${state.user.name}!`);
  } catch (err) {
    toast(err.message);
    openAuth(null, 'login');
  }
}

async function finishAuth(greeting) {
  await refreshMe();
  $('auth').classList.add('hidden');
  $('auth-form').reset();
  await ctx.onUserChanged();
  ctx.applyTheme();
  ctx.refreshSound();
  toast(`${greeting}, ${state.user.name}!`);
}

// A brand-new account takes over everything the guest kept on this device: Home, Work, saved places and recent
// destinations. Once they're in the account they're cleared here, so logging out later doesn't bring back an old
// guest copy. If the copy fails, the guest's lists stay on the device untouched.
async function bringGuestPlaces() {
  const home = local.get('home'), work = local.get('work');
  const saved = local.get('saved', []), recent = local.get('recent', []);
  try {
    if (home) await setHomeWork('home', home);
    if (work) await setHomeWork('work', work);
    if (saved.length || recent.length) await api('/api/places/import', { method: 'POST', body: { saved, recent } });
    for (const k of ['home', 'work', 'saved', 'recent']) local.set(k, null);
  } catch {
    toast("Couldn't copy all your places into the account. They're still on this phone.");
  }
}

async function logout() {
  closeMenu();
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  state.user = null;
  state.stats = null;
  await ctx.onUserChanged();
  toast('Logged out');
}

// ================= Panels =================
function openPanel(title, html) {
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  $('panel').classList.remove('hidden');
  armBack();
  return $('panel-body');
}

// The voice directions are read in (see voice.js), with a sample to hear it.
function renderVoiceList() {
  const box = $('voice-list');
  const v = pickVoice();
  const name = !v ? 'No voice on this phone' : /\bdaniel\b/i.test(v.name) ? 'Daniel' : v.name;
  box.innerHTML = `<button class="set-row" id="voice-sample"><span>${esc(name)}<small>${v ? 'Tap to hear a sample' : 'Spoken directions need a text-to-speech voice'}</small></span></button>`;
  $('voice-sample').onclick = () => speak(state.settings.units === 'imperial' ? 'In a quarter mile, turn right. Then keep left.' : 'In 300 metres, turn right. Then keep left.', { force: true });
}

function toggleRow(key, label, sub = '') {
  return `<label class="set-row"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="switch" data-set="${key}" ${state.settings[key] ? 'checked' : ''}></label>`;
}

function choiceRow(key, label, options) {
  return `<div class="set-row"><span>${label}</span><div class="choice" data-choice="${key}">${options
    .map(([v, l]) => `<button data-v="${v}" class="${state.settings[key] === v ? 'on' : ''}">${l}</button>`)
    .join('')}</div></div>`;
}

export function openSettings() {
  const u = state.user;
  const body = openPanel('Settings', `
    <div class="set-group"><h3>Sound and alerts</h3>
      ${toggleRow('voice', 'Voice directions')}
      ${toggleRow('alerts', 'Report alerts while driving', 'Police, crashes, hazards and closures ahead')}
      ${toggleRow('speed_warning', 'Speeding warning', 'Speedometer turns red above the posted limit')}
    </div>
    <div class="set-group"><h3>Voice</h3><div id="voice-list"></div></div>
    <div class="set-group"><h3>Navigation</h3>
      ${toggleRow('avoid_tolls', 'Avoid toll roads')}
      ${toggleRow('avoid_highways', 'Avoid highways')}
      ${toggleRow('avoid_ferries', 'Avoid ferries')}
      <p class="hint" style="padding:4px 18px">Roads that other drivers report as closed are avoided automatically.</p>
    </div>
    <div class="set-group"><h3>Display</h3>
      ${choiceRow('units', 'Units', [['metric', 'km'], ['imperial', 'miles']])}
      ${choiceRow('theme', 'Map', [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']])}
      <div class="set-row"><span>Vehicle<small>How you appear on the map</small></span><div class="choice" id="s-vehicle">${VEHICLES
        .map(([v, l]) => `<button data-v="${v}" class="${local.get('vehicle', 'chevron') === v ? 'on' : ''}">${l}</button>`)
        .join('')}</div></div>
      <div class="set-row swatch-row"><span>Colour</span><div class="swatches" id="s-vehicle-color">${COLORS
        .map(([c, l]) => `<button data-c="${c}" aria-label="${l}" title="${l}" class="${local.get('vehicleColor', DEFAULT_COLOR) === c ? 'on' : ''}" style="--c:${c}"></button>`)
        .join('')}</div></div>
    </div>
    <div class="set-group"><h3>Places</h3>
      <button class="set-row" id="s-home"><span>Home<small>${esc(state.home?.address || state.home?.name || 'Not set')}</small></span></button>
      <button class="set-row" id="s-work"><span>Work<small>${esc(state.work?.address || state.work?.name || 'Not set')}</small></span></button>
    </div>
    ${u ? `<div class="set-group"><h3>Account</h3>
      <button class="set-row" id="s-name"><span>Display name<small>${esc(u.name)}</small></span></button>
      ${appConfig?.emailVerification?.mode && appConfig.emailVerification.mode !== 'off' && !u.email_verified ? `<button class="set-row" id="s-verify"><span>Verify email<small>${esc(u.email)} — open the link from your inbox</small></span></button>` : ''}
      ${appConfig?.twoFactor?.mode && appConfig.twoFactor.mode !== 'off' ? `<button class="set-row" id="s-2fa"><span>Two-factor authentication<small>${u.totp_enabled ? 'On: a code is asked at login' : 'Off: add an extra code at login'}</small></span></button>` : ''}
      <button class="set-row" id="s-pass"><span>Change password</span></button>
      <button class="set-row" id="s-delete" style="color:var(--danger)"><span>Delete account</span></button>
    </div>` : ''}
    <div class="set-group"><h3>Feedback</h3>
      <button class="set-row" id="s-feedback"><span>Send feedback<small>Ideas, bugs, a wrong road or a missing place. It goes straight to the developer.</small></span></button>
    </div>
    ${state.tester ? `<div class="set-group"><h3>Testing</h3>
      <button class="set-row" id="s-usage"><span>Usage<small>Who's on A2B now, and the last two weeks</small></span></button>
      <button class="set-row" id="s-inbox"><span>Feedback<small>What drivers sent from Settings</small></span></button>
      <label class="set-row"><span>Demo drive<small>Simulate GPS along the route. Handy for trying A2B at a desk.</small></span><input type="checkbox" class="switch" id="s-sim" ${state.simulate ? 'checked' : ''}></label>
      <div class="set-row${state.simulate ? '' : ' hidden'}" id="s-sim-speed-row"><span>Demo speed<small>How fast the demo car drives</small></span><div class="choice" id="s-sim-speed">${[1, 2, 4, 8]
        .map((v) => `<button data-v="${v}" class="${local.get('simSpeed', 1) === v ? 'on' : ''}">${v}×</button>`)
        .join('')}</div></div>
    </div>` : ''}`);

  body.querySelectorAll('[data-set]').forEach((c) => {
    c.onchange = async () => {
      await saveSettings({ [c.dataset.set]: c.checked });
      if (c.dataset.set === 'voice') ctx.refreshSound();
    };
  });
  body.querySelectorAll('[data-choice]').forEach((group) => {
    group.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      await saveSettings({ [group.dataset.choice]: b.dataset.v });
      if (group.dataset.choice === 'theme') ctx.applyTheme();
    };
  });
  renderVoiceList();
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => $('voice-list') && renderVoiceList();
  // Kept on this device: it's about how this screen looks.
  $('s-vehicle').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('s-vehicle').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    local.set('vehicle', b.dataset.v);
    ctx.setupVehicle();
  };
  $('s-vehicle-color').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('s-vehicle-color').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    local.set('vehicleColor', b.dataset.c);
    ctx.setupVehicle();
  };
  if (state.tester) {
    $('s-sim').onchange = (e) => {
      state.simulate = e.target.checked;
      local.set('simulate', state.simulate);
      $('s-sim-speed-row').classList.toggle('hidden', !state.simulate);
    };
    $('s-usage').onclick = openUsage;
    $('s-inbox').onclick = openInbox;
    // Testing aid: applies straight away, also to a demo drive already under way.
    $('s-sim-speed').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('s-sim-speed').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      local.set('simSpeed', Number(b.dataset.v));
      ctx.setSimSpeed(Number(b.dataset.v));
    };
  }
  $('s-feedback').onclick = openFeedback;
  $('s-home').onclick = () => homeWorkAction('home');
  $('s-work').onclick = () => homeWorkAction('work');
  if (u) {
    $('s-name').onclick = async () => {
      const name = prompt('Display name (other drivers see this on your reports)', u.name);
      if (!name?.trim()) return;
      try {
        state.user = (await api('/api/me', { method: 'PATCH', body: { name } })).user;
        renderAvatar();
        openSettings();
      } catch (e) {
        toast(e.message);
      }
    };
    if ($('s-verify')) $('s-verify').onclick = async () => {
      try {
        await api('/api/auth/resend', { method: 'POST', body: { email: u.email } });
        toast('Email sent — open the link in your inbox.');
      } catch (e) {
        toast(e.message);
      }
    };
    if ($('s-2fa')) $('s-2fa').onclick = async () => {
      try {
        if (!state.user.totp_enabled) {
          const { secret, otpauth_url } = await api('/api/auth/2fa/setup', { method: 'POST', body: {} });
          const code = prompt(`Add this secret to your authenticator app, then enter the 6-digit code:\n\n${secret}\n\n(or add the account from this link: ${otpauth_url})`);
          if (!code) return;
          state.user = (await api('/api/auth/2fa/enable', { method: 'POST', body: { code: code.trim() } })).user;
          toast('Two-factor is on');
        } else {
          const code = prompt('Enter a current 6-digit code (or leave it blank to use your password instead)');
          let done;
          if (code?.trim()) done = await api('/api/auth/2fa/disable', { method: 'POST', body: { code: code.trim() } });
          else {
            const current = prompt('Current password');
            if (!current) return;
            done = await api('/api/auth/2fa/disable', { method: 'POST', body: { current_password: current } });
          }
          state.user = done.user;
          toast('Two-factor is off');
        }
        renderAvatar();
        openSettings();
      } catch (e) {
        toast(e.message);
      }
    };
    $('s-pass').onclick = async () => {
      const current = prompt('Current password');
      if (!current) return;
      const next = prompt('New password (at least 8 characters)');
      if (!next) return;
      try {
        await api('/api/me', { method: 'PATCH', body: { current_password: current, password: next } });
        toast('Password changed');
      } catch (e) {
        toast(e.message);
      }
    };
    $('s-delete').onclick = async () => {
      if (!confirm('Delete your account? Your saved places and reports will be removed. This cannot be undone.')) return;
      try {
        await api('/api/me', { method: 'DELETE' });
        state.user = null;
        $('panel').classList.add('hidden');
        await ctx.onUserChanged();
        toast('Account deleted');
      } catch (e) {
        toast(e.message);
      }
    };
  }
}

function homeWorkAction(which) {
  const label = which === 'home' ? 'Home' : 'Work';
  const has = state[which];
  if (!has) {
    $('panel').classList.add('hidden');
    return ctx.openSearchFor(which);
  }
  openPanel(label, `<div class="about"><p><b style="color:var(--text)">${esc(has.name)}</b><br>${esc(has.address || '')}</p>
    <button class="btn primary wide" id="hw-change">Change ${label.toLowerCase()} address</button>
    <button class="btn ghost wide" id="hw-clear">Clear</button></div>`);
  $('hw-change').onclick = () => {
    $('panel').classList.add('hidden');
    ctx.openSearchFor(which);
  };
  $('hw-clear').onclick = async () => {
    await setHomeWork(which, null).catch((e) => toast(e.message));
    await ctx.onUserChanged();
    openSettings();
  };
}

function openSavedPlaces() {
  const list = state.places.saved;
  const body = openPanel('Saved places', `
    <div style="padding:8px 16px"><button class="btn primary wide" id="sp-add">Add a place</button></div>
    ${list.length ? '' : '<p class="hint" style="padding:8px 18px">Tap the star on any destination, or long-press the map, to save it here.</p>'}
    <ul class="place-list">${list
      .map((p) => `<li data-id="${esc(p.id)}"><button class="place-row" data-go><span class="p-ic">⭐</span><span class="p-text"><b>${esc(p.name)}</b><small>${esc(p.address || '')}</small></span></button>
        <button class="icon-btn" data-rename aria-label="Rename">✎</button><button class="icon-btn" data-del aria-label="Delete">✕</button></li>`)
      .join('')}</ul>`);
  $('sp-add').onclick = () => {
    $('panel').classList.add('hidden');
    ctx.openSearchFor('save');
  };
  body.querySelectorAll('li').forEach((li) => {
    const p = list.find((x) => String(x.id) === li.dataset.id);
    li.querySelector('[data-go]').onclick = () => {
      $('panel').classList.add('hidden');
      ctx.openPreview(p);
    };
    li.querySelector('[data-rename]').onclick = async () => {
      const name = prompt('Name', p.name);
      if (!name?.trim()) return;
      await renamePlace('saved', p.id, name.trim()).catch((e) => toast(e.message));
      openSavedPlaces();
    };
    li.querySelector('[data-del]').onclick = async () => {
      if (!confirm(`Delete "${p.name}"?`)) return;
      await removePlace('saved', p.id).catch((e) => toast(e.message));
      openSavedPlaces();
    };
  });
}

async function openLeaders() {
  const body = openPanel('Top drivers', '<p class="hint" style="padding:12px 18px">Loading…</p>');
  try {
    const { leaders } = await api('/api/leaderboard');
    body.innerHTML = leaders.length
      ? `<p class="hint" style="padding:8px 18px">Points come from reports and from other drivers thanking and confirming them.</p>${leaders
          .map((l, i) => `<div class="leader${l.me ? ' me' : ''}"><span class="rank">${i + 1}</span><span class="avatar">${esc(initials(l.name))}</span><span class="name">${esc(l.name)}</span>${l.me ? '<span class="you">You</span>' : ''}<b>${l.points}<small>pts</small></b></div>`)
          .join('')}`
      : '<p class="hint" style="padding:12px 18px">No drivers yet. Be the first to report something!</p>';
  } catch (e) {
    body.innerHTML = `<p class="hint" style="padding:12px 18px">${esc(e.message)}</p>`;
  }
}

// Feedback for the developer. Without an account it's anonymous; with one, the name and email go along so
// there's a way to reply.
function openFeedback() {
  const u = state.user;
  const body = openPanel('Send feedback', `<div class="feedback">
    <p class="hint">What's working, what isn't, and what you'd like to see. A wrong turn or a missing place? Say where.</p>
    <textarea id="fb-text" class="field" maxlength="2000" rows="7" placeholder="Type your feedback…"></textarea>
    <p class="hint fb-who">${u ? `Sent with your name and email (${esc(u.email)}), so the developer can reply.` : 'Sent without your name. Log in first if you\'d like a reply.'}</p>
    <button class="btn primary" id="fb-send" disabled>Send</button>
  </div>`);
  const text = $('fb-text');
  const send = $('fb-send');
  text.oninput = () => (send.disabled = text.value.trim().length < 3);
  send.onclick = async () => {
    send.disabled = true;
    try {
      await api('/api/feedback', { method: 'POST', body: { message: text.value, app: appVersion() } });
      body.innerHTML = '<div class="feedback"><p class="fb-done">Thank you! 🙏</p><p class="hint">Your feedback has been sent to the developer.</p></div>';
    } catch (e) {
      toast(e.message);
      send.disabled = false;
    }
  };
  setTimeout(() => text.focus(), 300);
}

// The owner's feedback inbox (GET /api/feedback is only answered for tester accounts). Done removes one.
async function openInbox() {
  const body = openPanel('Feedback', '<p class="hint" style="padding:12px 18px">Loading…</p>');
  try {
    const { feedback } = await api('/api/feedback');
    const device = (ua = '') => (/iphone|ipad/i.test(ua) ? 'iPhone' : /android/i.test(ua) ? 'Android' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : 'Other');
    const when = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    body.innerHTML = feedback.length
      ? feedback
        .map((f) => `<div class="fb-item" data-id="${f.id}">
          <p>${esc(f.message)}</p>
          <small>${f.email ? `${esc(f.name)} · <a href="mailto:${esc(f.email)}?subject=${encodeURIComponent('Your A2B feedback')}">${esc(f.email)}</a>` : 'Guest'} · ${esc(when(f.created_at))} · ${esc(device(f.ua ?? ''))}${f.app ? ` · ${esc(f.app)}` : ''}</small>
          <button class="btn ghost" data-done>Done</button>
        </div>`)
        .join('')
      : '<p class="hint" style="padding:12px 18px">No feedback yet.</p>';
    body.onclick = async (e) => {
      const item = e.target.closest('[data-done]')?.closest('.fb-item');
      if (!item) return;
      try {
        await api(`/api/feedback/${item.dataset.id}`, { method: 'DELETE' });
        item.remove();
        if (!body.querySelector('.fb-item')) body.innerHTML = '<p class="hint" style="padding:12px 18px">All done.</p>';
      } catch (err) { toast(err.message); }
    };
  } catch (e) { body.innerHTML = `<p class="hint" style="padding:12px 18px">${esc(e.message)}</p>`; }
}

// The owner's usage dashboard (GET /api/stats is only answered for tester accounts). Refreshes while open.
async function openUsage() {
  const body = openPanel('Usage', '<p class="hint" style="padding:12px 18px">Loading…</p>');
  const render = async () => {
    if ($('panel').classList.contains('hidden') || !body.isConnected || $('panel-title').textContent !== 'Usage') return false;
    try {
      body.innerHTML = usageHtml(await api('/api/stats'));
    } catch (e) {
      body.innerHTML = `<p class="hint" style="padding:12px 18px">${esc(e.message)}</p>`;
    }
    return true;
  };
  await render();
  const timer = setInterval(async () => (await render()) || clearInterval(timer), 30_000);
}

const TOMTOM_FREE = 20_000; // TomTom's free Routing API requests a month

function usageHtml({ now, days, totals }) {
  const today = days.at(-1);
  const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–');
  const pct = Math.min(100, Math.round((now.active / now.max) * 100));
  const top = Math.max(1, ...days.map((d) => d.devices));
  const stat = (n, label) => `<div class="u-stat"><b>${esc(String(n))}</b><small>${label}</small></div>`;
  const label = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `<div class="usage">
    <section class="u-now">
      <div class="u-big"><b>${now.active}</b><span>of ${now.max} on now</span></div>
      <div class="u-meter"><i style="width:${pct}%"></i></div>
      <p>${now.guests} guest${now.guests === 1 ? '' : 's'} (up to ${now.guest_max}) · ${now.accounts} with an account · ${now.waiting} waiting</p>
    </section>
    <h3>Today</h3>
    <div class="u-grid">
      ${stat(today.devices, 'devices')}${stat(`${today.peak_active}/${now.max}`, `busiest, ${time(today.peak_at)}`)}${stat(today.turned_away, 'turned away')}
      ${stat(today.signups, 'sign-ups')}${stat(today.routes, 'routes')}${stat(today.searches, 'searches')}
    </div>
    <p class="hint" style="padding:6px 18px 0">Live traffic: ${today.tomtom ?? 0} TomTom lookups today, ${totals.tomtom_month ?? 0} this month (${TOMTOM_FREE.toLocaleString()} a month are free).</p>
    <h3>Last 14 days</h3>
    <div class="u-days">${[...days]
      .reverse()
      .map((d) => `<div class="u-day" title="${esc(d.day)}">
        <span class="u-date">${esc(label(d.day))}</span>
        <span class="u-bar"><i style="width:${Math.round((d.devices / top) * 100)}%"></i></span>
        <span class="u-num">${d.devices}</span>
        <span class="u-peak${d.peak_active >= now.max ? ' full' : ''}">${d.peak_active} peak</span>
        <span class="u-away">${d.turned_away ? `${d.turned_away} away` : ''}</span>
      </div>`)
      .join('')}</div>
    <p class="hint" style="padding:6px 18px 0">Devices: phones and browsers that opened A2B that day. Peak: most on at once. Away: devices that hit the waiting screen. ${totals.accounts} accounts and ${totals.reports} reports in all.</p>
  </div>`;
}

function openAbout() {
  openPanel('About A2B', `<div class="about">
    <img src="/icon.svg" alt="" width="64" height="64">
    <p><b style="color:var(--text)">A2B</b> gets you from A to B with live directions and reports from drivers around you.</p>
    <p>Keep your eyes on the road. Only use the app when it is safe and legal to do so. Reports from other drivers can be wrong.</p>
    <p>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.
       Map tiles by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>.
       Routing by <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener">Valhalla</a>, search by <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a>, live traffic by <a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>.
       Shops and places also from <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a> (Meta, Microsoft, Foursquare, AllThePlaces and others; <a href="/places/NOTICE.txt" target="_blank">licences</a>).</p>
    <p>A2B is free and open source. <a href="https://github.com/thaqif0709/a2b" target="_blank" rel="noopener">Source code</a>, ideas and bug reports welcome, or send feedback from Settings.</p>
    <p class="about-credit">© 2026 Thaqif Syarafuddin bin Roslan and the A2B contributors.
       <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">GNU AGPL v3</a> with
       <a href="https://github.com/thaqif0709/a2b/blob/main/NOTICE" target="_blank" rel="noopener">additional terms</a>.</p>
    <!-- Copies and modified versions must keep this credit (NOTICE, AGPL section 7(b)):
         Based on A2B by Thaqif Syarafuddin bin Roslan (https://github.com/thaqif0709/a2b) -->
  </div>`);
}

async function install() {
  closeMenu();
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    return;
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openPanel('Add to home screen', `<div class="about"><p>${
    ios
      ? 'In Safari, tap the <b>Share</b> button, then <b>Add to Home Screen</b>.'
      : 'Open your browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>.'
  }</p><p>A2B then opens full screen, like an app.</p></div>`);
}

