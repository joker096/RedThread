-- PostgreSQL CHECK constraints accept NULL results. Require the identity and
-- routing fields in both durable privacy-event payload tables explicitly so
-- omitted JSON keys cannot pass validation.
ALTER TABLE privacy_recovery_operations
  ADD CONSTRAINT privacy_recovery_operations_required_payload_fields_check
  CHECK (
    COALESCE(event_payload->>'event_id', '') = event_id::text
    AND COALESCE(event_payload->>'schema_version', '') = '1'
    AND COALESCE(event_payload->>'subject_ref', '') ~ '^[a-f0-9]{64}$'
    AND COALESCE(event_payload->>'occurred_at', '') <> ''
  );

ALTER TABLE privacy_recovery_ledger_outbox
  ADD CONSTRAINT privacy_recovery_outbox_required_payload_fields_check
  CHECK (
    COALESCE(event_payload->>'event_id', '') = event_id::text
    AND COALESCE(event_payload->>'schema_version', '') = '1'
    AND COALESCE(event_payload->>'subject_ref', '') ~ '^[a-f0-9]{64}$'
    AND COALESCE(event_payload->>'occurred_at', '') <> ''
  );
