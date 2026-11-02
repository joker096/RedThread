-- Single-use, short-lived upload capabilities. Store only SHA-256 token digests.
-- The plaintext capability is returned once to the authenticated applicant and is never persisted.
-- A composite FK makes it impossible to bind a submission's token to another account.
ALTER TABLE identity_l3_submissions
  ADD CONSTRAINT identity_l3_submissions_id_user_key UNIQUE (id, user_id);

CREATE TABLE identity_l3_upload_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL,
  user_id UUID NOT NULL,
  FOREIGN KEY (submission_id, user_id)
    REFERENCES identity_l3_submissions(id, user_id) ON DELETE CASCADE,
  token_sha256 CHAR(64) NOT NULL UNIQUE
    CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '15 minutes'),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

-- At most one unconsumed capability for a submission. The issuer revokes an old
-- capability before inserting a replacement, including an expired capability.
CREATE UNIQUE INDEX identity_l3_upload_tokens_one_active_per_submission_uidx
  ON identity_l3_upload_tokens(submission_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX identity_l3_upload_tokens_expiry_idx
  ON identity_l3_upload_tokens(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX identity_l3_upload_tokens_user_idx
  ON identity_l3_upload_tokens(user_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_identity_l3_upload_token()
RETURNS trigger LANGUAGE plpgsql AS $l3_token_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'new identity L3 upload tokens must be unused' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'identity L3 upload token identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'identity L3 upload token consumption is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'identity L3 upload token revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL
     AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at <= NOW()) THEN
    RAISE EXCEPTION 'expired or revoked identity L3 upload token cannot be consumed' USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
     AND OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'consumed identity L3 upload token cannot be revoked' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$l3_token_guard$;

CREATE TRIGGER identity_l3_upload_token_guard
  BEFORE INSERT OR UPDATE ON identity_l3_upload_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_identity_l3_upload_token();

COMMENT ON TABLE identity_l3_upload_tokens IS
  'Short-lived, single-use L3 upload capabilities. Only token SHA-256 digests are stored; never store plaintext tokens.';
COMMENT ON COLUMN identity_l3_upload_tokens.token_sha256 IS
  'SHA-256 digest of a cryptographically random one-time bearer capability; never the plaintext capability.';
