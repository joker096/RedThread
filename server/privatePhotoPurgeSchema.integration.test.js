import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Pool } = pg;

test('private photo purge queue migration provides durable retry state', {
  skip: !process.env.DATABASE_URL,
  timeout: 10_000
}, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const storagePath = `/tmp/vow-photo-purge-test-${crypto.randomUUID()}.jpg`;
  try {
    const table = await client.query(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'private_photo_purge_queue'`
    );
    const columns = new Set(table.rows.map(row => row.column_name));
    for (const column of ['id', 'storage_path', 'created_at', 'attempts', 'next_attempt_at', 'last_error_code']) {
      assert.ok(columns.has(column), `queue must include ${column}`);
    }
    const unique = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'private_photo_purge_queue'`
    );
    assert.ok(unique.rows.some(row => /UNIQUE.*storage_path|storage_path.*UNIQUE/i.test(row.indexdef)));
    await client.query('BEGIN');
    try {
      const first = await client.query(
        'INSERT INTO private_photo_purge_queue (storage_path) VALUES ($1) ON CONFLICT (storage_path) DO NOTHING RETURNING id',
        [storagePath]
      );
      const duplicate = await client.query(
        'INSERT INTO private_photo_purge_queue (storage_path) VALUES ($1) ON CONFLICT (storage_path) DO NOTHING RETURNING id',
        [storagePath]
      );
      assert.equal(first.rowCount, 1);
      assert.equal(duplicate.rowCount, 0);
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
});
