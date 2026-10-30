export const MIGRATION_ADVISORY_LOCK_CLASS = 724110;
export const MIGRATION_ADVISORY_LOCK_ID = 1;

/**
 * Hold a session-level PostgreSQL advisory lock for the complete migration
 * run. Unlike transaction-level locks, this remains held across each
 * migration's BEGIN/COMMIT boundary.
 */
export async function acquireMigrationLock(client) {
  await client.query(
    'SELECT pg_advisory_lock($1, $2)',
    [MIGRATION_ADVISORY_LOCK_CLASS, MIGRATION_ADVISORY_LOCK_ID]
  );

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
