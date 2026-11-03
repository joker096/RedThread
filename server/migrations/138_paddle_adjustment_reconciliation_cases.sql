-- Durable operational queue for valid Paddle adjustments that cannot yet
-- be safely matched to a Vow checkout/entitlement. The provider webhook may
-- be acknowledged after the source event is retained, but the case must remain
-- visible until an explicit or automatic reconciliation resolves it.
CREATE TABLE paddle_adjustment_reconciliation_cases (
  event_id TEXT PRIMARY KEY
    REFERENCES paddle_adjustment_events(event_id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'lifetime_transaction_unlinked',
    'lifetime_transaction_ambiguous',
    'lifetime_account_inactive',
    'lifetime_entitlement_missing'
  )),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  resolved_at TIMESTAMPTZ,
  CHECK (
    (status = 'open' AND resolution_note IS NULL AND resolved_at IS NULL)
    OR
    (status = 'resolved' AND resolution_note IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX paddle_adjustment_reconciliation_open_idx
  ON paddle_adjustment_reconciliation_cases(created_at)
  WHERE status = 'open';

CREATE OR REPLACE FUNCTION guard_paddle_adjustment_reconciliation_case()
RETURNS trigger LANGUAGE plpgsql AS $paddle_adjustment_case$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Paddle adjustment reconciliation evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Paddle adjustment reconciliation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'resolved Paddle adjustment reconciliation cases are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'open' AND NEW.status = 'resolved') THEN
    RAISE EXCEPTION 'invalid Paddle adjustment reconciliation case transition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'resolved' AND (
    NEW.resolution_note IS NULL OR length(btrim(NEW.resolution_note)) = 0
    OR length(NEW.resolution_note) > 1000 OR NEW.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'resolved Paddle adjustment cases require a bounded resolution note and timestamp'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$paddle_adjustment_case$;

CREATE TRIGGER paddle_adjustment_reconciliation_cases_guard
  BEFORE UPDATE OR DELETE ON paddle_adjustment_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION guard_paddle_adjustment_reconciliation_case();

CREATE TRIGGER paddle_adjustment_reconciliation_cases_no_truncate
  BEFORE TRUNCATE ON paddle_adjustment_reconciliation_cases
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE paddle_adjustment_reconciliation_cases IS
  'Durable manual reconciliation queue keyed to the immutable source Paddle event. Join event_id to paddle_adjustment_events for adjustment and transaction identifiers.';
COMMENT ON COLUMN paddle_adjustment_reconciliation_cases.reason_code IS
  'Bounded operational reason; never contains provider payloads, customer data, payment credentials, or free-form user content.';
