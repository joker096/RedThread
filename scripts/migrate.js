import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { acquireMigrationLock } from './migration-lock.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required. Copy .env.example to .env and configure a PostgreSQL database.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(currentDir, '..', 'server', 'migrations');

async function runMigrations() {
  let client;
  let releaseMigrationLock;
  let releaseError;
  let shutdownSignal;
  const handleShutdownSignal = signal => {
    if (!shutdownSignal) {
      shutdownSignal = signal;
      console.warn(`Received ${signal}; finishing the current migration before shutting down.`);
    }
  };

  process.on('SIGINT', handleShutdownSignal);
  process.on('SIGTERM', handleShutdownSignal);

  try {
    client = await pool.connect();
    releaseMigrationLock = await acquireMigrationLock(client, {
      shouldAbort: () => Boolean(shutdownSignal)
    });

    if (releaseMigrationLock && !shutdownSignal) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const files = (await readdir(migrationsDir))
        .filter(name => name.endsWith('.sql'))
        .sort();

      for (const name of files) {
        if (shutdownSignal) break;

        const existing = await client.query(
          'SELECT 1 FROM schema_migrations WHERE name = $1',
          [name]
        );
        if (existing.rowCount) {
          console.log(`Skipping already applied migration: ${name}`);
          continue;
        }

        const sql = await readFile(path.join(migrationsDir, name), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
          console.log(`Applied migration: ${name}`);
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            releaseError = rollbackError;
            throw new AggregateError(
              [error, rollbackError],
              `Migration ${name} failed and its transaction could not be rolled back`,
              { cause: error }
            );
          }
          throw error;
        }
      }
    }
  } finally {
    if (client) {
      if (releaseMigrationLock && !releaseError) {
        try {
          await releaseMigrationLock();
        } catch (error) {
          releaseError = error;
        }
      }
      client.release(releaseError);
    }
    process.off('SIGINT', handleShutdownSignal);
    process.off('SIGTERM', handleShutdownSignal);
    await pool.end();

    if (shutdownSignal) {
      process.exitCode = shutdownSignal === 'SIGINT' ? 130 : 143;
    }
  }
}

runMigrations().catch(error => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
