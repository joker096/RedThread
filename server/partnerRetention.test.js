import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupPartnerServiceData, partnerRetentionOptions } from './partnerRetention.js';

function fakePool({ failOnQuery } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (failOnQuery && sql.startsWith(failOnQuery)) throw new Error('database failure');
      if (sql.startsWith('DELETE FROM partner_service_inquiries')) return { rowCount: 3 };
      if (sql.startsWith('DELETE FROM partner_service_applications')) return { rowCount: 2 };
      return { rowCount: 0 };
    },
    release() { released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, wasReleased: () => released };
}

test('partner retention cleanup removes inquiries before stale applications in one transaction', async () => {
  const fake = fakePool();
  const result = await cleanupPartnerServiceData(fake.pool);
  assert.deepEqual(result, { inquiriesDeleted: 3, applicationsDeleted: 2 });
  assert.equal(fake.calls[0].sql, 'BEGIN');
  assert.match(fake.calls[1].sql, /DELETE FROM partner_service_inquiries/);
  assert.match(fake.calls[1].sql, /make_interval\(days => \$1\)/);
  assert.match(fake.calls[1].sql, /application_id IN \([\s\S]*FROM partner_service_applications/,
    'inquiries for expired unpublished applications must be removed before their application rows');
  assert.match(fake.calls[1].sql, /status = 'rejected'/);
  assert.match(fake.calls[1].sql, /status IN \('pending', 'in_review'\)/);
  assert.doesNotMatch(fake.calls[1].sql, /status\s*=\s*'approved'/,
    'inquiry cleanup must not cascade from approved applications');
  assert.deepEqual(fake.calls[1].values, [180, 180, 365]);
  assert.match(fake.calls[2].sql, /status = 'rejected'/);
  assert.match(fake.calls[2].sql, /status IN \('pending', 'in_review'\)/);
  assert.doesNotMatch(fake.calls[2].sql, /status\s*=\s*'approved'/,
    'retention cleanup must never delete approved applications that may back published listings');
  assert.deepEqual(fake.calls[2].values, [180, 365]);
  assert.equal(fake.calls[3].sql, 'COMMIT');
  assert.equal(fake.wasReleased(), true);
});

test('partner retention cleanup rolls back and releases its client on failure', async () => {
  const fake = fakePool({ failOnQuery: 'DELETE FROM partner_service_applications' });
  await assert.rejects(() => cleanupPartnerServiceData(fake.pool), /database failure/);
  assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(fake.wasReleased(), true);
});

test('retention options accept bounded whole-day overrides and reject unsafe values', () => {
  assert.deepEqual(partnerRetentionOptions({
    PARTNER_INQUIRY_RETENTION_DAYS: '30',
    PARTNER_REJECTED_RETENTION_DAYS: '60',
    PARTNER_INACTIVE_RETENTION_DAYS: '120'
  }), { inquiryDays: 30, rejectedApplicationDays: 60, inactiveApplicationDays: 120 });
  assert.throws(() => partnerRetentionOptions({ PARTNER_INQUIRY_RETENTION_DAYS: '0' }), RangeError);
  assert.throws(() => partnerRetentionOptions({ PARTNER_REJECTED_RETENTION_DAYS: '1.5' }), RangeError);
  assert.throws(() => partnerRetentionOptions({ PARTNER_INACTIVE_RETENTION_DAYS: '99999' }), RangeError);
});

test('partner retention rejects invalid runtime overrides before opening a database connection', async () => {
  let connections = 0;
  const pool = {
    async connect() {
      connections += 1;
      throw new Error('must not connect for invalid retention settings');
    }
  };

  await assert.rejects(
    () => cleanupPartnerServiceData(pool, { inquiryDays: 0 }),
    RangeError
  );
  await assert.rejects(
    () => cleanupPartnerServiceData(pool, { inactiveApplicationDays: 1.5 }),
    RangeError
  );
  assert.equal(connections, 0, 'invalid retention settings must fail before any database work');
});
