// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// How many people can use A2B at once. Routing and search run on free public servers that ask for fair use,
// so only so many devices get a spot; the rest wait and are let in as spots free up. Accounts get priority:
// guests can only take some of the spots, signed-in drivers can take any. Nobody already in loses their spot
// while the app keeps checking in.

export const ACTIVE_MS = 5 * 60_000; // a device counts as in the app if it checked in this recently
const WAITING_WRITE_MS = 4 * 60_000; // waiting devices are recorded this often at most, to spare D1 writes
const ROW_CAP = 500; // device ids are self-minted, so a script could grow this table without bound: keep the freshest rows

export function limits(env) {
  const num = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const total = num(env.MAX_ACTIVE, 50);
  return { total, guests: Math.min(total, num(env.MAX_GUESTS, 30)) };
}

export const validDevice = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);

export function presenceRepo(db) {
  const counts = async (now) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(admitted = 1), 0) AS active, COALESCE(SUM(admitted = 1 AND user_id IS NULL), 0) AS guests,
                COALESCE(SUM(admitted = 0), 0) AS waiting
         FROM presence WHERE last_seen > ?`,
      )
      .bind(now - ACTIVE_MS)
      .first();

  return {
    // { admitted, active, max, waiting }: whether this device may use the app now, and how full it is.
    async checkIn(device, user, lim, { always = false, now = Date.now() } = {}) {
      const row = await db.prepare('SELECT * FROM presence WHERE device = ?').bind(device).first();
      const fresh = row && row.last_seen > now - ACTIVE_MS;
      const c = await counts(now);
      const holding = Boolean(fresh && row.admitted);
      const admitted = holding || always || (user ? c.active < lim.total : c.guests < lim.guests && c.active < lim.total);
      if (admitted || !fresh || now - row.last_seen > WAITING_WRITE_MS) {
        await db
          .prepare(
            `INSERT INTO presence (device, user_id, admitted, last_seen) VALUES (?, ?, ?, ?)
             ON CONFLICT(device) DO UPDATE SET user_id = excluded.user_id, admitted = excluded.admitted, last_seen = excluded.last_seen`,
          )
          .bind(device, user?.id ?? null, admitted ? 1 : 0, now)
          .run();
        // Admitted drivers checking in stay; everyone else competes for room by freshness.
        await db
          .prepare(`DELETE FROM presence WHERE device NOT IN (SELECT device FROM presence ORDER BY admitted DESC, last_seen DESC LIMIT ${ROW_CAP})`)
          .run();
      }
      const wasWaiting = fresh && !row.admitted ? 1 : 0;
      return {
        admitted,
        active: c.active + (admitted && !holding ? 1 : 0),
        max: lim.total,
        waiting: c.waiting - wasWaiting + (admitted ? 0 : 1),
      };
    },

    async hasSpot(device, now = Date.now()) {
      const row = await db.prepare('SELECT admitted, last_seen FROM presence WHERE device = ?').bind(device).first();
      return Boolean(row?.admitted && row.last_seen > now - ACTIVE_MS);
    },
  };
}
