-- Row-level append-only triggers do not fire for TRUNCATE. Consent grants,
-- withdrawals and moderation decisions are durable audit evidence, so protect
-- both L3 event ledgers with the same statement-level guard as other evidence.
CREATE TRIGGER identity_l3_consent_events_no_truncate
  BEFORE TRUNCATE ON identity_l3_consent_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

CREATE TRIGGER identity_l3_decision_events_no_truncate
  BEFORE TRUNCATE ON identity_l3_decision_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON FUNCTION prevent_evidence_truncate() IS
  'Blocks TRUNCATE on financial, moderation, gift, L3 consent, L3 decision and L3 media-access evidence tables because row-level mutation triggers do not cover TRUNCATE.';
