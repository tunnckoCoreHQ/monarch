-- When each repository's search index last caught up with its default branch, and for which
-- visibility. The hourly cron trigger queues a reindex for repositories pushed or made public or
-- private since then, so a lost or failed job is retried.
CREATE TABLE search_index (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id) ON DELETE CASCADE,
  indexed_at INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private'))
);
