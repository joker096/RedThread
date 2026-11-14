import express from 'express';
import {
  createMobileToken,
  hashMobileToken,
  validateMobileDevice
} from './mobileTokens.js';

const ACCESS_TOKEN_SECONDS = 10 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const MOBILE_ORIGINS = new Set([
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
  ...(process.env.MOBILE_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
]);

function readBearer(header, kind) {
  if (typeof header !== 'string' || header.length > 300) return null;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match || !hashMobileToken(match[1], kind)) return null;
  return match[1];
}

export function readMobileAccessToken(header) {
  return readBearer(header, 'access');
}

function normalizeMobileOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return null;
  // Capacitor's iOS WebView uses this custom scheme. URL.origin serializes
  // non-special schemes as "null", so preserve this exact trusted origin.
  if (origin === 'capacitor://localhost') return origin;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'capacitor:' &&
        parsed.hostname === 'localhost' &&
        !parsed.port &&
        (parsed.pathname === '' || parsed.pathname === '/') &&
        !parsed.search && !parsed.hash) {
      return 'capacitor://localhost';
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isAllowedMobileOrigin(origin) {
  const normalized = normalizeMobileOrigin(origin);
  return Boolean(normalized && MOBILE_ORIGINS.has(normalized));
}

export function applyMobileCorsHeaders(origin, res) {
  const normalized = normalizeMobileOrigin(origin);
  if (!normalized || !MOBILE_ORIGINS.has(normalized)) return false;
  res.setHeader('Access-Control-Allow-Origin', normalized);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Vow-Voice-Intro-Consent, X-Vow-Voice-Intro-Consent-Version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function validateMobileOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    const normalized = normalizeMobileOrigin(origin);
    if (!normalized || !MOBILE_ORIGINS.has(normalized)) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    applyMobileCorsHeaders(normalized, res);
  }
  if (req.method === 'OPTIONS') {
    if (!origin) return res.status(403).end();
    return res.status(204).end();
  }
  // Origin-less native requests are accepted only on these dedicated JSON routes.
  // This router never enables credentialed CORS or cookie authentication.
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ error: 'application_json_required' });
  }
  return next();
}

function tokenResponse(user, accessToken, refreshToken, refreshExpiresAt) {
  const now = Date.now();
  return {
    user,
    accessToken,
    accessTokenExpiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt
  };
}

async function createMobileSessionPair(client, userId, device) {
  const accessToken = createMobileToken('access');
  const refreshToken = createMobileToken('refresh');
  const inserted = await client.query(
    `INSERT INTO mobile_sessions
       (user_id, platform, device_id, device_name, access_token_hash, refresh_token_hash,
        access_expires_at, refresh_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             NOW() + ($7::int * INTERVAL '1 second'),
             NOW() + ($8::int * INTERVAL '1 second'))
     RETURNING refresh_expires_at`,
    [userId, device.platform, device.deviceId, device.deviceName,
      hashMobileToken(accessToken, 'access'), hashMobileToken(refreshToken, 'refresh'),
      ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_SECONDS]
  );
  return {
    accessToken,
    refreshToken,
    refreshExpiresAt: new Date(inserted.rows[0].refresh_expires_at).toISOString()
  };
}

