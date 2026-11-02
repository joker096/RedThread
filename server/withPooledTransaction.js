/**
 * Run work in a transaction on a pooled PostgreSQL client.
 *
 * A client whose transaction cannot be rolled back must be destroyed rather
 * than returned to the pool in an unknown protocol/transaction state.
 */
/**
 * Roll back a manually managed transaction. If rollback fails, destroy the
 * pooled connection and return false so callers do not release it twice.
 */
export async function rollbackPooledTransaction(client) {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch (error) {
    client.release(error);
    return false;
  }
}

export async function withPooledTransaction(pool, callback) {
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError;

  try {
    try {
      await client.query('BEGIN');
      transactionOpen = true;
    } catch (error) {
      // BEGIN may have failed after the connection lost synchronization.
      releaseError = error;
      throw error;
    }

    const result = await callback(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        // node-postgres destroys a client released with an error. Never hand a
        // connection with an open/unknown transaction to another request.
        releaseError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
