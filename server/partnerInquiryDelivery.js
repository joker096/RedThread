function requireProviderMessageId(providerResult) {
  const value = providerResult?.providerMessageId;
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 255 || /\s/.test(value)) {
    throw new Error('email_provider_message_id_missing_or_invalid');
  }
  return value.trim();
}

export const PENDING_PARTNER_INQUIRIES_SQL = `
  SELECT inquiry.id, inquiry.requester_name AS "requesterName",
         inquiry.requester_email AS "requesterEmail",
         inquiry.service_date AS "serviceDate", inquiry.request_note AS "requestNote",
         application.contact_email AS "contactEmail"
  FROM partner_service_inquiries inquiry
  JOIN partner_service_applications application
    ON application.id = inquiry.application_id
  JOIN matches active_match
    ON active_match.id = inquiry.match_id
   AND (active_match.user_a_id = inquiry.requested_by OR active_match.user_b_id = inquiry.requested_by)
  JOIN users requester
    ON requester.id = inquiry.requested_by
  WHERE inquiry.delivery_status = 'pending'
  ORDER BY inquiry.created_at ASC
  LIMIT $1
  FOR UPDATE OF inquiry SKIP LOCKED
  FOR SHARE OF application, active_match, requester
`;


export const MY_PARTNER_INQUIRIES_SQL = `
  SELECT inquiry.id, inquiry.application_id AS "applicationId",
         inquiry.match_id AS "matchId",
         application.business_name AS "businessName",
         inquiry.delivery_status AS "deliveryStatus",
         inquiry.service_date AS "serviceDate",
         inquiry.created_at AS "createdAt",
         inquiry.updated_at AS "updatedAt"
  FROM partner_service_inquiries inquiry
  JOIN partner_service_applications application
    ON application.id = inquiry.application_id
  WHERE inquiry.requested_by = $1
  ORDER BY inquiry.created_at DESC
  LIMIT 50
`;

export const CANCEL_PARTNER_INQUIRY_SQL = `
  UPDATE partner_service_inquiries
  SET delivery_status = 'cancelled',
      cancelled_at = NOW(),
      delivery_error = 'requester_withdrew_consent_before_provider_acceptance',
      updated_at = NOW()
  WHERE id = $1
    AND requested_by = $2
    AND delivery_status IN ('pending', 'failed')
    AND provider_message_id IS NULL
  RETURNING id
`;

export const CLAIM_PARTNER_INQUIRY_SQL = `
  UPDATE partner_service_inquiries AS inquiry
  SET delivery_status = 'sending',
      delivery_attempts = delivery_attempts + 1,
      delivery_error = '',
      updated_at = NOW()
  WHERE inquiry.id = $1
    AND inquiry.delivery_status IN ('pending', 'failed')
    AND inquiry.contact_consent_at IS NOT NULL
    AND inquiry.contact_consent_version = 'partner-inquiry-v1'
    AND EXISTS (
      SELECT 1 FROM partner_service_applications application
      WHERE application.id = inquiry.application_id
        AND application.status = 'approved'
        AND application.published_at IS NOT NULL
    )
    AND EXISTS (
      SELECT 1 FROM matches active_match
      WHERE active_match.id = inquiry.match_id
        AND active_match.status = 'active'
        AND (active_match.user_a_id = inquiry.requested_by OR active_match.user_b_id = inquiry.requested_by)
    )
    AND EXISTS (
      SELECT 1 FROM users requester
      WHERE requester.id = inquiry.requested_by
        AND requester.status = 'active'
        AND requester.email_verified_at IS NOT NULL
        AND LOWER(BTRIM(requester.email)) = inquiry.requester_email
    )
  RETURNING inquiry.id
`;

export const PARTNER_INQUIRY_OWNER_SQL = `
  SELECT requested_by AS "requestedBy"
  FROM partner_service_inquiries
  WHERE id = $1
`;

export const REVALIDATE_PARTNER_INQUIRY_SQL = `
  SELECT inquiry.id
  FROM partner_service_inquiries inquiry
  JOIN partner_service_applications application
    ON application.id = inquiry.application_id
   AND application.status = 'approved'
   AND application.published_at IS NOT NULL
  JOIN matches active_match
    ON active_match.id = inquiry.match_id
   AND active_match.status = 'active'
   AND (active_match.user_a_id = inquiry.requested_by OR active_match.user_b_id = inquiry.requested_by)
  JOIN users requester
    ON requester.id = inquiry.requested_by
   AND requester.status = 'active'
   AND requester.email_verified_at IS NOT NULL
   AND LOWER(BTRIM(requester.email)) = inquiry.requester_email
  WHERE inquiry.id = $1
    AND inquiry.delivery_status = 'sending'
    AND inquiry.contact_consent_at IS NOT NULL
    AND inquiry.contact_consent_version = 'partner-inquiry-v1'
  FOR UPDATE OF inquiry
  FOR SHARE OF application, active_match, requester
`;

export const RECOVER_PARTNER_INQUIRY_SQL = `
  UPDATE partner_service_inquiries
  SET delivery_status = 'reconciliation_required',
      delivery_error = 'operator_confirmed_worker_terminated',
      updated_at = NOW()
  WHERE id = $1
    AND delivery_status = 'sending'
  RETURNING id, delivery_status AS "deliveryStatus", provider_message_id AS "providerMessageId"
`;

