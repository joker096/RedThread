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

function validateMobileOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let normalized;
    try { normalized = new URL(origin).origin; } catch {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    if (!MOBILE_ORIGINS.has(normalized)) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
  }
  // Origin-less native requests are accepted only on these dedicated JSON routes.
  // No CORS allow-origin header is emitted; browser cookie routes remain unchanged.
  if (!req.is('application/json')) {
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
  publicUser
}) {
  const router = express.Router();

  router.use(validateMobileOrigin, requireDatabase);

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
        `SELECT s.id, s.user_id, s.device_id, s.platform, s.refresh_expires_at,
                s.revoked_at, u.status, u.email_verified_at,
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
        [session.id, oldHash]
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
        [session.id, nextAccessHash, nextRefreshHash, ACCESS_TOKEN_SECONDS]
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
