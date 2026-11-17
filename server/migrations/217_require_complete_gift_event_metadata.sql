-- Require complete verified routing metadata as one indivisible event envelope.
ALTER TABLE gift_payment_provider_event_inbox
  DROP CONSTRAINT gift_provider_event_payment_metadata_shape,
  ADD CONSTRAINT gift_provider_event_payment_metadata_shape
    CHECK (
      (
        provider_account_id IS NULL AND environment IS NULL
        AND provider_reference IS NULL AND amount_minor_units IS NULL AND currency IS NULL
      )
      OR
      (
        provider_account_id IS NOT NULL AND length(btrim(provider_account_id)) BETWEEN 1 AND 200
        AND environment IS NOT NULL AND environment = 'sandbox'
        AND provider_reference IS NOT NULL
        AND length(btrim(provider_reference)) BETWEEN 1 AND 200
        AND amount_minor_units IS NOT NULL AND amount_minor_units > 0
        AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$'
      )
    );
