#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${ARCHIVE_FILE:?Set ARCHIVE_FILE to the encrypted PostgreSQL .dump.age backup}"
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the age private identity file}"
: "${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL to a dedicated, empty staging database}"
: "${RESTORE_CONFIRM_STAGING:?Set RESTORE_CONFIRM_STAGING to I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE}"
: "${RESTORE_OWNER_ROLE:?Set RESTORE_OWNER_ROLE to the dedicated NOLOGIN owner role}"
if [[ ! "$RESTORE_OWNER_ROLE" =~ ^vow_restore_owner_[a-zA-Z0-9_]{1,40}$ ]]; then
  echo "restore owner role must use the dedicated vow_restore_owner_ prefix" >&2
  exit 1
fi
if [[ "$RESTORE_CONFIRM_STAGING" != "I_UNDERSTAND_THIS_IS_A_DISPOSABLE_STAGING_DATABASE" ]]; then
  echo "explicit staging-database confirmation is required" >&2
  exit 1
fi

command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore is required" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 1; }

CHECKSUM_FILE="${CHECKSUM_FILE:-${ARCHIVE_FILE}.sha256}"
for file in "$ARCHIVE_FILE" "$CHECKSUM_FILE" "$AGE_IDENTITY_FILE"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "archive, checksum and age identity must be regular non-symlink files" >&2
    exit 1
  fi
done

expected_checksum="$(awk 'NR == 1 { print $1 }' "$CHECKSUM_FILE")"
if ! [[ "$expected_checksum" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "backup checksum file is malformed" >&2
  exit 1
fi
actual_checksum="$(sha256sum "$ARCHIVE_FILE" | awk '{ print $1 }')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo "backup checksum verification failed" >&2
  exit 1
fi

# Never use --clean or drop/create the target. Refuse anything other than an empty staging DB.
restore_target_sql="
WITH target AS (
  SELECT current_database() AS database_name,
         (SELECT count(*) FROM pg_namespace
           WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
             AND nspname NOT LIKE 'pg_toast%')
         + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
         + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
         + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = 'public' AND t.typtype <> 'p' AND t.typcategory <> 'A') AS object_count
), owner_role AS (
  SELECT r.*, d.datdba = r.oid AS owns_database,
         has_database_privilege(r.oid, d.oid, 'CREATE') AS can_create_database,
         has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create_public
    FROM pg_roles r CROSS JOIN pg_database d
   WHERE r.rolname = :'owner_role' AND d.datname = current_database()
), restore_login AS (
  SELECT r.*,
         has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create_database,
         has_database_privilege(r.oid, current_database(), 'TEMP') AS can_temp,
         has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create_public,
         (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) AS membership_count,
         coalesce((SELECT bool_and(m.roleid = o.oid) FROM pg_auth_members m
                    JOIN owner_role o ON true WHERE m.member = r.oid), false) AS membership_matches,
         coalesce((SELECT bool_and(m.set_option) FROM pg_auth_members m
                    JOIN owner_role o ON true WHERE m.member = r.oid), false) AS membership_set,
         coalesce((SELECT bool_and(NOT m.inherit_option) FROM pg_auth_members m
                    JOIN owner_role o ON true WHERE m.member = r.oid), false) AS membership_no_inherit,
         coalesce((SELECT bool_and(NOT m.admin_option) FROM pg_auth_members m
                    JOIN owner_role o ON true WHERE m.member = r.oid), false) AS membership_no_admin
    FROM pg_roles r WHERE r.rolname = current_user
)
SELECT target.database_name || '|' || target.object_count || '|' ||
       coalesce(owner_role.rolname, '') || '|' ||
       coalesce(owner_role.rolcanlogin::text, '') || '|' ||
       coalesce(owner_role.rolsuper::text, '') || '|' ||
       coalesce(owner_role.rolcreatedb::text, '') || '|' ||
       coalesce(owner_role.rolcreaterole::text, '') || '|' ||
       coalesce(owner_role.rolreplication::text, '') || '|' ||
       coalesce(owner_role.rolbypassrls::text, '') || '|' ||
       coalesce(owner_role.owns_database::text, '') || '|' ||
       coalesce(owner_role.can_create_database::text, '') || '|' ||
       coalesce(owner_role.can_create_public::text, '') || '|' ||
       restore_login.rolname::text || '|' ||
       restore_login.rolsuper::text || '|' ||
       restore_login.rolcreatedb::text || '|' ||
       restore_login.rolcreaterole::text || '|' ||
       restore_login.rolreplication::text || '|' ||
       restore_login.rolbypassrls::text || '|' ||
       restore_login.rolcanlogin::text || '|' ||
       restore_login.can_create_database::text || '|' ||
       restore_login.can_temp::text || '|' ||
       restore_login.can_create_public::text || '|' ||
       restore_login.membership_count::text || '|' ||
       restore_login.membership_matches::text || '|' ||
       restore_login.membership_set::text || '|' ||
       restore_login.membership_no_inherit::text || '|' ||
       restore_login.membership_no_admin::text
  FROM target CROSS JOIN owner_role CROSS JOIN restore_login;
"
target_state="$(psql --dbname="$RESTORE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -v owner_role="$RESTORE_OWNER_ROLE" -c "$restore_target_sql")"
IFS='|' read -r target_database target_object_count owner_name owner_login owner_super owner_createdb owner_createrole owner_replication owner_bypassrls owner_owns_database owner_can_create_database owner_can_create_public login_name login_super login_createdb login_createrole login_replication login_bypassrls login_canlogin login_can_create_database login_can_temp login_can_create_public membership_count membership_matches membership_set membership_no_inherit membership_no_admin <<< "$target_state"
if ! [[ "$target_database" =~ ^vow_restore_(test|dst_[a-zA-Z0-9_]+)$ ]]; then
  echo "restore target database name must use the dedicated vow_restore_test or vow_restore_dst_ prefix" >&2
  exit 1
