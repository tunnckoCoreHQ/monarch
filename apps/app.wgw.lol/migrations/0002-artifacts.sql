-- Git storage moved to Cloudflare Artifacts. Imports and forks run in the background, so a repo
-- has a status until its Artifacts repos are ready and the mirror has synced.
ALTER TABLE repos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'importing', 'forking', 'failed'));
ALTER TABLE repos ADD COLUMN status_detail TEXT;