export function createMobileAuthRouter({
  pool,
  authLimiter,
  requireDatabase,
  acquireGiftSafetyUserLocks,
  withActiveAccountRead,
  emailVerificationRequired,
  normalizeEmail,
  isValidEmail,
  verifyPassword,
  hashPassword,
  publicUser,
  createAccountReuseDigest,
  isAdultDate,
  hashSessionToken,
  screenProfilePrivate,
  persistScreening,
  createAccountActionToken,
  emailDeliveryConfigured,
  sendConfiguredEmail,
  accountActionUrl
}) {
  const router = express.Router();

  router.use(validateMobileOrigin, requireDatabase);

  router.post('/register', authLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    const birthDate = req.body?.birthDate;
    const gender = req.body?.gender;
    const country = typeof req.body?.country === 'string' ? req.body.country.trim() : '';
    const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
    const relationshipIntent = req.body?.relationshipIntent || 'marriage_family';
    const familyFormat = req.body?.familyFormat || 'open_to_both';
    const hasChildren = req.body?.hasChildren;
    const wantsChildren = req.body?.wantsChildren || 'discuss';
    const childrenLivingArrangement = req.body?.childrenLivingArrangement ||
      (hasChildren === true ? 'prefer_to_discuss' : 'not_applicable');
    const device = validateMobileDevice(req.body);

    if (!isValidEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'password_must_be_12_to_128_characters' });
    }
    if (displayName.length < 2 || displayName.length > 80) {
      return res.status(400).json({ error: 'display_name_must_be_2_to_80_characters' });
    }
    if (!isAdultDate(birthDate)) return res.status(400).json({ error: 'must_be_18_or_older_with_valid_birth_date' });
    if (gender !== 'female' && gender !== 'male') return res.status(400).json({ error: 'invalid_gender' });
    if (!country || country.length > 100 || !city || city.length > 120) {
      return res.status(400).json({ error: 'valid_country_and_city_required' });
    }
    if (!['marriage_family', 'serious_relationship', 'family_without_marriage'].includes(relationshipIntent)) {
      return res.status(400).json({ error: 'invalid_relationship_intent' });
    }
    if (!['marriage', 'cohabitation', 'open_to_both'].includes(familyFormat)) {
      return res.status(400).json({ error: 'invalid_family_format' });
    }
    if (typeof hasChildren !== 'boolean') return res.status(400).json({ error: 'children_status_required' });
    if (!['yes', 'no', 'discuss', 'unsure'].includes(wantsChildren)) {
      return res.status(400).json({ error: 'invalid_wants_children' });
    }
    if (!['with_me', 'shared_custody', 'with_other_parent', 'not_applicable', 'prefer_to_discuss'].includes(childrenLivingArrangement)) {
      return res.status(400).json({ error: 'invalid_children_living_arrangement' });
    }
    if (!device) return res.status(400).json({ error: 'invalid_mobile_device' });

    const accountReuseDigest = createAccountReuseDigest(email, process.env.ACCOUNT_REUSE_HMAC_KEY);
    if (!accountReuseDigest) return res.status(503).json({ error: 'account_reuse_protection_not_configured' });
    if (emailVerificationRequired && !emailDeliveryConfigured()) {
      return res.status(503).json({ error: 'email_delivery_not_configured' });
    }

    let client;
    let verificationToken = null;
    let createdUser = null;
    let mobilePair = null;
    try {
      const passwordHash = await hashPassword(password);
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`account-reuse:${accountReuseDigest}`]);
      await client.query(
        'DELETE FROM account_reuse_restrictions WHERE email_hmac = $1 AND expires_at <= clock_timestamp()',
        [accountReuseDigest]
      );
      const restriction = await client.query(
        `WITH policy_clock AS MATERIALIZED (SELECT clock_timestamp() AS policy_now)
         SELECT restrictions.expires_at,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (restrictions.expires_at - policy_clock.policy_now))))::int AS retry_after_seconds
         FROM account_reuse_restrictions restrictions CROSS JOIN policy_clock
         WHERE restrictions.email_hmac = $1 AND restrictions.expires_at > policy_clock.policy_now`,
        [accountReuseDigest]
      );
      if (restriction.rowCount) {
        const retryAt = new Date(restriction.rows[0].expires_at);
        const retryAfterSeconds = Math.max(1, Number(restriction.rows[0].retry_after_seconds) || 1);
        await client.query('ROLLBACK');
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          error: 'account_recreation_restricted',
          retryAt: retryAt.toISOString(),
          retryAfterSeconds
        });
      }

      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, status, female_trial_ends_at)
         VALUES ($1, $2, $3, CASE WHEN $4 = 'female' THEN NOW() + INTERVAL '24 hours' ELSE NULL END)
         RETURNING id, email`,
        [email, passwordHash, emailVerificationRequired ? 'pending' : 'active', gender]
      );
      createdUser = inserted.rows[0];
      const profile = await client.query(
        `INSERT INTO profiles (
           user_id, display_name, birth_date, gender, country, city, relationship_intent,
           family_format, has_children, children_disclosure_confirmed_at, wants_children, children_living_arrangement
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
         RETURNING user_id AS id, display_name, gender, country, city, relationship_intent`,
        [createdUser.id, displayName, birthDate, gender, country, city, relationshipIntent,
          familyFormat, hasChildren, wantsChildren, childrenLivingArrangement]
      );

      if (emailVerificationRequired) {
        verificationToken = await createAccountActionToken(client, createdUser.id, 'email_verification', 60);
      } else {
        mobilePair = await createMobileSessionPair(client, createdUser.id, device);
      }
      await acquireGiftSafetyUserLocks(client, createdUser.id);
      const screening = await screenProfilePrivate({
        displayName, country, city, bio: '', occupation: '', education: '',
        hasChildren, childrenLivingArrangement
      });
      await persistScreening(createdUser.id, 'profile', screening, client);
      await client.query('COMMIT');

      if (verificationToken) {
        try {
          await sendConfiguredEmail({
            to: createdUser.email,
            subject: 'Verify your Vow account',
            html: '<p>Welcome to Vow.</p><p>Confirm your email address to activate your account:</p><p><a href="' +
              accountActionUrl('verifyEmail', verificationToken) +
              '">Verify email</a></p><p>This link expires in 60 minutes. If you did not create this account, you can ignore this email.</p>'
          });
        } catch (mailError) {
          console.error('Mobile registration verification email failed:', mailError?.message || 'unknown error');
          return res.status(503).json({ error: 'verification_email_delivery_failed', accountCreated: true });
        }
        return res.status(201).json({
          verificationRequired: true,
          message: 'Check your email to activate your account.'
        });
      }

      return res.status(201).json({
        ...tokenResponse(publicUser({ ...profile.rows[0], email: createdUser.email }),
          mobilePair.accessToken, mobilePair.refreshToken, mobilePair.refreshExpiresAt)
      });
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      if (error?.code === '23505') return res.status(409).json({ error: 'email_already_registered' });
      console.error('Mobile registration failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'mobile_registration_failed' });
    } finally {
      client?.release();
    }
  });

  router.post('/verify-email', authLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (token.length < 32 || token.length > 512) return res.status(400).json({ error: 'invalid_or_expired_token' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const tokenHash = hashSessionToken(token);
      const preview = await client.query(
        `SELECT user_id FROM account_action_tokens
         WHERE purpose = 'email_verification' AND token_hash = $1
           AND consumed_at IS NULL AND expires_at > NOW()`,
        [tokenHash]
      );
      const userId = preview.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_or_expired_token' });
      }
      await acquireGiftSafetyUserLocks(client, userId);
      const action = await client.query(
        `SELECT id FROM account_action_tokens
         WHERE purpose = 'email_verification' AND token_hash = $1
           AND user_id = $2 AND consumed_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [tokenHash, userId]
      );
      if (!action.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_or_expired_token' });
      }
      const updated = await client.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()),
           status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
           updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'active') RETURNING id`,
        [userId]
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_or_expired_token' });
      }
      await client.query('UPDATE account_action_tokens SET consumed_at = NOW() WHERE id = $1', [action.rows[0].id]);
      await client.query('COMMIT');
      return res.json({ verified: true, message: 'Email verified. You can now sign in.' });
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch {}
      console.error('Mobile email verification failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'email_verification_failed' });
    } finally {
      client?.release();
    }
  });

  router.post('/email-verification/resend', authLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const generic = { accepted: true, message: 'If the account needs verification, an email will be sent.' };
    if (!isValidEmail(email) || !emailDeliveryConfigured()) return res.status(202).json(generic);
    try {
      const found = await pool.query(
        `SELECT id FROM users
         WHERE email = $1 AND status IN ('pending', 'active')
           AND email_verified_at IS NULL LIMIT 1`,
        [email]
      );
      const user = found.rows[0];
      if (user) {
        let client = await pool.connect();
        let token;
        try {
          await client.query('BEGIN');
          await acquireGiftSafetyUserLocks(client, user.id);
          const current = await client.query(
            `SELECT id, email FROM users
             WHERE id = $1 AND email = $2 AND status IN ('pending', 'active')
               AND email_verified_at IS NULL FOR SHARE`,
            [user.id, email]
          );
          if (current.rows[0]) {
            await client.query(
              `UPDATE account_action_tokens SET consumed_at = NOW()
               WHERE user_id = $1 AND purpose = 'email_verification' AND consumed_at IS NULL`,
              [user.id]
            );
            token = await createAccountActionToken(client, user.id, 'email_verification', 60);
          }
          await client.query('COMMIT');
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch {}
          throw error;
        } finally {
          client.release();
        }
        if (token) {
          await sendConfiguredEmail({
            to: email,
            subject: 'Verify your Vow account',
            html: '<p>Confirm your email address:</p><p><a href="' +
              accountActionUrl('verifyEmail', token) +
              '">Verify email</a></p><p>This link expires in 60 minutes.</p>'
          });
        }
      }
    } catch (error) {
      console.error('Mobile email verification resend failed:', error?.message || 'unknown error');
    }
    return res.status(202).json(generic);
  });

  router.post('/password-reset/request', authLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const generic = { accepted: true, message: 'If an eligible account exists, password reset instructions will be sent.' };
    if (!isValidEmail(email) || !emailDeliveryConfigured()) return res.status(202).json(generic);
    try {
      const found = await pool.query(
        "SELECT id FROM users WHERE email = $1 AND status = 'active' AND email_verified_at IS NOT NULL LIMIT 1",
        [email]
      );
      const user = found.rows[0];
      if (user) {
        let client = await pool.connect();
        let token;
        try {
          await client.query('BEGIN');
          await acquireGiftSafetyUserLocks(client, user.id);
          const current = await client.query(
            "SELECT id, email FROM users WHERE id = $1 AND email = $2 AND status = 'active' AND email_verified_at IS NOT NULL FOR SHARE",
            [user.id, email]
          );
          if (current.rows[0]) {
            await client.query(
              "UPDATE account_action_tokens SET consumed_at = NOW() WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL",
              [user.id]
            );
            token = await createAccountActionToken(client, user.id, 'password_reset', 30);
          }
          await client.query('COMMIT');
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch {}
          throw error;
        } finally {
          client.release();
        }
        if (token) {
          await sendConfiguredEmail({
            to: email,
            subject: 'Reset your Vow password',
            html: '<p>Use this link to choose a new password:</p><p><a href="' +
              accountActionUrl('resetPassword', token) +
              '">Reset password</a></p><p>This link expires in 30 minutes.</p>'
          });
        }
      }
    } catch (error) {
      console.error('Mobile password reset request failed:', error?.message || 'unknown error');
    }
    return res.status(202).json(generic);
  });

  router.post('/password-reset/complete', authLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'password_must_be_12_to_128_characters' });
    }
    if (token.length < 32 || token.length > 512) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }
    let client;
    try {
      const passwordHash = await hashPassword(password);
      client = await pool.connect();
      await client.query('BEGIN');
      const tokenHash = hashSessionToken(token);
      const preview = await client.query(
        `SELECT t.user_id FROM account_action_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.purpose = 'password_reset' AND t.token_hash = $1
           AND t.consumed_at IS NULL AND t.expires_at > NOW()
           AND u.status = 'active' AND u.email_verified_at IS NOT NULL`,
        [tokenHash]
      );
      const userId = preview.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_or_expired_token' });
      }
      await acquireGiftSafetyUserLocks(client, userId);
      const action = await client.query(
        `SELECT t.id FROM account_action_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.purpose = 'password_reset' AND t.token_hash = $1
           AND t.user_id = $2 AND t.consumed_at IS NULL AND t.expires_at > NOW()
           AND u.status = 'active' AND u.email_verified_at IS NOT NULL
         FOR UPDATE OF t`,
        [tokenHash, userId]
      );
      if (!action.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_or_expired_token' });
      }
      const updated = await client.query(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND status = 'active' AND email_verified_at IS NOT NULL RETURNING id",
        [passwordHash, userId]
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_or_expired_token' });
      }
      await client.query('UPDATE account_action_tokens SET consumed_at = NOW() WHERE id = $1', [action.rows[0].id]);
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await client.query(
        `UPDATE mobile_sessions SET revoked_at = NOW(), revoked_reason = 'password_reset'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await client.query('COMMIT');
      return res.json({ reset: true, message: 'Password changed. Sign in with your new password.' });
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch {}
      console.error('Mobile password reset completion failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'password_reset_failed' });
    } finally {
      client?.release();
    }
  });

  router.post('/login', authLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const device = validateMobileDevice(req.body);
    if (!isValidEmail(email) || typeof password !== 'string' ||
        password.length < 1 || password.length > 128 || !device) {
      return res.status(400).json({ error: 'invalid_login_request' });
    }

    let client;
    try {
      const found = await pool.query(
        `SELECT u.id, u.email, u.password_hash, u.status, u.email_verified_at,
                p.display_name, p.gender, p.country, p.city, p.relationship_intent
         FROM users u JOIN profiles p ON p.user_id = u.id
         WHERE u.email = $1 LIMIT 1`,
        [email]
      );
      const user = found.rows[0];
      const passwordMatches = user
        ? await verifyPassword(password, user.password_hash)
        : await hashPassword(password).then(() => false);
      if (!user || !passwordMatches) {
        return res.status(401).json({ error: 'email_or_password_incorrect' });
      }
      if (user.status !== 'active') {
        return res.status(403).json({ error: user.status === 'pending' ? 'email_verification_required' : 'account_unavailable' });
      }
      if (emailVerificationRequired && !user.email_verified_at) {
        return res.status(403).json({ error: 'email_verification_required' });
      }

      client = await pool.connect();
      await client.query('BEGIN');
      await acquireGiftSafetyUserLocks(client, user.id);
      const current = await client.query(
        'SELECT status, email_verified_at, password_hash FROM users WHERE id = $1 FOR SHARE',
        [user.id]
      );
      if (current.rows[0]?.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'account_unavailable' });
      }
      if (current.rows[0].password_hash !== user.password_hash &&
          !await verifyPassword(password, current.rows[0].password_hash)) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'email_or_password_incorrect' });
      }
      if (emailVerificationRequired && !current.rows[0].email_verified_at) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'email_verification_required' });
      }

      await client.query(
        `UPDATE mobile_sessions
         SET revoked_at = NOW(), revoked_reason = 'logout'
         WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [user.id, device.deviceId]
      );
      const activeCount = await client.query(
        'SELECT COUNT(*)::int AS count FROM mobile_sessions WHERE user_id = $1 AND revoked_at IS NULL AND refresh_expires_at > NOW()',
        [user.id]
      );
      if (activeCount.rows[0].count >= 10) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'mobile_device_limit_reached' });
      }

      const accessToken = createMobileToken('access');
      const refreshToken = createMobileToken('refresh');
      const accessHash = hashMobileToken(accessToken, 'access');
      const refreshHash = hashMobileToken(refreshToken, 'refresh');
      const inserted = await client.query(
        `INSERT INTO mobile_sessions
           (user_id, platform, device_id, device_name, access_token_hash, refresh_token_hash,
            access_expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6,
                 NOW() + ($7::int * INTERVAL '1 second'),
                 NOW() + ($8::int * INTERVAL '1 second'))
         RETURNING refresh_expires_at`,
        [user.id, device.platform, device.deviceId, device.deviceName,
          accessHash, refreshHash, ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_SECONDS]
      );
      await client.query('COMMIT');
      return res.status(200).json(tokenResponse(
        publicUser(user), accessToken, refreshToken,
        new Date(inserted.rows[0].refresh_expires_at).toISOString()
      ));
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch {}
      console.error('Mobile login failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'mobile_login_failed' });
    } finally {
      client?.release();
    }
  });

  router.post('/refresh', authLimiter, async (req, res) => {
    const refreshToken = readBearer(req.get('authorization'), 'refresh');
    const device = validateMobileDevice(req.body);
    if (!refreshToken || !device) return res.status(400).json({ error: 'invalid_refresh_request' });
    const oldHash = hashMobileToken(refreshToken, 'refresh');
    let client;
    try {
      const owner = await pool.query(
        `SELECT user_id FROM mobile_sessions WHERE refresh_token_hash = $1
         UNION
         SELECT s.user_id FROM mobile_refresh_token_history h
         JOIN mobile_sessions s ON s.id = h.session_id
         WHERE h.token_hash = $1
         LIMIT 1`,
        [oldHash]
      );
      if (!owner.rowCount) return res.status(401).json({ error: 'invalid_refresh_token' });
      const userId = owner.rows[0].user_id;

      client = await pool.connect();
      await client.query('BEGIN');
      await acquireGiftSafetyUserLocks(client, userId);

      const current = await client.query(
        `SELECT s.id AS session_id, s.user_id, s.device_id, s.platform, s.refresh_expires_at,
                s.revoked_at, u.id, u.status, u.email_verified_at,
                p.display_name, u.email, p.gender, p.country, p.city, p.relationship_intent
         FROM mobile_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN profiles p ON p.user_id = u.id
         WHERE s.refresh_token_hash = $1 AND s.user_id = $2
         FOR UPDATE OF s, u`,
        [oldHash, userId]
      );

      if (!current.rowCount) {
        const replay = await client.query(
          `SELECT 1 FROM mobile_refresh_token_history h
           JOIN mobile_sessions s ON s.id = h.session_id
           WHERE h.token_hash = $1 AND s.user_id = $2 LIMIT 1`,
          [oldHash, userId]
        );
        if (replay.rowCount) {
          await client.query(
            `UPDATE mobile_sessions
             SET revoked_at = COALESCE(revoked_at, NOW()),
                 revoked_reason = CASE WHEN revoked_at IS NULL THEN 'refresh_reuse' ELSE revoked_reason END
             WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId]
          );
          await client.query('COMMIT');
          return res.status(401).json({ error: 'refresh_token_reuse_detected' });
        }
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'invalid_refresh_token' });
      }

      const session = current.rows[0];
      if (session.revoked_at || new Date(session.refresh_expires_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'invalid_refresh_token' });
      }
      if (session.device_id !== device.deviceId || session.platform !== device.platform) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'mobile_device_mismatch' });
      }
      if (session.status !== 'active') {
        await client.query(
          `UPDATE mobile_sessions SET revoked_at = NOW(), revoked_reason = 'account_unavailable'
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId]
        );
        await client.query('COMMIT');
        return res.status(401).json({ error: 'account_unavailable' });
      }
      if (emailVerificationRequired && !session.email_verified_at) {
        await client.query(
          `UPDATE mobile_sessions SET revoked_at = NOW(), revoked_reason = 'account_unavailable'
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId]
        );
        await client.query('COMMIT');
        return res.status(403).json({ error: 'email_verification_required' });
      }

      const accessToken = createMobileToken('access');
      const nextRefreshToken = createMobileToken('refresh');
      const nextAccessHash = hashMobileToken(accessToken, 'access');
      const nextRefreshHash = hashMobileToken(nextRefreshToken, 'refresh');
      await client.query(
        'INSERT INTO mobile_refresh_token_history (session_id, token_hash) VALUES ($1, $2)',
        [session.session_id, oldHash]
      );
      const updated = await client.query(
        `UPDATE mobile_sessions
         SET access_token_hash = $2,
             refresh_token_hash = $3,
             access_expires_at = LEAST(NOW() + ($4::int * INTERVAL '1 second'), refresh_expires_at),
             rotated_at = NOW(),
             last_seen_at = NOW()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING refresh_expires_at`,
        [session.session_id, nextAccessHash, nextRefreshHash, ACCESS_TOKEN_SECONDS]
      );
      if (updated.rowCount !== 1) throw new Error('mobile_session_rotation_lost');
      await client.query('COMMIT');
      return res.json(tokenResponse(
        publicUser(session), accessToken, nextRefreshToken,
        new Date(updated.rows[0].refresh_expires_at).toISOString()
      ));
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch {}
      console.error('Mobile refresh failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'mobile_refresh_failed' });
    } finally {
      client?.release();
    }
  });

  async function requireMobileAccess(req, res, next) {
    const token = readBearer(req.get('authorization'), 'access');
    if (!token) return res.status(401).json({ error: 'not_authenticated' });
    try {
      const tokenHash = hashMobileToken(token, 'access');
      const lookup = await pool.query(
        'SELECT user_id FROM mobile_sessions WHERE access_token_hash = $1 AND access_expires_at > NOW() AND revoked_at IS NULL LIMIT 1',
        [tokenHash]
      );
      if (!lookup.rowCount) return res.status(401).json({ error: 'not_authenticated' });
      const read = await withActiveAccountRead(lookup.rows[0].user_id, async client => {
        const result = await client.query(
          `SELECT s.id AS session_id, s.device_id, s.platform, u.id, u.email, u.status,
                  u.email_verified_at, p.display_name, p.gender, p.country, p.city, p.relationship_intent
           FROM mobile_sessions s
           JOIN users u ON u.id = s.user_id
           JOIN profiles p ON p.user_id = u.id
           WHERE s.access_token_hash = $1 AND s.user_id = $2
             AND s.access_expires_at > NOW() AND s.revoked_at IS NULL
           LIMIT 1`,
          [tokenHash, lookup.rows[0].user_id]
        );
        const user = result.rows[0] || null;
        if (user) await client.query('UPDATE mobile_sessions SET last_seen_at = NOW() WHERE id = $1', [user.session_id]);
        return user;
      });
      if (!read.active || !read.value) return res.status(401).json({ error: 'not_authenticated' });
      if (emailVerificationRequired && !read.value.email_verified_at) {
        return res.status(403).json({ error: 'email_verification_required' });
      }
      req.mobileSession = { id: read.value.session_id, deviceId: read.value.device_id, platform: read.value.platform };
      req.authUser = read.value;
      return next();
    } catch (error) {
      console.error('Mobile access authentication failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'authentication_failed' });
    }
  }

  router.get('/me', requireMobileAccess, (req, res) => {
    return res.json({ user: publicUser(req.authUser) });
  });

  router.post('/logout', requireMobileAccess, async (req, res) => {
    try {
      await pool.query(
        `UPDATE mobile_sessions SET revoked_at = NOW(), revoked_reason = 'logout'
         WHERE id = $1 AND revoked_at IS NULL`,
        [req.mobileSession.id]
      );
      return res.status(204).end();
    } catch (error) {
      console.error('Mobile logout failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'mobile_logout_failed' });
    }
  });

  router.post('/logout-all', requireMobileAccess, async (req, res) => {
    try {
      await pool.query(
        `UPDATE mobile_sessions SET revoked_at = NOW(), revoked_reason = 'logout'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [req.authUser.id]
      );
      return res.status(204).end();
    } catch (error) {
      console.error('Mobile logout-all failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'mobile_logout_failed' });
    }
  });

  return router;
}
