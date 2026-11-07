const DEFAULT_RETENTION = Object.freeze({
  inquiryDays: 180,
  rejectedApplicationDays: 180,
  inactiveApplicationDays: 365
});

function retentionDays(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new RangeError('Partner retention periods must be whole days between 1 and 3650.');
  }
  return parsed;
}

/**
 * Removes requester contact details and expired, unpublished partner applications.
 * Approved applications are never removed by this job because they may back live listings.
 */
export async function cleanupPartnerServiceData(pool, options = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }

  const inquiryDays = retentionDays(options.inquiryDays, DEFAULT_RETENTION.inquiryDays);
  const rejectedApplicationDays = retentionDays(options.rejectedApplicationDays, DEFAULT_RETENTION.rejectedApplicationDays);
  const inactiveApplicationDays = retentionDays(options.inactiveApplicationDays, DEFAULT_RETENTION.inactiveApplicationDays);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inquiries = await client.query(
      `DELETE FROM partner_service_inquiries
       WHERE created_at < NOW() - make_interval(days => $1)
          OR application_id IN (
            SELECT id FROM partner_service_applications
            WHERE (status = 'rejected' AND updated_at < NOW() - make_interval(days => $2))
               OR (status IN ('pending', 'in_review') AND updated_at < NOW() - make_interval(days => $3))
          )`,
      [inquiryDays, rejectedApplicationDays, inactiveApplicationDays]
    );
    const applications = await client.query(
      `DELETE FROM partner_service_applications
       WHERE (status = 'rejected' AND updated_at < NOW() - make_interval(days => $1))
          OR (status IN ('pending', 'in_review') AND updated_at < NOW() - make_interval(days => $2))`,
      [rejectedApplicationDays, inactiveApplicationDays]
    );
    await client.query('COMMIT');
    return {
      inquiriesDeleted: inquiries.rowCount ?? 0,
      applicationsDeleted: applications.rowCount ?? 0
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function partnerRetentionOptions(env = process.env) {
  return {
    inquiryDays: retentionDays(env.PARTNER_INQUIRY_RETENTION_DAYS, DEFAULT_RETENTION.inquiryDays),
    rejectedApplicationDays: retentionDays(env.PARTNER_REJECTED_RETENTION_DAYS, DEFAULT_RETENTION.rejectedApplicationDays),
    inactiveApplicationDays: retentionDays(env.PARTNER_INACTIVE_RETENTION_DAYS, DEFAULT_RETENTION.inactiveApplicationDays)
  };
}
