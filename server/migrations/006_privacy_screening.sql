-- Store screening outcomes only; never persist raw profile/message text in this queue.
CREATE TABLE IF NOT EXISTS user_safety_screenings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK (scope IN ('profile','message')),
 flags JSONB NOT NULL DEFAULT '[]'::jsonb,
 severity TEXT NOT NULL CHECK (severity IN ('none','info','low','high')),
 engine_version TEXT NOT NULL DEFAULT 'local-rules-v1',
 review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (review_status IN ('not_required','pending','reviewing','cleared','actioned')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_at TIMESTAMPTZ,
 reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS user_safety_screenings_queue_idx ON user_safety_screenings (review_status,severity,created_at DESC);
CREATE INDEX IF NOT EXISTS user_safety_screenings_user_idx ON user_safety_screenings (user_id,created_at DESC);