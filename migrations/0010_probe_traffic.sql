-- Opt-in probe traffic (see src/lib/probes.js): anonymous per-street-block totals only.
-- Raw fixes are folded into these rows in memory and never written; the nightly job deletes old rows.
-- Numbered 0010 because #5's abuse-limits migration took 0009; only one of them can be 0009.
CREATE TABLE IF NOT EXISTS probe_segments (
  segment TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, dir INTEGER NOT NULL,
  avg_speed REAL NOT NULL, probes INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS probe_segments_live ON probe_segments (updated_at, lat, lng);
-- One row per (block, driver): a block only counts as congested when enough distinct drivers crawled it,
-- so one phone or script flooding fixes can't fake a jam.
CREATE TABLE IF NOT EXISTS probe_devices (
  segment TEXT NOT NULL, device_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (segment, device_hash)
);
CREATE INDEX IF NOT EXISTS probe_devices_live ON probe_devices (updated_at);
CREATE TABLE IF NOT EXISTS probe_limits (
  device_hash TEXT PRIMARY KEY, last_at INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0
);
