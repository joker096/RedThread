-- Generic, privacy-preserving notification to the sender after a recipient changes a request.
ALTER TABLE user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_type_check;

ALTER TABLE user_notifications
  ADD CONSTRAINT user_notifications_type_check
  CHECK (type IN ('new_match', 'new_message', 'gift_request', 'gift_request_update'));

COMMENT ON CONSTRAINT user_notifications_type_check ON user_notifications IS
  'In-app notification categories. Gift request updates are generic and must not expose refusal reasons or safety/moderation details.';
