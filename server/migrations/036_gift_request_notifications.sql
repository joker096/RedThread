-- In-app notification for a newly created gift request.
ALTER TABLE user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_type_check;

ALTER TABLE user_notifications
  ADD CONSTRAINT user_notifications_type_check
  CHECK (type IN ('new_match', 'new_message', 'gift_request'));

COMMENT ON CONSTRAINT user_notifications_type_check ON user_notifications IS
  'Supported in-app notification categories, including recipient-only gift request alerts.';
