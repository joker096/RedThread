# PostgreSQL backup and restore runbook

## Create a backup

Use a deployment secret manager for DATABASE_URL; do not commit credentials. On a trusted Linux host with PostgreSQL client tools installed:

```bash
chmod +x scripts/backup-postgres.sh
BACKUP_DIR=/secure/backups BACKUP_RETENTION_DAYS=30 ./scripts/backup-postgres.sh
```

The script creates a custom-format pg_dump, restricts local permissions, writes a SHA-256 checksum and removes local backups past the configured retention. A local backup is not a disaster-recovery plan: copy it to encrypted off-site/object storage with restricted access and lifecycle policies.

## Restore test

On a separate staging database, create a fresh database and restore a recent dump:

```bash
createdb vow_restore_test
pg_restore --dbname=vow_restore_test --no-owner --no-acl /secure/backups/vow-postgres-YYYYMMDDTHHMMSSZ.dump
```

Verify migrations, account access, profiles, matches, messages, photo metadata and billing state. Do not restore production data into an unapproved development environment. Delete test copies after verification.

## Production checklist

- Schedule the script using the deployment scheduler or cron; scheduling is not enabled automatically by this repository.
- Alert on failed or missing backups.
- Keep database backups encrypted, access-controlled and separate from the application host.
- Include the private photo volume in a separate backup plan or use a managed object store with versioning and lifecycle rules.
- Define recovery point objective, recovery time objective, retention and deletion policy.
- Run a restore drill before public launch and regularly afterward.
