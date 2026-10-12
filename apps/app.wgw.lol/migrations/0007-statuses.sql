-- Commit statuses: the pass or fail results that CI runners and agents post on a commit, one row
-- per context. Posting a context again replaces its row. The hash is the full repository's.
CREATE TABLE statuses (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'failure', 'error')),
  description TEXT NOT NULL DEFAULT '',
  target_url TEXT,
  creator_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, sha, context)
);
