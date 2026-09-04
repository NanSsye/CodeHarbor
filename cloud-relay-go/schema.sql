CREATE TABLE IF NOT EXISTS relay_accounts (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  owner_user TEXT,
  status TEXT,
  title TEXT,
  workspace_path TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_path TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_policy_mode TEXT NOT NULL DEFAULT 'confirm';
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions(owner_user, updated_at DESC);
CREATE TABLE IF NOT EXISTS gateway_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_seq BIGINT NOT NULL,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, event_seq)
);
CREATE INDEX IF NOT EXISTS gateway_events_session_idx ON gateway_events(session_id, event_seq);
CREATE INDEX IF NOT EXISTS gateway_events_created_idx ON gateway_events(created_at);
CREATE TABLE IF NOT EXISTS session_event_counters (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  last_seq BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS relay_devices (
  id TEXT PRIMARY KEY,
  owner_user TEXT,
  name TEXT NOT NULL DEFAULT '',
  credential_hash BYTEA NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS relay_devices_owner_idx ON relay_devices(owner_user, updated_at DESC);
CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash BYTEA PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pair_codes_device_idx ON pair_codes(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pair_codes_expiry_idx ON pair_codes(expires_at);
CREATE TABLE IF NOT EXISTS auth_token_revocations (
  token_hash BYTEA PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_token_revocations_expiry_idx ON auth_token_revocations(expires_at);
