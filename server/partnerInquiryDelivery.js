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
  WHERE inquiry.delivery_status = 'pending'
  ORDER BY inquiry.created_at ASC
  LIMIT $1
  FOR UPDATE OF inquiry SKIP LOCKED
  FOR SHARE OF application
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
    try {
      await sendEmail({
        to: inquiry.contactEmail,
        idempotencyKey: 'partner-service-inquiry/' + inquiry.id,
        subject: 'Новый запрос по услуге в Vow',
        html: '<h2>Запрос предложения</h2><p>Пользователь дал согласие передать поставщику своё имя, email и текст запроса.</p>' +
          '<p><strong>Имя:</strong> ' + escapeHtml(inquiry.requesterName) + '</p>' +
          '<p><strong>Email:</strong> ' + escapeHtml(inquiry.requesterEmail) + '</p>' + dateLine +
          '<p><strong>Сообщение:</strong></p><p>' + escapeHtml(inquiry.requestNote).replace(/\n/g, '<br>') + '</p>' +
          '<p>Данные второго участника совпадения, переписка и результаты совместимости не передаются.</p>'
      });
    } catch {
      // A thrown transport error does not prove the provider rejected the message:
      // the provider may have accepted it before the response was lost. Keep the
      // record in "sending" and require provider-log reconciliation; never retry blindly.
      reconciliationPending += 1;
      continue;
    }
    try {
      await pool.query(
        "UPDATE partner_service_inquiries SET delivery_status = 'sent', delivered_at = NOW(), updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
        [inquiry.id]
      );
      sent += 1;
    } catch {
      // The provider accepted the email. Keep "sending" for manual reconciliation.
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

  try {
    await sendEmail(emailPayload);
  } catch {
    return { sent: false, deliveryStatus: 'reconciliation_pending' };
  }

  try {
    const updated = await pool.query(
      "UPDATE partner_service_inquiries SET delivery_status = 'sent', delivered_at = NOW(), updated_at = NOW() WHERE id = $1 AND delivery_status = 'sending'",
      [inquiryId]
    );
    if (updated.rowCount !== 1) {
      return { sent: true, deliveryStatus: 'status_update_pending' };
    }
  } catch {
    return { sent: true, deliveryStatus: 'status_update_pending' };
  }
  return { sent: true, deliveryStatus: 'sent' };
}
