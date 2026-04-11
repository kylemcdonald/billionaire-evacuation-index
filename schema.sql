CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_aircraft (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  label TEXT,
  source TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  hex TEXT NOT NULL,
  registration TEXT,
  source TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  is_airborne INTEGER NOT NULL DEFAULT 1,
  UNIQUE(hex, observed_at, source) ON CONFLICT IGNORE
);

CREATE INDEX IF NOT EXISTS idx_observations_observed_at
  ON observations (observed_at);

CREATE INDEX IF NOT EXISTS idx_observations_hex_time
  ON observations (hex, observed_at);

CREATE TABLE IF NOT EXISTS recent_history_activity (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  last_observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_history_activity_last_observed_at
  ON recent_history_activity (last_observed_at);

CREATE TABLE IF NOT EXISTS rolling_metrics (
  sampled_at TEXT PRIMARY KEY,
  rolling_24h_count INTEGER NOT NULL,
  concurrent_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day TEXT PRIMARY KEY,
  unique_airborne_count INTEGER NOT NULL,
  peak_concurrent_count INTEGER NOT NULL,
  peak_rolling_24h_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS live_snapshot (
  hex TEXT PRIMARY KEY,
  registration TEXT,
  label TEXT,
  observed_at TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude_ft REAL,
  ground_speed_kt REAL,
  track REAL,
  is_airborne INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  details TEXT
);
