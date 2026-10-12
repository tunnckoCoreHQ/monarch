-- Repository webhooks. `events` is a JSON array of event names. The signing secret is AES-GCM
-- ciphertext under the repository's key. `last_status` is the HTTP status of the last delivery, or
-- null when it got no response or nothing was delivered yet.
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_status INTEGER,
  last_delivery_at INTEGER
);
CREATE INDEX webhooks_repo ON webhooks (repo_id);

-- One row per delivery, updated by each retry. The consumer keeps the last 50 per webhook.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);
