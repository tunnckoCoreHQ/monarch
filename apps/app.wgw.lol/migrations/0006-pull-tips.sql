-- The base and head tips a pull request merged, so a merged pull request still shows its commits
-- and files after both branches move on.
ALTER TABLE pulls ADD COLUMN base_sha TEXT;
ALTER TABLE pulls ADD COLUMN head_sha TEXT;
