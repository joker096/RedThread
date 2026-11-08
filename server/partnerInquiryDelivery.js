export const PENDING_PARTNER_INQUIRIES_SQL = `
  SELECT inquiry.id, inquiry.requester_name AS "requesterName",
         inquiry.requester_email AS "requesterEmail",
         inquiry.service_date AS "serviceDate", inquiry.request_note AS "requestNote",
         application.contact_email AS "contactEmail"
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
  WHERE inquiry.delivery_status = 'pending'
  ORDER BY inquiry.created_at ASC
  LIMIT $1
  FOR UPDATE OF inquiry SKIP LOCKED
  FOR SHARE OF application
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
    let providerMessageId = null;
    try {
      const providerResult = await sendEmail({
        to: inquiry.contactEmail,
        idempotencyKey: 'partner-service-inquiry/' + inquiry.id,
        subject: 'Новый запрос по услуге в Vow',
        html: '<h2>Запрос предложения</h2><p>Пользователь дал согласие передать поставщику своё имя, email и текст запроса.</p>' +
          '<p><strong>Имя:</strong> ' + escapeHtml(inquiry.requesterName) + '</p>' +
          '<p><strong>Email:</strong> ' + escapeHtml(inquiry.requesterEmail) + '</p>' + dateLine +
          '<p><strong>Сообщение:</strong></p><p>' + escapeHtml(inquiry.requestNote).replace(/\n/g, '<br>') + '</p>' +
          '<p>Данные второго участника совпадения, переписка и результаты совместимости не передаются.</p>'
      });
      providerMessageId = typeof providerResult?.providerMessageId === 'string' &&
        providerResult.providerMessageId.length <= 255 ? providerResult.providerMessageId : null;
    } catch {
      // The provider outcome is ambiguous. Move out of the active-send state before
      // exposing the row to moderator reconciliation; never retry automatically.
      try {
        await pool.query(
          "UPDATE partner_service_inquiries SET delivery_status = 'reconciliation_required', delivery_error = 'provider_outcome_ambiguous', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
          [inquiry.id]
        );
      } catch { /* Leave sending fail-closed if the database is unavailable. */ }
      reconciliationPending += 1;
      continue;
    }
    try {
      const updated = await pool.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'sent', delivered_at = NOW(), provider_message_id = $2, delivery_error = '', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending' RETURNING id",
        [inquiry.id, providerMessageId]
      );
      if (updated.rowCount !== 1) {
        reconciliationPending += 1;
        continue;
      }
      sent += 1;
    } catch {
      // Provider accepted the email, but persistence is uncertain. Best-effort
      // transition prevents reconciliation from racing an active provider call.
      try {
        await pool.query(
          "UPDATE partner_service_inquiries SET delivery_status = 'reconciliation_required', provider_message_id = COALESCE(provider_message_id, $2), delivery_error = 'provider_accepted_status_unknown', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
          [inquiry.id, providerMessageId]
        );
      } catch { /* Leave sending fail-closed if the database is unavailable. */ }
      reconciliationPending += 1;
    }
  }
  return { claimed: inquiries.length, sent, failed, reconciliationPending };
}

/**
 * Delivers an inquiry already claimed by the synchronous API route.
 * Transport errors are ambiguous: never release the claim for an automatic retry.
 */
export async function deliverClaimedPartnerInquiry(pool, sendEmail, inquiryId, emailPayload) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  if (typeof sendEmail !== 'function') throw new TypeError('An email delivery function is required.');
  if (typeof inquiryId !== 'string' || !inquiryId) throw new TypeError('An inquiry ID is required.');

  let providerMessageId = null;
  try {
    const providerResult = await sendEmail(emailPayload);
    providerMessageId = typeof providerResult?.providerMessageId === 'string' &&
      providerResult.providerMessageId.length <= 255 ? providerResult.providerMessageId : null;
  } catch {
    try {
      await pool.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'reconciliation_required', delivery_error = 'provider_outcome_ambiguous', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
        [inquiryId]
      );
    } catch { /* Preserve the non-retryable sending state if persistence is unavailable. */ }
    return { sent: false, emailProviderAccepted: null, deliveryStatus: 'reconciliation_required' };
  }

  try {
    const updated = await pool.query(
      "UPDATE partner_service_inquiries SET delivery_status = 'sent', delivered_at = NOW(), provider_message_id = $2, delivery_error = '', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending' RETURNING id",
      [inquiryId, providerMessageId]
    );
    if (updated.rowCount !== 1) {
      return { sent: false, emailProviderAccepted: true, providerMessageId, deliveryStatus: 'reconciliation_required' };
    }
  } catch {
    try {
      await pool.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'reconciliation_required', provider_message_id = COALESCE(provider_message_id, $2), delivery_error = 'provider_accepted_status_unknown', updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
        [inquiryId, providerMessageId]
      );
    } catch { /* Keep the claim fail-closed if the database is unavailable. */ }
    return { sent: false, emailProviderAccepted: true, providerMessageId, deliveryStatus: 'reconciliation_required' };
  }
  return { sent: true, emailProviderAccepted: true, providerMessageId, deliveryStatus: 'sent' };
}
