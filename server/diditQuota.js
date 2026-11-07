export const DIDIT_FREE_MONTHLY_SESSION_LIMIT = 500;

export function canReserveDiditFreeSession(currentCount) {
  return Number.isSafeInteger(currentCount) && currentCount >= 0 && currentCount < DIDIT_FREE_MONTHLY_SESSION_LIMIT;
}


/**
 * Release a Didit reservation only after a typed, definitive provider rejection
 * or a local preflight failure. The caller must hold the account safety lock
 * and run this inside a transaction. Ambiguous outcomes must never call this.
 */
export async function releaseDiditSessionReservation(client, { userId, reservationId }) {
  const found = await client.query(
    `SELECT environment,
            COALESCE(
              quota_month_start,
              date_trunc('month', created_at AT TIME ZONE 'UTC')::date
            ) AS month_start
     FROM identity_verification_session_reservations
     WHERE id = $1 AND user_id = $2
       AND status = 'reserved' AND provider_session_id IS NULL
     FOR UPDATE`,
    [reservationId, userId]
  );
  const reservation = found.rows[0];
  if (!reservation) return false;

  const deleted = await client.query(
    `DELETE FROM identity_verification_session_reservations
     WHERE id = $1 AND user_id = $2
       AND status = 'reserved' AND provider_session_id IS NULL`,
    [reservationId, userId]
  );
  if (deleted.rowCount !== 1) return false;

  if (reservation.environment === 'live') {
    const quota = await client.query(
      `UPDATE didit_monthly_quota_usage
       SET reserved_count = reserved_count - 1,
           updated_at = statement_timestamp()
       WHERE month_start = $1 AND reserved_count > 0
       RETURNING month_start`,
      [reservation.month_start]
    );
    if (quota.rowCount !== 1) {
      throw Object.assign(new Error('didit_monthly_quota_counter_missing'), {
        code: 'didit_monthly_quota_counter_missing'
      });
    }
  }
  return true;
}
