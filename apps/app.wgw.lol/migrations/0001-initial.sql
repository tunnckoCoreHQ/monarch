-- Accounts. A human signs in through Triad (Google plus an app passkey, or a Triad passkey
-- account). An agent signs in through AgentID or registers through auth.md.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT,
  avatar TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'passkey', 'agentid', 'authmd')),
  subject TEXT NOT NULL,
  owner_email TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, subject)
);

-- App passkeys, the second factor after a Google sign-in.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT 'passkey',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- Browser sessions. `level` is 'pending' until a Google user proves a passkey.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('pending', 'full')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- API keys and short-lived agent access tokens. Only the SHA-256 of the secret is stored.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('key', 'agent')),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  repo_id TEXT,
  environment TEXT,
  registration_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX tokens_user ON tokens (user_id);

-- CLI sign-in through the device flow.
CREATE TABLE device_codes (
  code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  polled_at INTEGER
);

-- auth.md agent registrations and their claim ceremonies.
CREATE TABLE agent_registrations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('anonymous', 'service_auth')),
  status TEXT NOT NULL CHECK (status IN ('unclaimed', 'claiming', 'claimed', 'revoked')),
  claim_token_hash TEXT NOT NULL UNIQUE,
  claim_email TEXT,
  attempt_token_hash TEXT UNIQUE,
  user_code_hash TEXT,
  code_expires_at INTEGER,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  polled_at INTEGER
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  source TEXT,
  forked_from TEXT,
  pushed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, name)
);

CREATE TABLE collaborators (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);

-- Deployment environments. `kind` says what the environment is for.
CREATE TABLE environments (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('production', 'staging', 'preview', 'development')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);

-- Variables and secrets. An empty environment means the whole repository. Secret values are
-- AES-GCM ciphertext; plain variables are stored as they are.
CREATE TABLE variables (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  environment TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  secret INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, environment, name)
);

CREATE TABLE pulls (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL REFERENCES users (id),
  head TEXT NOT NULL,
  base TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  merge_sha TEXT,
  merged_by TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  pull_id TEXT NOT NULL REFERENCES pulls (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users (id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_pull ON comments (pull_id);

-- Activity: pushes, pull requests, merges.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  actor_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_repo ON events (repo_id, created_at);
