CREATE TABLE IF NOT EXISTS privacy_snapshot_barriers (
  barrier_id TEXT PRIMARY KEY CHECK (length(barrier_id) = 36),
  snapshot_id TEXT NOT NULL UNIQUE CHECK (length(snapshot_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  ledger_sequence INTEGER NOT NULL CHECK (ledger_sequence >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK ((status = 'active' AND released_at IS NULL) OR
         (status = 'released' AND released_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS privacy_snapshot_barriers_one_active_idx
  ON privacy_snapshot_barriers(status)
  WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS privacy_snapshot_barriers_transition_guard
BEFORE UPDATE ON privacy_snapshot_barriers
WHEN OLD.status <> 'active'
  OR NEW.barrier_id <> OLD.barrier_id
  OR NEW.snapshot_id <> OLD.snapshot_id
  OR NEW.ledger_sequence <> OLD.ledger_sequence
  OR NEW.created_at <> OLD.created_at
  OR NEW.status <> 'released'
  OR NEW.released_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'privacy snapshot barrier transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS privacy_snapshot_barriers_no_delete
BEFORE DELETE ON privacy_snapshot_barriers
BEGIN
  SELECT RAISE(ABORT, 'privacy snapshot barriers are append-only');
END;
