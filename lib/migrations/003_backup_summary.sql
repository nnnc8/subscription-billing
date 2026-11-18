-- The backup inventory reads this system snapshot instead of every full snapshot.
-- From here on, fingerprint holds the sha256 of the canonical JSON instead of the JSON.
-- SQLite has no sha256, so createBackupService().backfillBackupSummaries() converts
-- the rows written before this migration; the runtime calls it right after migrating.
ALTER TABLE backups ADD COLUMN summary TEXT;
