-- A Paddle adjustment ID is one immutable financial record even though its
-- webhook status may be reported by more than one event. Prevent one provider
-- adjustment from being rebound to another transaction/action or changing
-- already-known financial identity metadata.
-- Freeze writes across the preflight and trigger installation so a concurrent
-- webhook cannot create a conflicting identity in the migration gap.
LOCK TABLE paddle_adjustment_events IN SHARE ROW EXCLUSIVE MODE;

DO $migration184$
BEGIN
  IF EXISTS (
    SELECT adjustment_id
    FROM paddle_adjustment_events
    GROUP BY adjustment_id
    HAVING COUNT(DISTINCT transaction_id) > 1
       OR COUNT(DISTINCT action) > 1
       OR COUNT(DISTINCT adjustment_type) > 1
       OR COUNT(DISTINCT amount_minor_units) > 1
       OR COUNT(DISTINCT currency_code) > 1
  ) THEN
    RAISE EXCEPTION 'conflicting Paddle adjustment identities already exist; reconcile before migration 184'
      USING ERRCODE = '23514';
  END IF;
END;
$migration184$;

CREATE INDEX paddle_adjustment_events_adjustment_id_idx
  ON paddle_adjustment_events(adjustment_id);

CREATE OR REPLACE FUNCTION guard_paddle_adjustment_event_identity()
RETURNS trigger LANGUAGE plpgsql AS $paddle_adjustment_identity$
BEGIN
  -- The transaction lock serializes normal event processing, but a corrupted
  -- or conflicting adjustment ID could be presented with another transaction
  -- ID. Serialize by adjustment ID as a second, global identity boundary.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('paddle-adjustment:' || NEW.adjustment_id, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM paddle_adjustment_events AS prior
    WHERE prior.adjustment_id = NEW.adjustment_id
      AND (
        prior.transaction_id <> NEW.transaction_id
        OR prior.action <> NEW.action
        OR (
          prior.adjustment_type IS NOT NULL
          AND NEW.adjustment_type IS NOT NULL
          AND prior.adjustment_type <> NEW.adjustment_type
        )
        OR (
          prior.amount_minor_units IS NOT NULL
          AND NEW.amount_minor_units IS NOT NULL
          AND prior.amount_minor_units <> NEW.amount_minor_units
        )
        OR (
          prior.currency_code IS NOT NULL
          AND NEW.currency_code IS NOT NULL
          AND prior.currency_code <> NEW.currency_code
        )
      )
  ) THEN
    RAISE EXCEPTION 'Paddle adjustment identity conflicts with retained provider evidence'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$paddle_adjustment_identity$;

DROP TRIGGER IF EXISTS paddle_adjustment_events_identity_guard ON paddle_adjustment_events;
CREATE TRIGGER paddle_adjustment_events_identity_guard
  BEFORE INSERT ON paddle_adjustment_events
  FOR EACH ROW EXECUTE FUNCTION guard_paddle_adjustment_event_identity();

COMMENT ON FUNCTION guard_paddle_adjustment_event_identity() IS
  'Serializes adjustment-ID claims and rejects transaction/action or already-known type/amount/currency identity conflicts while allowing missing metadata to be enriched by a later provider event.';
