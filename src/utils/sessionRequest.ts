/**
 * Guards asynchronous UI work against results from an earlier authenticated
 * session or an older request within the same session.
 */
export function isCurrentSessionRequest(requestEpoch: number, currentEpoch: number): boolean {
  return Number.isSafeInteger(requestEpoch) && Number.isSafeInteger(currentEpoch) &&
    requestEpoch >= 0 && currentEpoch >= 0 && requestEpoch === currentEpoch;
}
