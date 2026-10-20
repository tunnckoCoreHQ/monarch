-- Envelope encryption for repository secrets. Each repository has its own AES-256 key, stored here
-- wrapped by the master key in Secrets Store. Deleting a repository deletes its key with it.
CREATE TABLE repo_keys (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id) ON DELETE CASCADE,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
