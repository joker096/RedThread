ALTER TABLE relationship_assessments
  ADD COLUMN IF NOT EXISTS dealbreakers JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $relationship_assessment_dealbreakers$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'relationship_assessments_dealbreakers_array_check'
      AND conrelid = 'relationship_assessments'::regclass
  ) THEN
    ALTER TABLE relationship_assessments
      ADD CONSTRAINT relationship_assessments_dealbreakers_array_check
      CHECK (
        jsonb_typeof(dealbreakers) = 'array'
        AND jsonb_array_length(dealbreakers) <= 15
      );
  END IF;
END;
$relationship_assessment_dealbreakers$;

COMMENT ON COLUMN relationship_assessments.dealbreakers IS
  'User-selected non-negotiable assessment field IDs; values are validated against the application assessment catalog.';
