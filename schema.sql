CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  tz TEXT NOT NULL DEFAULT 'Asia/Taipei',
  schedule_type TEXT NOT NULL DEFAULT 'daily',
  weekly_day INT,
  daily_time TEXT,
  quiet_start TEXT NOT NULL DEFAULT '23:00',
  quiet_end   TEXT NOT NULL DEFAULT '07:00',
  retry_max INT NOT NULL DEFAULT 2,
  retry_gap_minutes INT NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  owner_user_id TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  consented BOOLEAN NOT NULL DEFAULT false,
  consent_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, contact_user_id)
);

CREATE TABLE IF NOT EXISTS checkins (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  owner_user_id TEXT PRIMARY KEY,
  next_at TIMESTAMPTZ NOT NULL,
  retry_count INT NOT NULL DEFAULT 0,
  last_reminded_at TIMESTAMPTZ,
  last_response_at TIMESTAMPTZ
);
