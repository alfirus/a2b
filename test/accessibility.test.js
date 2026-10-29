// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('viewport keeps responsive layout without blocking user zoom', () => {
  const viewport = html.match(/<meta\s+name="viewport"[^>]*>/i)?.[0];
  assert.ok(viewport, 'index.html should define a viewport');
  assert.match(viewport, /width=device-width/i);
  assert.match(viewport, /initial-scale=1(?:\.0+)?/i);
  assert.match(viewport, /viewport-fit=cover/i);
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport, /maximum-scale\s*=/i);
});
