-- Audit log for the nightly archiver.
--
-- Each archiver run writes one row per table it purged with the count
-- of rows deleted, the retention cutoff used, and the duration. Lets
-- you answer "how much data did we drop last month?" and "has the
-- archiver actually been firing?" without scraping logs.

CREATE TABLE IF NOT EXISTS archive_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name        TEXT NOT NULL,
  rows_deleted      BIGINT NOT NULL DEFAULT 0,
  retention_days    INT NOT NULL,
  cutoff_at         TIMESTAMPTZ NOT NULL,
  duration_ms       INT,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_archive_log_ran_at
  ON archive_log(ran_at DESC);
