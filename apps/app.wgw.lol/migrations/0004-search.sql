-- Code search. One row per file the indexer read at the default branch tip. The file's vectors in
-- Vectorize have IDs derived from repo_id, path, blob_sha, and the chunk number, so a reindex only
-- embeds files whose blob or visibility changed. A file with nothing to index has 0 chunks.
CREATE TABLE search_files (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  PRIMARY KEY (repo_id, path)
);
