-- PostgreSQL CHECK constraints accept UNKNOWN. Require complete ledger ACK metadata
-- explicitly so an acknowledged/applied saga row cannot omit its sequence.
ALTER TABLE privacy_recovery_operations
  ADD CONSTRAINT privacy_recovery_operations_ack_metadata_required_check
  CHECK (
    status NOT IN ('acknowledged', 'applied')
    OR (
      ledger_sequence IS NOT NULL
      AND ledger_sequence > 0
      AND acknowledged_at IS NOT NULL
    )
  );
