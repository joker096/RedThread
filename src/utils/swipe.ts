export type SwipeAction = 'like' | 'pass' | 'none';

/**
 * Uses the standard dating-app convention: right = like, left = pass.
 * Short gestures and invalid deltas do not trigger an action.
 */
export function getSwipeActionFromDelta(delta: number, threshold = 80): SwipeAction {
  if (!Number.isFinite(delta) || !Number.isFinite(threshold) || threshold <= 0) return 'none';
  if (delta >= threshold) return 'like';
  if (delta <= -threshold) return 'pass';
  return 'none';
}
