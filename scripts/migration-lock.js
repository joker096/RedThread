import { setTimeout as delay } from 'node:timers/promises';

export const MIGRATION_ADVISORY_LOCK_CLASS = 724110;
export const MIGRATION_ADVISORY_LOCK_ID = 1;

/**
 * Acquire a session-level lock without blocking the connection indefinitely.
 * The optional shouldAbort callback lets CLI shutdown stop waiting safely.
 */
export async function acquireMigrationLock(client, {
  shouldAbort = () => false,
  retryDelayMs = 250
} = {}) {
  let acquired = false;
  while (!acquired && !shouldAbort()) {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [MIGRATION_ADVISORY_LOCK_CLASS, MIGRATION_ADVISORY_LOCK_ID]
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired && !shouldAbort()) await delay(retryDelayMs);
  }

  if (!acquired) return null;

  let released = false;
  return async function releaseMigrationLock() {
    if (released) return;
    const result = await client.query(
      'SELECT pg_advisory_unlock($1, $2) AS unlocked',
      [MIGRATION_ADVISORY_LOCK_CLASS, MIGRATION_ADVISORY_LOCK_ID]
    );
    if (result.rows[0]?.unlocked !== true) {
      throw new Error('migration advisory lock was not held by this connection');
    }
    released = true;
  };
}