export async function deliverClaimedPartnerInquiry(pool, sendEmail, inquiryId, emailPayload) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }
  if (typeof sendEmail !== 'function') throw new TypeError('An email delivery function is required.');
  if (typeof inquiryId !== 'string' || !inquiryId) throw new TypeError('An inquiry ID is required.');

  let client;
  let transactionOpen = false;
  let providerCallStarted = false;
  let providerAccepted = false;
  let providerMessageId = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    // Acquire the same per-requester advisory lock as account deletion before
    // taking row locks. This prevents both post-erasure sends and lock-order
    // deadlocks with the account-erasure transaction.
    const owner = await client.query(PARTNER_INQUIRY_OWNER_SQL, [inquiryId]);
    if (owner.rowCount !== 1 || !owner.rows?.[0]?.requestedBy) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { sent: false, emailProviderAccepted: false, deliveryStatus: 'failed' };
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('gift-safety-user:' || $1::uuid::text))",
      [owner.rows[0].requestedBy]
    );

    // Hold locks on the inquiry, match, requester and provider until the
    // provider call has finished. Status changes cannot race the actual send.
    const eligibility = await client.query(REVALIDATE_PARTNER_INQUIRY_SQL, [inquiryId]);
    if (eligibility.rowCount !== 1) {
      const blocked = await client.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'failed', delivery_error = 'eligibility_lost_before_provider_call', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending' RETURNING id",
        [inquiryId]
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return blocked.rowCount === 1
        ? { sent: false, emailProviderAccepted: false, deliveryStatus: 'failed' }
        : { sent: false, emailProviderAccepted: false, deliveryStatus: 'reconciliation_required' };
    }

    providerCallStarted = true;
    let providerResult;
    try {
      providerResult = await sendEmail(emailPayload);
      providerMessageId = requireProviderMessageId(providerResult);
      providerAccepted = true;
    } catch {
      await client.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'reconciliation_required', delivery_error = 'provider_outcome_ambiguous', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
        [inquiryId]
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { sent: false, emailProviderAccepted: null, deliveryStatus: 'reconciliation_required' };
    }

    const updated = await client.query(
      "UPDATE partner_service_inquiries SET delivery_status = 'sent', delivered_at = NOW(), provider_message_id = $2, delivery_error = '', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending' RETURNING id",
      [inquiryId, providerMessageId]
    );
    if (updated.rowCount !== 1) throw new Error('partner_inquiry_sent_state_not_persisted');

    await client.query('COMMIT');
    transactionOpen = false;
    return { sent: true, emailProviderAccepted: true, providerMessageId, deliveryStatus: 'sent' };
  } catch {
    if (client && transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
      transactionOpen = false;
    }

    if (providerCallStarted) {
      try {
        await pool.query(
          "UPDATE partner_service_inquiries SET delivery_status = 'reconciliation_required', provider_message_id = COALESCE(provider_message_id, $2), delivery_error = 'provider_accepted_status_unknown', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
          [inquiryId, providerAccepted ? providerMessageId : null]
        );
      } catch { /* Keep sending fail-closed if storage is unavailable. */ }
      return {
        sent: false,
        emailProviderAccepted: providerAccepted ? true : null,
        ...(providerMessageId ? { providerMessageId } : {}),
        deliveryStatus: 'reconciliation_required'
      };
    }

    try {
      const blocked = await pool.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'failed', delivery_error = 'eligibility_recheck_failed_before_provider_call', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending' RETURNING id",
        [inquiryId]
      );
      if (blocked.rowCount === 1) {
        return { sent: false, emailProviderAccepted: false, deliveryStatus: 'failed' };
      }
    } catch { /* If the database is unavailable, retain the non-retryable sending claim. */ }
    return { sent: false, emailProviderAccepted: false, deliveryStatus: 'reconciliation_required' };
  } finally {
    client?.release();
  }
}

export async function deliverPendingPartnerInquiries(pool, sendEmail, options = {}) {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Partner inquiry batch limit must be a whole number between 1 and 100.');
  }
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }
  if (typeof sendEmail !== 'function') throw new TypeError('An email delivery function is required.');

  const client = await pool.connect();
  let inquiries = [];
  try {
    await client.query('BEGIN');
    const selected = await client.query(PENDING_PARTNER_INQUIRIES_SQL, [limit]);
    inquiries = selected.rows;
    for (const inquiry of inquiries) {
      await client.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'sending', delivery_attempts = delivery_attempts + 1, delivery_error = '', updated_at = NOW() WHERE id = $1 AND delivery_status = 'pending'",
        [inquiry.id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let sent = 0;
  let failed = 0;
  let reconciliationPending = 0;
  for (const inquiry of inquiries) {
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      [String.fromCharCode(34)]: '&quot;',
      [String.fromCharCode(39)]: '&#39;'
    })[character]);
    const dateLine = inquiry.serviceDate
      ? '<p><strong>Желаемая дата:</strong> ' + escapeHtml(inquiry.serviceDate) + '</p>'
      : '';
    const result = await deliverClaimedPartnerInquiry(pool, sendEmail, inquiry.id, {
      to: inquiry.contactEmail,
      idempotencyKey: 'partner-service-inquiry/' + inquiry.id,
      subject: 'Новый запрос по услуге в Vow',
      html: '<h2>Запрос предложения</h2><p>Пользователь дал согласие передать поставщику своё имя, email и текст запроса.</p>' +
        '<p><strong>Имя:</strong> ' + escapeHtml(inquiry.requesterName) + '</p>' +
        '<p><strong>Email:</strong> ' + escapeHtml(inquiry.requesterEmail) + '</p>' + dateLine +
        '<p><strong>Сообщение:</strong></p><p>' + escapeHtml(inquiry.requestNote).replace(/\n/g, '<br>') + '</p>' +
        '<p>Данные второго участника совпадения, переписка и результаты совместимости не передаются.</p>'
    });
    if (result.deliveryStatus === 'sent') sent += 1;
    else if (result.deliveryStatus === 'failed') failed += 1;
    else reconciliationPending += 1;
  }
  return { claimed: inquiries.length, sent, failed, reconciliationPending };
}
