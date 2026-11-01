export const DIDIT_FREE_MONTHLY_SESSION_LIMIT = 500;

export function canReserveDiditFreeSession(currentCount) {
  return Number.isSafeInteger(currentCount) && currentCount >= 0 && currentCount < DIDIT_FREE_MONTHLY_SESSION_LIMIT;
}