fi
if ! [[ "$target_object_count" =~ ^[0-9]+$ ]] || [[ "$target_object_count" != "0" ]]; then
  echo "restore target is not an empty staging database; refusing to restore" >&2
  exit 1
fi
if ! [[ "$login_name" =~ ^vow_restore_login_[a-zA-Z0-9_]{1,40}$ ]]; then
  echo "restore login role must use the dedicated vow_restore_login_ prefix" >&2
  exit 1
fi
if [[ "$owner_name" != "$RESTORE_OWNER_ROLE" || "$owner_login" != "f" ||
      "$owner_super" != "f" || "$owner_createdb" != "f" ||
      "$owner_createrole" != "f" || "$owner_replication" != "f" ||
      "$owner_bypassrls" != "f" || "$owner_owns_database" != "t" ||
      "$owner_can_create_database" != "t" || "$owner_can_create_public" != "t" ||
      "$login_super" != "f" || "$login_createdb" != "f" ||
      "$login_createrole" != "f" || "$login_replication" != "f" ||
      "$login_bypassrls" != "f" || "$login_canlogin" != "t" || "$login_can_create_database" != "f" ||
      "$login_can_temp" != "f" || "$login_can_create_public" != "f" ||
      "$membership_count" != "1" || "$membership_matches" != "t" ||
      "$membership_set" != "t" || "$membership_no_inherit" != "t" ||
      "$membership_no_admin" != "t" ]]; then
  echo "restore login/NOLOGIN owner role contract is invalid; refusing to restore" >&2
  exit 1
fi

# Decrypted bytes stay in the pipe. pg_restore explicitly SET ROLEs to the
# dedicated NOLOGIN owner; the restore login never owns restored objects.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$ARCHIVE_FILE" \
  | pg_restore --dbname="$RESTORE_DATABASE_URL" --role="$RESTORE_OWNER_ROLE" --exit-on-error --single-transaction --no-owner --no-acl

printf 'Restored encrypted PostgreSQL backup into the verified empty staging database under NOLOGIN owner role %s.\n' "$RESTORE_OWNER_ROLE"
printf 'Run application integrity checks and reconcile deletion/consent state before exposing the environment.\n'
