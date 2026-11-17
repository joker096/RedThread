import { randomUUID } from 'node:crypto';

function quarantineCodeFor(errorCode) {
  const allowed = new Set([
    'provider_configuration_missing',
    'provider_account_environment_mismatch',
    'payment_identity_unknown',
    'provider_amount_currency_mismatch',
    'payment_order_missing'
  ]);
  return allowed.has(errorCode) ? errorCode : 'provider_event_processing_failed';
}

/**
 * Consumes one verified inbox event. It only links immutable provider metadata
 * to an exact payment-attempt identity and wakes an already-existing order
 * reconciliation task. It never mutates payment/order state or calls a provider.
 */
export async function processOneGiftProviderEvent({
  pool,
  providers = {},
  providerKey,
  workerId = `gift-event-${randomUUID()}`,
  leaseSeconds = 60,
  maxAttempts = 8
}) {
  if (!pool?.query || !pool?.connect) throw new TypeError('database_pool_required');
  if (!providers || typeof providers !== 'object' || Object.keys(providers).length === 0) {
    throw Object.assign(new Error('gift_provider_event_processor_not_configured'), {
      code: 'gift_provider_event_processor_not_configured'
    });
  }
  const configuredKeys = Object.keys(providers).sort();
  const selectedProviderKey = providerKey || (configuredKeys.length === 1 ? configuredKeys[0] : null);
  if (!selectedProviderKey || !/^[a-z][a-z0-9_]{1,79}$/.test(selectedProviderKey)) {
    throw Object.assign(new Error('gift_provider_event_provider_key_required'), {
      code: 'gift_provider_event_provider_key_required'
    });
  }
  const selectedProvider = providers[selectedProviderKey];
  if (!selectedProvider?.accountId || selectedProvider.environment !== 'sandbox') {
    throw Object.assign(new Error('gift_provider_event_processor_not_configured'), {
      code: 'gift_provider_event_processor_not_configured'
    });
  }

  const claim = await pool.query(
    'SELECT * FROM claim_gift_provider_event_inbox($1, $2, $3, $4)',
    [workerId, selectedProviderKey, leaseSeconds, maxAttempts]
  );
  const event = claim.rows[0];
  if (!event) return { claimed: false };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM gift_payment_provider_event_inbox
        WHERE id = $1 AND processing_status = 'pending'
          AND lease_token = $2 AND lease_generation = $3
          AND lease_expires_at > statement_timestamp()
        FOR UPDATE`,
      [event.id, event.lease_token, event.lease_generation]
    );
    const current = locked.rows[0];
    if (!current) throw Object.assign(new Error('gift_provider_event_lease_lost'), {
      code: 'gift_provider_event_lease_lost'
    });

    const quarantine = async code => {
      const result = await client.query(
        `UPDATE gift_payment_provider_event_inbox
            SET processing_status = 'quarantined', quarantine_code = $4,
                lease_token = NULL, lease_owner = NULL,
                claimed_at = NULL, lease_expires_at = NULL
          WHERE id = $1 AND processing_status = 'pending'
            AND lease_token = $2 AND lease_generation = $3
            AND lease_expires_at > statement_timestamp()`,
        [current.id, current.lease_token, current.lease_generation, quarantineCodeFor(code)]
      );
      if (result.rowCount !== 1) throw Object.assign(new Error('gift_provider_event_lease_lost'), {
        code: 'gift_provider_event_lease_lost'
      });
      await client.query('COMMIT');
      return { claimed: true, processed: false, quarantined: true, code };
    };

    const provider = current.provider_key === selectedProviderKey ? selectedProvider : null;
    if (!provider || !provider.accountId || provider.environment !== 'sandbox') {
      return await quarantine('provider_configuration_missing');
    }
    if (current.provider_account_id !== provider.accountId
        || current.environment !== provider.environment) {
      return await quarantine('provider_account_environment_mismatch');
    }

    const identityResult = await client.query(
      `SELECT identity.attempt_id, identity.order_id,
              identity.amount_minor_units, identity.currency
         FROM gift_payment_attempt_identity AS identity
        WHERE identity.provider_key = $1
          AND identity.provider_reference = $2
        FOR SHARE`,
      [current.provider_key, current.provider_reference]
    );
    const identity = identityResult.rows[0];
    if (!identity) return await quarantine('payment_identity_unknown');
    if (String(identity.amount_minor_units) !== String(current.amount_minor_units)
        || identity.currency !== current.currency) {
      return await quarantine('provider_amount_currency_mismatch');
    }

    const order = await client.query(
      'SELECT id FROM gift_delivery_orders WHERE id = $1 FOR SHARE',
      [identity.order_id]
    );
    if (order.rowCount !== 1) return await quarantine('payment_order_missing');

    // Only wake a pre-existing lifecycle reconciliation task. Never manufacture
    // cancellation work from a webhook alone, and never revive a dead-lettered
    // or completed task.
    const task = await client.query(
      `UPDATE gift_payment_reconciliation_tasks
          SET next_attempt_at = statement_timestamp(), updated_at = statement_timestamp()
        WHERE order_id = $1 AND status IN ('pending', 'failed')
          AND dead_lettered_at IS NULL
        RETURNING id`,
      [identity.order_id]
    );

    const processed = await client.query(
      `UPDATE gift_payment_provider_event_inbox
          SET processing_status = 'processed', matched_attempt_id = $4,
              lease_token = NULL, lease_owner = NULL,
              claimed_at = NULL, lease_expires_at = NULL
        WHERE id = $1 AND processing_status = 'pending'
          AND lease_token = $2 AND lease_generation = $3
          AND lease_expires_at > statement_timestamp()`,
      [current.id, current.lease_token, current.lease_generation, identity.attempt_id]
    );
    if (processed.rowCount !== 1) throw Object.assign(new Error('gift_provider_event_lease_lost'), {
      code: 'gift_provider_event_lease_lost'
    });
    await client.query('COMMIT');
    return {
      claimed: true,
      processed: true,
      matched: true,
      reconciliationTaskWoken: task.rowCount === 1
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
