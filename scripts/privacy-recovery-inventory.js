import pg from 'pg';
import { resolvePrivacyRecoveryMappings } from '../server/privacyRecoveryMapping.js';

const { Pool } = pg;

function assertIsolatedRestoreEnvironment(env) {
  if (env.NODE_ENV === 'production' || env.PRIVACY_RECOVERY_RESTORE_ISOLATED !== 'true') {
    throw new Error('privacy_recovery_inventory_requires_isolated_restore');
  }
  if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL) {
    throw new Error('privacy_recovery_inventory_database_url_required');
  }
  if (typeof env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY !== 'string' ||
      env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY.length < 32) {
    throw new Error('privacy_recovery_inventory_pseudonym_key_required');
  }
}

function summarizeMappings(mappings) {
  const byStatus = {};
  const byEventType = {};
  const unresolvedSequences = [];
  for (const mapping of mappings) {
    byStatus[mapping.status] = (byStatus[mapping.status] || 0) + 1;
    byEventType[mapping.eventType] = (byEventType[mapping.eventType] || 0) + 1;
    if (mapping.status !== 'matched') unresolvedSequences.push(mapping.sequence);
  }
  return {
    eventCount: mappings.length,
    matchedCount: byStatus.matched || 0,
    unresolvedCount: mappings.length - (byStatus.matched || 0),
    byStatus,
    byEventType,
    unresolvedSequences,
    readyForDomainReplay: mappings.length > 0 && unresolvedSequences.length === 0
  };
}

/**
 * Read-only inventory against an explicitly isolated restored database.
 * No account/resource identifiers or pseudonym references are emitted.
 */
export async function runPrivacyRecoveryInventory({ pool, env = process.env } = {}) {
  assertIsolatedRestoreEnvironment(env);
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('privacy_recovery_inventory_pool_required');
  }
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const eventsResult = await client.query(
      `SELECT ledger_sequence AS sequence, event_id, event_type, subject_ref, resource_ref
         FROM privacy_recovery_events
        ORDER BY ledger_sequence ASC`
    );
    const events = eventsResult.rows || [];
    for (let i = 1; i < events.length; i += 1) {
      if (Number(events[i].sequence) !== Number(events[i - 1].sequence) + 1) {
        throw new Error('privacy_recovery_inventory_staged_sequence_gap');
      }
    }
    const [users, voiceIntros, photos, giftOrders] = await Promise.all([
      client.query('SELECT id FROM users'),
      client.query('SELECT id FROM profile_voice_intros'),
      client.query('SELECT id FROM photo_assets'),
      client.query('SELECT id FROM gift_delivery_orders')
    ]);
    const mappings = resolvePrivacyRecoveryMappings({
      events,
      pseudonymKey: env.PRIVACY_RECOVERY_LEDGER_PSEUDONYM_KEY,
      users: users.rows || [],
      voiceIntros: voiceIntros.rows || [],
      photos: photos.rows || [],
      giftOrders: giftOrders.rows || []
    });
    const summary = summarizeMappings(mappings);
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      mode: 'read_only_isolated_restore_inventory',
      firstSequence: events.length ? Number(events[0].sequence) : null,
      lastSequence: events.length ? Number(events[events.length - 1].sequence) : null,
      candidateCounts: {
        users: users.rowCount,
        voiceIntros: voiceIntros.rowCount,
        photos: photos.rowCount,
        giftOrders: giftOrders.rowCount
      },
      ...summary
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  assertIsolatedRestoreEnvironment(process.env);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    const report = await runPrivacyRecoveryInventory({ pool, env: process.env });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\\n`);
    if (!report.readyForDomainReplay) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    process.stderr.write(`${error.message || 'privacy_recovery_inventory_failed'}\\n`);
    process.exitCode = 1;
  });
}
