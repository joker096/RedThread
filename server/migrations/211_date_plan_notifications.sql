-- Date plan lifecycle alerts are intentionally generic. They never include venue,
-- scheduled time, participant identity, or other private details in the notification type.
ALTER TABLE user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_type_check;

ALTER TABLE user_notifications
  ADD CONSTRAINT user_notifications_type_check
  CHECK (type IN (
    'new_match',
    'new_message',
    'gift_request',
    'gift_request_update',
    'date_plan_proposed',
    'date_plan_confirmed',
    'date_plan_cancelled',
    'date_plan_declined'
  ));

COMMENT ON CONSTRAINT user_notifications_type_check ON user_notifications IS
  'Supported in-app notification categories, including privacy-preserving date plan lifecycle alerts.';
