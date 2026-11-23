-- Media Sosial Sender — skema D1
CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  profile_id TEXT NOT NULL,
  platform TEXT NOT NULL,           -- yt | fb | ig | threads
  status TEXT NOT NULL,             -- connected | select
  account_id TEXT,
  account_name TEXT,
  token_enc TEXT,
  refresh_enc TEXT,
  expires_at INTEGER,
  extra_enc TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, platform)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_name TEXT,
  title TEXT,
  caption TEXT,
  aspect TEXT,
  quality TEXT,
  media_key TEXT NOT NULL,
  media_name TEXT,
  media_size INTEGER,
  media_type TEXT,
  thumb_key TEXT,
  media_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL,             -- pending | processing | waiting | published | failed | cancelled
  container_id TEXT,
  next_check_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_id TEXT,
  result_url TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, run_at);
CREATE INDEX IF NOT EXISTS jobs_post ON jobs (post_id);
