import 'dotenv/config';
import express from 'express';
import { screenProfilePrivate, screenTextPrivate } from './privacyScreening.js';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import { isValidAssessment, financialAlignment, ASSESSMENT_VERSION } from './relationshipAssessment.js';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  isAdultDate,
  isValidEmail,
  normalizeEmail,
  verifyPassword
} from './security.js';

const { Pool } = pg;
const app = express();
const port = Number.parseInt(process.env.API_PORT || '3001', 10);
const databaseUrl = process.env.DATABASE_URL;
const sessionDurationSeconds = 60 * 60 * 24 * 30;
const sessionCookieName = 'nit_session';
const emailVerificationRequired = process.env.EMAIL_VERIFICATION_REQUIRED === 'true' || (process.env.NODE_ENV === 'production' && process.env.EMAIL_VERIFICATION_REQUIRED !== 'false');
const allowedOrigin = process.env.APP_ORIGIN || 'http://localhost:3000';

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
    })
  : null;

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '32kb', strict: true }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_auth_attempts' }
});
const profileActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_profile_actions' }
});
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_reports' }
});

function emailDeliveryConfigured() {
  const configuredUrl = process.env.APP_URL || process.env.APP_ORIGIN;
  let validPublicUrl = false;
  try {
    const parsed = new URL(configuredUrl);
    validPublicUrl = process.env.NODE_ENV === 'production'
      ? parsed.protocol === 'https:' && !['localhost', '127.0.0.1', 'example.com'].includes(parsed.hostname)
      : ['http:', 'https:'].includes(parsed.protocol);
  } catch { validPublicUrl = false; }
  return process.env.EMAIL_PROVIDER === 'resend' &&
    Boolean(process.env.RESEND_API_KEY) &&
    Boolean(process.env.EMAIL_FROM) &&
    validPublicUrl;
}

async function sendConfiguredEmail({ to, subject, html }) {
  if (!emailDeliveryConfigured()) throw new Error('email_delivery_not_configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html })
  });
  if (!response.ok) {
    const status = response.status;
    throw new Error('email_provider_rejected_request_' + status);
  }
}

async function createAccountActionToken(client, userId, purpose, lifetimeMinutes) {
  const token = createSessionToken();
  await client.query(
    `INSERT INTO account_action_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 minute'))`,
    [userId, purpose, hashSessionToken(token), lifetimeMinutes]
  );
  return token;
}

function accountActionUrl(parameter, token) {
  const base = (process.env.APP_URL || process.env.APP_ORIGIN).replace(/\\/$/, '');
  return base + '/?'+ parameter + '=' + encodeURIComponent(token);
}

function requireDatabase(_req, res, next) {
  if (!pool) {
    return res.status(503).json({ error: 'database_not_configured' });
  }
  next();
}

function validateRequestOrigin(req, res, next) {
  const origin = req.get('origin');
  // All browser-originated state changes must carry an explicit, trusted Origin.
  // This deliberately rejects origin-less cookie-authenticated mutations.
  if (!origin) return res.status(403).json({ error: 'origin_required' });

  try {
    if (new URL(origin).origin !== new URL(allowedOrigin).origin) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
  } catch {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }
  return next();
}

function readSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const prefix = `${sessionCookieName}=`;
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : null;
}

function writeSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationSeconds}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    gender: row.gender,
    country: row.country,
    city: row.city,
    relationshipIntent: row.relationship_intent
  };
}

async function requireSession(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'database_not_configured' });
  const token = readSessionToken(req);
  if (!token) return res.status(401).json({ error: 'not_authenticated' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.status, u.role, u.email_verified_at, u.female_trial_ends_at, u.premium_until, u.phone_verified_at,
              p.display_name, p.gender, p.country, p.city, p.relationship_intent, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN profiles p ON p.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [hashSessionToken(token)]
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'not_authenticated' });
    }
    if (emailVerificationRequired && !user.email_verified_at) {
      return res.status(403).json({ error: 'email_verification_required' });
    }
    req.authUser = user;
    await pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [user.session_id]);
    return next();
  } catch (error) {
    console.error('Authentication middleware failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'authentication_failed' });
  }
}

async function persistScreening(userId, scope, result) {
  // Persist only the minimal classification metadata. Do not persist source text or text-derived hashes.
  await pool.query('INSERT INTO user_safety_screenings (user_id, scope, flags, severity, review_status) VALUES ($1, $2, $3::jsonb, $4, $5)', [userId, scope, JSON.stringify(result.flags), result.severity, result.requiresReview ? 'pending' : 'not_required']);
}

function requirePaidFeatures(req, res, next) {
  // Men retain the current free access model. Safety, account settings, and reports are never paywalled.
  if (req.authUser.gender !== 'female') return next();
  const trialEndsAt = req.authUser.female_trial_ends_at ? new Date(req.authUser.female_trial_ends_at).getTime() : 0;
  const premiumUntil = req.authUser.premium_until ? new Date(req.authUser.premium_until).getTime() : 0;
  const now = Date.now();
  if (trialEndsAt > now || premiumUntil > now) return next();
  return res.status(402).json({
    error: 'premium_required',
    message: 'Бесплатный период завершён. Для продолжения использования функций подбора нужен Premium.',
    paymentConfigured: false
  });
}

async function createSession(client, userId) {
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  await client.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\')',
    [userId, tokenHash]
  );
  return token;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'nit-api' });
});

app.get('/api/ready', async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_not_configured' });
  }

  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ready', database: 'connected' });
  } catch {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }
});

app.post('/api/auth/register', authLimiter, validateRequestOrigin, requireDatabase, async (req, res) => {
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
  const childrenLivingArrangement = req.body?.childrenLivingArrangement || (hasChildren === true ? 'prefer_to_discuss' : 'not_applicable');

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
  if (!['marriage', 'cohabitation', 'open_to_both'].includes(familyFormat)) return res.status(400).json({ error: 'invalid_family_format' });
  if (typeof hasChildren !== 'boolean') return res.status(400).json({ error: 'children_status_required' });
  if (!['yes', 'no', 'discuss', 'unsure'].includes(wantsChildren)) return res.status(400).json({ error: 'invalid_wants_children' });
  if (!['with_me', 'shared_custody', 'with_other_parent', 'not_applicable', 'prefer_to_discuss'].includes(childrenLivingArrangement)) return res.status(400).json({ error: 'invalid_children_living_arrangement' });

  let client;
  try {
    const passwordHash = await hashPassword(password);
    client = await pool.connect();
    await client.query('BEGIN');
    if (emailVerificationRequired && !emailDeliveryConfigured()) {
      await client.query('ROLLBACK');
      return res.status(503).json({ error: 'email_delivery_not_configured' });
    }
    const userResult = await client.query(
      'INSERT INTO users (email, password_hash, status, female_trial_ends_at) VALUES ($1, $2, $3, CASE WHEN $4 = \'female\' THEN NOW() + INTERVAL \'24 hours\' ELSE NULL END) RETURNING id, email',
      [email, passwordHash, emailVerificationRequired ? 'pending' : 'active', gender]
    );
    const user = userResult.rows[0];
    const profileResult = await client.query(
      `INSERT INTO profiles (
         user_id, display_name, birth_date, gender, country, city, relationship_intent,
         family_format, has_children, children_disclosure_confirmed_at, wants_children, children_living_arrangement
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, $11)
       RETURNING user_id AS id, display_name, gender, country, city, relationship_intent`,
      [user.id, displayName, birthDate, gender, country, city, relationshipIntent, familyFormat, hasChildren, wantsChildren, childrenLivingArrangement]
    );
    const verificationToken = emailVerificationRequired
      ? await createAccountActionToken(client, user.id, 'email_verification', 60)
      : null;
    const token = emailVerificationRequired ? null : await createSession(client, user.id);
    await client.query('COMMIT');

    if (verificationToken) {
      try {
        const link = accountActionUrl('verifyEmail', verificationToken);
        await sendConfiguredEmail({
          to: user.email,
          subject: 'Verify your NIT account',
          html: '<p>Welcome to NIT.</p><p>Confirm your email address to activate your account:</p><p><a href="' + link + '">Verify email</a></p><p>This link expires in 60 minutes. If you did not create this account, you can ignore this message.</p>'
        });
      } catch (mailError) {
        console.error('Verification email delivery failed:', mailError?.message || 'unknown error');
        return res.status(503).json({ error: 'verification_email_delivery_failed', accountCreated: true });
      }
    }

    // Screen after commit so the separate screening insert can see the new user row.
    try {
      const registrationScreening = await screenProfilePrivate({
        displayName, country, city, bio: '', occupation: '', education: '',
        hasChildren, childrenLivingArrangement
      });
      await persistScreening(user.id, 'profile', registrationScreening);
    } catch (screeningError) {
      console.error('Registration screening failed:', screeningError?.message || 'unknown error');
    }

    if (emailVerificationRequired) {
      return res.status(201).json({ verificationRequired: true, message: 'Check your email to activate your account.' });
    }
    writeSessionCookie(res, token);
    return res.status(201).json({ user: publicUser({ ...profileResult.rows[0], email: user.email }) });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505') return res.status(409).json({ error: 'email_already_registered' });
    console.error('Registration failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'registration_failed' });
  } finally {
    client?.release();
  }
});

app.post('/api/auth/verify-email', authLimiter, validateRequestOrigin, requireDatabase, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (token.length < 32 || token.length > 512) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, user_id FROM account_action_tokens
       WHERE purpose = 'email_verification' AND token_hash = $1
         AND consumed_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashSessionToken(token)]
    );
    const action = result.rows[0];
    if (!action) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()),
         status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
         updated_at = NOW() WHERE id = $1`,
      [action.user_id]
    );
    await client.query('UPDATE account_action_tokens SET consumed_at = NOW() WHERE id = $1', [action.id]);
    await client.query('COMMIT');
    return res.json({ verified: true, message: 'Email verified. You can now sign in.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Email verification failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'email_verification_failed' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/email-verification/resend', authLimiter, validateRequestOrigin, requireDatabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  // Keep the response generic so the endpoint does not disclose registered addresses.
  const generic = { accepted: true, message: 'If the account needs verification, an email will be sent.' };
  if (!isValidEmail(email) || !emailDeliveryConfigured()) return res.status(202).json(generic);
  try {
    const userResult = await pool.query(
      `SELECT id, email FROM users
       WHERE email = $1 AND status IN ('pending', 'active') AND email_verified_at IS NULL LIMIT 1`,
      [email]
    );
    const user = userResult.rows[0];
    if (user) {
      const client = await pool.connect();
      let token;
      try {
        await client.query('BEGIN');
        await client.query("UPDATE account_action_tokens SET consumed_at = NOW() WHERE user_id = $1 AND purpose = 'email_verification' AND consumed_at IS NULL", [user.id]);
        token = await createAccountActionToken(client, user.id, 'email_verification', 60);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
      await sendConfiguredEmail({
        to: user.email,
        subject: 'Verify your NIT account',
        html: '<p>Confirm your email address:</p><p><a href="' + accountActionUrl('verifyEmail', token) + '">Verify email</a></p><p>This link expires in 60 minutes.</p>'
      });
    }
  } catch (error) {
    console.error('Verification resend failed:', error?.message || 'unknown error');
  }
  return res.status(202).json(generic);
});

app.post('/api/auth/password-reset/request', authLimiter, validateRequestOrigin, requireDatabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const generic = { accepted: true, message: 'If an eligible account exists, password reset instructions will be sent.' };
  if (!isValidEmail(email) || !emailDeliveryConfigured()) return res.status(202).json(generic);
  try {
    const result = await pool.query(
      "SELECT id, email FROM users WHERE email = $1 AND status = 'active' LIMIT 1",
      [email]
    );
    const user = result.rows[0];
    if (user) {
      const client = await pool.connect();
      let token;
      try {
        await client.query('BEGIN');
        await client.query("UPDATE account_action_tokens SET consumed_at = NOW() WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL", [user.id]);
        token = await createAccountActionToken(client, user.id, 'password_reset', 30);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
      await sendConfiguredEmail({
        to: user.email,
        subject: 'Reset your NIT password',
        html: '<p>Use this link to choose a new password:</p><p><a href="' + accountActionUrl('resetPassword', token) + '">Reset password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>'
      });
    }
  } catch (error) {
    console.error('Password reset request failed:', error?.message || 'unknown error');
  }
  return res.status(202).json(generic);
});

app.post('/api/auth/password-reset/complete', authLimiter, validateRequestOrigin, requireDatabase, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'password_must_be_12_to_128_characters' });
  }
  if (token.length < 32 || token.length > 512) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, user_id FROM account_action_tokens
       WHERE purpose = 'password_reset' AND token_hash = $1
         AND consumed_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashSessionToken(token)]
    );
    const action = result.rows[0];
    if (!action) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }
    await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, action.user_id]);
    await client.query('UPDATE account_action_tokens SET consumed_at = NOW() WHERE id = $1', [action.id]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [action.user_id]);
    await client.query('COMMIT');
    clearSessionCookie(res);
    return res.json({ reset: true, message: 'Password changed. Sign in with your new password.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Password reset completion failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'password_reset_failed' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', authLimiter, validateRequestOrigin, requireDatabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!isValidEmail(email) || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'invalid_credentials_format' });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.status, u.email_verified_at, p.display_name, p.gender, p.country, p.city, p.relationship_intent
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.email = $1 LIMIT 1`,
      [email]
    );
    const user = result.rows[0];
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

    const client = await pool.connect();
    let token;
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sessions WHERE expires_at < NOW()');
      token = await createSession(client, user.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    writeSessionCookie(res, token);
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('Login failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'login_failed' });
  }
});

app.get('/api/auth/me', requireDatabase, async (req, res) => {
  const token = readSessionToken(req);
  if (!token) return res.status(401).json({ error: 'not_authenticated' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.status, u.role, u.email_verified_at, u.female_trial_ends_at, u.premium_until, u.phone_verified_at,
              p.display_name, p.gender, p.country, p.city, p.relationship_intent, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN profiles p ON p.user_id = u.id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [hashSessionToken(token)]
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'not_authenticated' });
    }
    if (emailVerificationRequired && !user.email_verified_at) {
      return res.status(403).json({ error: 'email_verification_required' });
    }

    await pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [user.session_id]);
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('Session lookup failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'session_lookup_failed' });
  }
});

app.post('/api/auth/logout', validateRequestOrigin, requireDatabase, async (req, res) => {
  const token = readSessionToken(req);
  if (token) {
    try {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
    } catch (error) {
      console.error('Logout failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'logout_failed' });
    }
  }
  clearSessionCookie(res);
  return res.status(204).end();
});

app.delete('/api/account', validateRequestOrigin, requireSession, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) {
    return res.status(400).json({ error: 'password_confirmation_required' });
  }

  let client;
  try {
    const account = await pool.query("SELECT password_hash FROM users WHERE id = $1 AND status = 'active'", [req.authUser.id]);
    if (!account.rows[0] || typeof account.rows[0].password_hash !== 'string' || !(await verifyPassword(password, account.rows[0].password_hash))) {
      return res.status(401).json({ error: 'password_confirmation_failed' });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM sessions WHERE user_id = $1', [req.authUser.id]);
    await client.query('DELETE FROM relationship_assessments WHERE user_id = $1', [req.authUser.id]);
    await client.query('DELETE FROM likes WHERE sender_id = $1 OR target_id = $1', [req.authUser.id]);
    await client.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [req.authUser.id]);
    await client.query(
      "UPDATE messages SET body = '[сообщение удалено]', deleted_at = COALESCE(deleted_at, NOW()) WHERE sender_id = $1",
      [req.authUser.id]
    );
    await client.query(
      `UPDATE profiles SET
         display_name = 'Удалённый пользователь', country = '—', city = '—', bio = '',
         photo_urls = '{}', occupation = '', education = '', languages = '{}',
         is_visible = FALSE, has_children = NULL, children_disclosure_confirmed_at = NULL,
         family_format = 'open_to_both', wants_children = 'discuss',
         children_living_arrangement = 'not_applicable', updated_at = NOW()
       WHERE user_id = $1`,
      [req.authUser.id]
    );
    await client.query(
      `UPDATE users SET status = 'deleted', email = $2, password_hash = NULL,
         phone_e164 = NULL, phone_verified_at = NULL, female_trial_ends_at = NULL,
         premium_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [req.authUser.id, 'deleted+' + req.authUser.id + '@deleted.invalid']
    );
    await client.query(
      "UPDATE matches SET status = 'closed' WHERE user_a_id = $1 OR user_b_id = $1",
      [req.authUser.id]
    );
    await client.query('COMMIT');
    clearSessionCookie(res);
    return res.status(204).end();
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Account deletion failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'account_deletion_failed' });
  } finally {
    client?.release();
  }
});

app.get('/api/billing/status', requireSession, async (req, res) => {
  const trialEndsAt = req.authUser.female_trial_ends_at ? new Date(req.authUser.female_trial_ends_at) : null;
  const premiumUntil = req.authUser.premium_until ? new Date(req.authUser.premium_until) : null;
  const now = Date.now();
  const isTrialActive = req.authUser.gender === 'female' && trialEndsAt && trialEndsAt.getTime() > now;
  const hasPremium = premiumUntil && premiumUntil.getTime() > now;
  return res.json({
    gender: req.authUser.gender,
    trialEndsAt: trialEndsAt?.toISOString() || null,
    premiumUntil: premiumUntil?.toISOString() || null,
    access: req.authUser.gender !== 'female' || isTrialActive || hasPremium ? 'full' : 'premium_required',
    trialActive: Boolean(isTrialActive),
    premiumActive: Boolean(hasPremium),
    paymentConfigured: false,
    note: 'После окончания пробного периода доступ к платным функциям ограничивается. Автоматического списания без подключённого и подтверждённого платежного соглашения нет.'
  });
});

app.get('/api/profiles/search', requireSession, requirePaidFeatures, async (req, res) => {
  const cleanFilter = (value, maxLength) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLocaleLowerCase() === 'all') return null;
    return trimmed.slice(0, maxLength);
  };

  const country = cleanFilter(req.query.country, 100);
  const city = cleanFilter(req.query.city, 120);
  const intent = cleanFilter(req.query.intent, 40);
  const familyFormat = cleanFilter(req.query.familyFormat, 40);
  const childrenFilter = cleanFilter(req.query.hasChildren, 10);
  const parseAge = value => value === undefined || value === '' ? null : Number.parseInt(String(value), 10);
  const minAge = parseAge(req.query.minAge);
  const maxAge = parseAge(req.query.maxAge);
  const minFinancialAlignment = req.query.minFinancialAlignment === undefined ? 0 : Number.parseInt(String(req.query.minFinancialAlignment), 10);
  if ((minAge !== null && (!Number.isInteger(minAge) || minAge < 18 || minAge > 120)) || (maxAge !== null && (!Number.isInteger(maxAge) || maxAge < 18 || maxAge > 120)) || (minAge !== null && maxAge !== null && minAge > maxAge) || !Number.isInteger(minFinancialAlignment) || minFinancialAlignment < 0 || minFinancialAlignment > 100) return res.status(400).json({ error: 'invalid_age_or_financial_alignment_filter' });
  if (intent && !['marriage_family', 'serious_relationship', 'family_without_marriage'].includes(intent)) {
    return res.status(400).json({ error: 'invalid_relationship_intent' });
  }

  if (familyFormat && !['marriage', 'cohabitation', 'open_to_both'].includes(familyFormat)) return res.status(400).json({ error: 'invalid_family_format' });
  if (childrenFilter !== null && !['true', 'false'].includes(childrenFilter)) return res.status(400).json({ error: 'invalid_children_filter' });

  const parsedLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
  const parsedOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50 ||
      !Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 5000) {
    return res.status(400).json({ error: 'invalid_pagination' });
  }

  try {
    const result = await pool.query(
      `SELECT
         p.user_id AS id,
         p.display_name AS "displayName",
         EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.birth_date))::int AS age,
         p.gender,
         p.country,
         p.city,
         p.bio,
         p.photo_urls AS "photoUrls",
         p.occupation,
         p.education,
         p.languages,
         p.relationship_intent AS "relationshipIntent",
         p.family_format AS "familyFormat",
         p.has_children AS "hasChildren",
         p.wants_children AS "wantsChildren",
         p.children_living_arrangement AS "childrenLivingArrangement",
         candidate_assessment.answers AS assessment_answers,
         my_assessment.answers AS my_assessment_answers
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       JOIN profiles me ON me.user_id = $1
       LEFT JOIN relationship_assessments candidate_assessment ON candidate_assessment.user_id = p.user_id
       LEFT JOIN relationship_assessments my_assessment ON my_assessment.user_id = me.user_id
       WHERE p.user_id <> $1
         AND p.gender <> me.gender
         AND p.is_visible = TRUE
         AND p.children_disclosure_confirmed_at IS NOT NULL
         AND p.has_children IS NOT NULL
         AND p.birth_date IS NOT NULL
         AND u.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id)
              OR (b.blocker_id = p.user_id AND b.blocked_id = $1)
         )
         AND NOT EXISTS (
           SELECT 1 FROM profile_passes skipped
           WHERE skipped.passer_id = $1 AND skipped.passed_user_id = p.user_id
         )
         AND ($2::text IS NULL OR p.country ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR p.city ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR p.relationship_intent = $4)
         AND ($10::text IS NULL OR p.family_format = $10 OR p.family_format = 'open_to_both')
         AND ($11::boolean IS NULL OR p.has_children = $11)
         AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.birth_date))::int BETWEEN COALESCE($7::int, 18) AND COALESCE($8::int, 120)
         AND ($9::int = 0 OR (candidate_assessment.answers IS NOT NULL AND my_assessment.answers IS NOT NULL AND (CASE WHEN candidate_assessment.answers->>'financialModel' = my_assessment.answers->>'financialModel' THEN 1 ELSE 0 END + CASE WHEN candidate_assessment.answers->>'lifestyleExpectation' = my_assessment.answers->>'lifestyleExpectation' THEN 1 ELSE 0 END + CASE WHEN candidate_assessment.answers->>'gifts' = my_assessment.answers->>'gifts' THEN 1 ELSE 0 END) * 100.0 / 3 >= ($9 - 0.5)))
       ORDER BY p.updated_at DESC, p.user_id
       LIMIT $5 OFFSET $6`,
      [req.authUser.id, country, city, intent, parsedLimit + 1, parsedOffset, minAge, maxAge, minFinancialAlignment, familyFormat, childrenFilter === null ? null : childrenFilter === 'true']
    );
    const hasMore = result.rows.length > parsedLimit;
    const profiles = (hasMore ? result.rows.slice(0, parsedLimit) : result.rows).map(profile => {
      const { assessment_answers: candidateAnswers, my_assessment_answers: myAnswers, ...publicProfile } = profile;
      const alignment = candidateAnswers && myAnswers ? financialAlignment(myAnswers, candidateAnswers).score : null;
      return { ...publicProfile, financialAlignment: alignment };
    });
    return res.json({
      profiles,
      pagination: { limit: parsedLimit, offset: parsedOffset, hasMore }
    });
  } catch (error) {
    console.error('Profile search failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'profile_search_failed' });
  }
});

function isUuid(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function isSafePhotoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && value.trim() === value;
  } catch {
    return false;
  }
}

app.get('/api/assessment', requireSession, requirePaidFeatures, async (req, res) => {
  try {
    const result = await pool.query('SELECT answers, assessment_version AS "assessmentVersion", completed_at AS "completedAt", updated_at AS "updatedAt" FROM relationship_assessments WHERE user_id = $1', [req.authUser.id]);
    return res.json({ assessment: result.rows[0] || null, version: ASSESSMENT_VERSION });
  } catch (error) {
    console.error('Assessment read failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'assessment_read_failed' });
  }
});

app.put('/api/assessment', validateRequestOrigin, requireSession, requirePaidFeatures, async (req, res) => {
  const answers = req.body?.answers;
  if (!isValidAssessment(answers)) return res.status(400).json({ error: 'assessment_answers_incomplete_or_invalid' });
  try {
    const result = await pool.query(
      'INSERT INTO relationship_assessments (user_id, answers, assessment_version, completed_at, updated_at) VALUES ($1, $2::jsonb, $3, NOW(), NOW()) ON CONFLICT (user_id) DO UPDATE SET answers = EXCLUDED.answers, assessment_version = EXCLUDED.assessment_version, completed_at = NOW(), updated_at = NOW() RETURNING answers, assessment_version AS "assessmentVersion", completed_at AS "completedAt", updated_at AS "updatedAt"',
      [req.authUser.id, JSON.stringify(answers), ASSESSMENT_VERSION]
    );
    return res.json({ assessment: result.rows[0] });
  } catch (error) {
    console.error('Assessment save failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'assessment_save_failed' });
  }
});

app.delete('/api/assessment', validateRequestOrigin, requireSession, async (req, res) => {
  try {
    await pool.query('DELETE FROM relationship_assessments WHERE user_id = $1', [req.authUser.id]);
    return res.status(204).end();
  } catch (error) {
    console.error('Assessment delete failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'assessment_delete_failed' });
  }
});

app.get('/api/profiles/me', requireSession, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id AS id, display_name AS "displayName",
        EXTRACT(YEAR FROM AGE(CURRENT_DATE, birth_date))::int AS age,
        gender, country, city, bio, photo_urls AS "photoUrls", occupation, education, languages,
        relationship_intent AS "relationshipIntent", is_visible AS "isVisible",
         family_format AS "familyFormat", has_children AS "hasChildren",
         children_disclosure_confirmed_at AS "childrenDisclosureConfirmedAt",
         wants_children AS "wantsChildren", children_living_arrangement AS "childrenLivingArrangement"
       FROM profiles WHERE user_id = $1`,
      [req.authUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'profile_not_found' });
    return res.json({ profile: result.rows[0] });
  } catch (error) {
    console.error('Profile read failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'profile_read_failed' });
  }
});

app.patch('/api/profiles/me', validateRequestOrigin, requireSession, async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = [req.authUser.id];
  const addUpdate = (column, value) => {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  };

  if (Object.hasOwn(body, 'displayName')) {
    if (typeof body.displayName !== 'string' || body.displayName.trim().length < 2 || body.displayName.trim().length > 80) {
      return res.status(400).json({ error: 'invalid_display_name' });
    }
    addUpdate('display_name', body.displayName.trim());
  }
  if (Object.hasOwn(body, 'bio')) {
    if (typeof body.bio !== 'string' || body.bio.length > 2000) return res.status(400).json({ error: 'invalid_bio' });
    addUpdate('bio', body.bio.trim());
  }
  if (Object.hasOwn(body, 'country')) {
    if (typeof body.country !== 'string' || !body.country.trim() || body.country.trim().length > 100) {
      return res.status(400).json({ error: 'invalid_country' });
    }
    addUpdate('country', body.country.trim());
  }
  if (Object.hasOwn(body, 'city')) {
    if (typeof body.city !== 'string' || !body.city.trim() || body.city.trim().length > 120) {
      return res.status(400).json({ error: 'invalid_city' });
    }
    addUpdate('city', body.city.trim());
  }
  if (Object.hasOwn(body, 'photoUrls')) {
    if (!Array.isArray(body.photoUrls) || body.photoUrls.length > 6 ||
        body.photoUrls.some(url => typeof url !== 'string' || url.length > 2048 || !isSafePhotoUrl(url))) {
      return res.status(400).json({ error: 'invalid_photo_urls' });
    }
    addUpdate('photo_urls', body.photoUrls);
  }
  if (Object.hasOwn(body, 'occupation')) {
    if (typeof body.occupation !== 'string' || body.occupation.trim().length > 120) return res.status(400).json({ error: 'invalid_occupation' });
    addUpdate('occupation', body.occupation.trim());
  }
  if (Object.hasOwn(body, 'education')) {
    if (typeof body.education !== 'string' || body.education.trim().length > 120) return res.status(400).json({ error: 'invalid_education' });
    addUpdate('education', body.education.trim());
  }
  if (Object.hasOwn(body, 'languages')) {
    if (!Array.isArray(body.languages) || body.languages.length > 10 ||
        body.languages.some(language => typeof language !== 'string' || language.trim().length < 2 || language.trim().length > 40)) {
      return res.status(400).json({ error: 'invalid_languages' });
    }
    addUpdate('languages', [...new Set(body.languages.map(language => language.trim()))]);
  }
  if (Object.hasOwn(body, 'familyFormat')) {
    if (!['marriage', 'cohabitation', 'open_to_both'].includes(body.familyFormat)) return res.status(400).json({ error: 'invalid_family_format' });
    addUpdate('family_format', body.familyFormat);
  }
  if (Object.hasOwn(body, 'hasChildren')) {
    if (typeof body.hasChildren !== 'boolean') return res.status(400).json({ error: 'children_status_required' });
    addUpdate('has_children', body.hasChildren);
    addUpdate('children_disclosure_confirmed_at', new Date().toISOString());
    // If a user changes child status, require a fresh explicit confirmation and re-enable only after this save.
  }
  if (Object.hasOwn(body, 'wantsChildren')) {
    if (!['yes', 'no', 'discuss', 'unsure'].includes(body.wantsChildren)) return res.status(400).json({ error: 'invalid_wants_children' });
    addUpdate('wants_children', body.wantsChildren);
  }
  if (Object.hasOwn(body, 'childrenLivingArrangement')) {
    if (!['with_me', 'shared_custody', 'with_other_parent', 'not_applicable', 'prefer_to_discuss'].includes(body.childrenLivingArrangement)) return res.status(400).json({ error: 'invalid_children_living_arrangement' });
    addUpdate('children_living_arrangement', body.childrenLivingArrangement);
  }
  if (Object.hasOwn(body, 'relationshipIntent')) {
    if (!['marriage_family', 'serious_relationship', 'family_without_marriage'].includes(body.relationshipIntent)) {
      return res.status(400).json({ error: 'invalid_relationship_intent' });
    }
    addUpdate('relationship_intent', body.relationshipIntent);
  }
  if (Object.hasOwn(body, 'isVisible')) {
    if (typeof body.isVisible !== 'boolean') return res.status(400).json({ error: 'invalid_visibility' });
    addUpdate('is_visible', body.isVisible);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'no_valid_profile_fields' });

  try {
    const result = await pool.query(
      `UPDATE profiles SET ${updates.join(', ')}, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id AS id, display_name AS "displayName", gender, country, city, bio,
         photo_urls AS "photoUrls", occupation, education, languages,
         relationship_intent AS "relationshipIntent", is_visible AS "isVisible",
         family_format AS "familyFormat", has_children AS "hasChildren",
         children_disclosure_confirmed_at AS "childrenDisclosureConfirmedAt",
         wants_children AS "wantsChildren", children_living_arrangement AS "childrenLivingArrangement"`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'profile_not_found' });
    const screening = await screenProfilePrivate(result.rows[0]);
    await persistScreening(req.authUser.id, 'profile', screening);
    return res.json({ profile: result.rows[0], screening: { engine: screening.engine, externalProcessing: false, flags: screening.flags, requiresReview: screening.requiresReview } });
  } catch (error) {
    console.error('Profile update failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'profile_update_failed' });
  }
});

app.post('/api/passes/undo', profileActionLimiter, validateRequestOrigin, requireSession, requirePaidFeatures, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const latest = await client.query(
      `SELECT pp.passed_user_id AS id
       FROM profile_passes pp
       JOIN profiles p ON p.user_id = pp.passed_user_id
       JOIN users u ON u.id = p.user_id
       WHERE pp.passer_id = $1
         AND u.status = 'active' AND p.is_visible = TRUE
         AND p.children_disclosure_confirmed_at IS NOT NULL AND p.has_children IS NOT NULL
         AND p.gender <> $2
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id)
              OR (b.blocker_id = p.user_id AND b.blocked_id = $1)
         )
       ORDER BY pp.created_at DESC
       LIMIT 1
       FOR UPDATE OF pp`,
      [req.authUser.id, req.authUser.gender]
    );
    const passedId = latest.rows[0]?.id;
    if (!passedId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no_recent_pass_to_undo' });
    }
    await client.query('DELETE FROM profile_passes WHERE passer_id = $1 AND passed_user_id = $2', [req.authUser.id, passedId]);
    const profileResult = await client.query(
      `SELECT p.user_id AS id, p.display_name AS "displayName",
              EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.birth_date))::int AS age,
              p.gender, p.country, p.city, p.bio, p.photo_urls AS "photoUrls",
              p.occupation, p.education, p.languages,
              p.relationship_intent AS "relationshipIntent",
              p.family_format AS "familyFormat", p.has_children AS "hasChildren",
              p.wants_children AS "wantsChildren",
              p.children_living_arrangement AS "childrenLivingArrangement",
              NULL::int AS "financialAlignment"
       FROM profiles p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1 AND u.status = 'active' AND p.is_visible = TRUE`,
      [passedId]
    );
    await client.query('COMMIT');
    if (!profileResult.rows[0]) return res.status(404).json({ error: 'profile_not_available' });
    return res.json({ profile: profileResult.rows[0] });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Undo profile pass failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'pass_undo_failed' });
  } finally {
    client?.release();
  }
});

app.post('/api/passes/:targetId', profileActionLimiter, validateRequestOrigin, requireSession, requirePaidFeatures, async (req, res) => {
  const targetId = req.params.targetId;
  if (!isUuid(targetId) || targetId === req.authUser.id) return res.status(400).json({ error: 'invalid_pass_target' });
  try {
    const target = await pool.query(
      "SELECT p.gender FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1 AND u.status = 'active' AND p.is_visible = TRUE AND p.children_disclosure_confirmed_at IS NOT NULL AND p.has_children IS NOT NULL",
      [targetId]
    );
    if (!target.rows[0] || target.rows[0].gender === req.authUser.gender) return res.status(404).json({ error: 'target_not_available' });
    await pool.query('INSERT INTO profile_passes (passer_id, passed_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.authUser.id, targetId]);
    return res.status(204).end();
  } catch (error) {
    console.error('Profile pass failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'profile_pass_failed' });
  }
});

app.post('/api/likes/:targetId', profileActionLimiter, validateRequestOrigin, requireSession, requirePaidFeatures, async (req, res) => {
  const targetId = req.params.targetId;
  if (!isUuid(targetId)) return res.status(400).json({ error: 'invalid_target_id' });
  if (targetId === req.authUser.id) return res.status(400).json({ error: 'cannot_like_self' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const targetResult = await client.query(
      `SELECT p.user_id, p.gender
       FROM profiles p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1 AND p.is_visible = TRUE AND u.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = p.user_id)
              OR (b.blocker_id = p.user_id AND b.blocked_id = $2)
         )`,
      [targetId, req.authUser.id]
    );
    const target = targetResult.rows[0];
    if (!target || target.gender === req.authUser.gender) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'target_not_available' });
    }

    await client.query(
      'INSERT INTO likes (sender_id, target_id) VALUES ($1, $2) ON CONFLICT (sender_id, target_id) DO NOTHING',
      [req.authUser.id, targetId]
    );
    const reciprocal = await client.query(
      'SELECT 1 FROM likes WHERE sender_id = $1 AND target_id = $2 LIMIT 1',
      [targetId, req.authUser.id]
    );
    if (reciprocal.rowCount === 0) {
      await client.query('COMMIT');
      return res.status(201).json({ liked: true, matched: false, match: null });
    }

    await client.query(
      `INSERT INTO matches (user_a_id, user_b_id)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
      [req.authUser.id, targetId]
    );
    const matchResult = await client.query(
      `SELECT id, status, created_at AS "createdAt" FROM matches
       WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)`,
      [req.authUser.id, targetId]
    );
    await client.query('COMMIT');
    const match = matchResult.rows[0];
    return res.status(201).json({
      liked: true,
      matched: match?.status === 'active',
      match: match?.status === 'active' ? match : null
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Like action failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'like_action_failed' });
  } finally {
    client?.release();
  }
});

app.delete('/api/likes/:targetId', profileActionLimiter, validateRequestOrigin, requireSession, requirePaidFeatures, async (req, res) => {
  if (!isUuid(req.params.targetId)) return res.status(400).json({ error: 'invalid_target_id' });
  try {
    await pool.query('DELETE FROM likes WHERE sender_id = $1 AND target_id = $2', [req.authUser.id, req.params.targetId]);
    return res.status(204).end();
  } catch (error) {
    console.error('Unlike failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'unlike_failed' });
  }
});

app.get('/api/matches', requireSession, requirePaidFeatures, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.status, m.created_at AS "createdAt",
         other.user_id AS "partnerId", other.display_name AS "displayName",
         EXTRACT(YEAR FROM AGE(CURRENT_DATE, other.birth_date))::int AS age,
         other.gender, other.country, other.city, other.bio,
         latest.body AS "lastMessage", latest.created_at AS "lastMessageAt"
       FROM matches m
       JOIN profiles other ON other.user_id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM messages
         WHERE match_id = m.id AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) latest ON TRUE
       WHERE (m.user_a_id = $1 OR m.user_b_id = $1) AND m.status = 'active'
       ORDER BY COALESCE(latest.created_at, m.created_at) DESC
       LIMIT 100`,
      [req.authUser.id]
    );
    return res.json({ matches: result.rows });
  } catch (error) {
    console.error('Match list failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'match_list_failed' });
  }
});

app.get('/api/matches/:matchId/messages', requireSession, requirePaidFeatures, async (req, res) => {
  if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
  const offset = Math.min(5000, Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0));

  try {
    const access = await pool.query(
      `SELECT 1 FROM matches WHERE id = $1 AND status = 'active'
       AND (user_a_id = $2 OR user_b_id = $2) LIMIT 1`,
      [req.params.matchId, req.authUser.id]
    );
    if (access.rowCount === 0) return res.status(404).json({ error: 'match_not_found' });

    const result = await pool.query(
      `SELECT id, sender_id AS "senderId", body AS text, created_at AS "createdAt"
       FROM messages WHERE match_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
      [req.params.matchId, limit, offset]
    );
    return res.json({ messages: result.rows, pagination: { limit, offset } });
  } catch (error) {
    console.error('Message history failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'message_history_failed' });
  }
});

const messageLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_messages' }
});

app.post('/api/matches/:matchId/messages', messageLimiter, validateRequestOrigin, requireSession, async (req, res) => {
  if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
  const body = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!body || body.length > 4000) return res.status(400).json({ error: 'message_must_be_1_to_4000_characters' });

  try {
    const access = await pool.query(
      `SELECT 1 FROM matches WHERE id = $1 AND status = 'active'
       AND (user_a_id = $2 OR user_b_id = $2) LIMIT 1`,
      [req.params.matchId, req.authUser.id]
    );
    if (access.rowCount === 0) return res.status(404).json({ error: 'match_not_found' });

    const screening = await screenTextPrivate(body, 'message');
    const result = await pool.query(
      `INSERT INTO messages (match_id, sender_id, body) VALUES ($1, $2, $3)
       RETURNING id, sender_id AS "senderId", body AS text, created_at AS "createdAt"`,
      [req.params.matchId, req.authUser.id, body]
    );
    await persistScreening(req.authUser.id, 'message', screening);
    return res.status(201).json({ message: result.rows[0], screening: { engine: screening.engine, externalProcessing: false, flaggedForReview: screening.requiresReview } });
  } catch (error) {
    console.error('Message send failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'message_send_failed' });
  }
});


app.get('/api/blocks', requireSession, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.blocked_id AS id, p.display_name AS "displayName", b.created_at AS "createdAt"
       FROM user_blocks b JOIN profiles p ON p.user_id = b.blocked_id
       WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [req.authUser.id]
    );
    return res.json({ blocks: result.rows });
  } catch (error) {
    console.error('Block list failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'block_list_failed' });
  }
});

app.post('/api/blocks/:targetId', profileActionLimiter, validateRequestOrigin, requireSession, async (req, res) => {
  const targetId = req.params.targetId;
  if (!isUuid(targetId) || targetId === req.authUser.id) return res.status(400).json({ error: 'invalid_block_target' });
  const client = await pool.connect().catch(() => null);
  if (!client) return res.status(503).json({ error: 'database_unavailable' });
  try {
    await client.query('BEGIN');
    const target = await client.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [targetId]);
    if (!target.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'target_not_available' });
    }
    await client.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.authUser.id, targetId]);
    await client.query('DELETE FROM likes WHERE (sender_id = $1 AND target_id = $2) OR (sender_id = $2 AND target_id = $1)', [req.authUser.id, targetId]);
    await client.query(`UPDATE matches SET status = 'blocked'
      WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid) AND status = 'active'`, [req.authUser.id, targetId]);
    await client.query('COMMIT');
    return res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Block user failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'block_user_failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/blocks/:targetId', profileActionLimiter, validateRequestOrigin, requireSession, async (req, res) => {
  const targetId = req.params.targetId;
  if (!isUuid(targetId) || targetId === req.authUser.id) return res.status(400).json({ error: 'invalid_block_target' });
  try {
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.authUser.id, targetId]);
    return res.status(204).end();
  } catch (error) {
    console.error('Unblock user failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'unblock_user_failed' });
  }
});

app.post('/api/reports', reportLimiter, validateRequestOrigin, requireSession, async (req, res) => {
  const reportedUserId = req.body?.reportedUserId;
  const category = req.body?.category;
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
  const validCategories = ['spam', 'fake_profile', 'harassment', 'safety', 'children_misrepresentation', 'duplicate_profile', 'other'];
  if (!isUuid(reportedUserId) || reportedUserId === req.authUser.id) {
    return res.status(400).json({ error: 'invalid_report_target' });
  }
  if (!validCategories.includes(category) || details.length > 2000) {
    return res.status(400).json({ error: 'invalid_report_details' });
  }

  try {
    const target = await pool.query('SELECT 1 FROM users WHERE id = $1 LIMIT 1', [reportedUserId]);
    if (target.rowCount === 0) return res.status(404).json({ error: 'reported_user_not_found' });
    const result = await pool.query(
      `INSERT INTO user_reports (reporter_id, reported_user_id, category, details)
       VALUES ($1, $2, $3, $4) RETURNING id, status, created_at AS "createdAt"`,
      [req.authUser.id, reportedUserId, category, details]
    );
    return res.status(201).json({ report: result.rows[0] });
  } catch (error) {
    console.error('Report submission failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'report_submission_failed' });
  }
});

app.get('/api/admin/screenings', requireSession, async (req, res) => {
  if (!['admin', 'moderator'].includes(req.authUser.role)) return res.status(403).json({ error: 'moderator_access_required' });
  try {
    const result = await pool.query(
      "SELECT id, user_id AS \"userId\", scope, flags, severity, engine_version AS \"engineVersion\", review_status AS \"reviewStatus\", created_at AS \"createdAt\" FROM user_safety_screenings WHERE review_status = 'pending' ORDER BY created_at DESC LIMIT 100"
    );
    return res.json({ screenings: result.rows, rawTextStored: false, externalProcessing: false });
  } catch (error) {
    console.error('Screening queue failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'screening_queue_failed' });
  }
});

app.post('/api/admin/screenings/:screeningId/resolve', validateRequestOrigin, requireSession, async (req, res) => {
  if (!['admin', 'moderator'].includes(req.authUser.role)) return res.status(403).json({ error: 'moderator_access_required' });
  if (!isUuid(req.params.screeningId)) return res.status(400).json({ error: 'invalid_screening_id' });
  try {
    const result = await pool.query(
      "UPDATE user_safety_screenings SET review_status = 'cleared', reviewed_at = NOW(), reviewed_by = $2 WHERE id = $1 AND review_status = 'pending' RETURNING id, review_status AS \"reviewStatus\"",
      [req.params.screeningId, req.authUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'pending_screening_not_found' });
    return res.json({ screening: result.rows[0] });
  } catch (error) {
    console.error('Screening resolve failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'screening_resolve_failed' });
  }
});

app.post('/api/admin/reports/:reportId/action', validateRequestOrigin, requireSession, async (req, res) => {
  if (!['admin', 'moderator'].includes(req.authUser.role)) return res.status(403).json({ error: 'moderator_access_required' });
  const reportId = req.params.reportId;
  const action = req.body?.action;
  const confirmed = req.body?.confirmed === true;
  if (!isUuid(reportId) || !['resolve', 'dismiss', 'suspend_user'].includes(action)) {
    return res.status(400).json({ error: 'invalid_moderation_action' });
  }
  if (action === 'suspend_user' && !confirmed) {
    return res.status(400).json({ error: 'explicit_moderator_confirmation_required' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const reportResult = await client.query(
      'SELECT id, reported_user_id, category, status FROM user_reports WHERE id = $1 FOR UPDATE',
      [reportId]
    );
    const report = reportResult.rows[0];
    if (!report || report.status === 'resolved' || report.status === 'dismissed') {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'open_report_not_found' });
    }
    if (action === 'suspend_user') {
      if (!['children_misrepresentation', 'duplicate_profile', 'fake_profile', 'safety'].includes(report.category)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'category_not_eligible_for_suspension' });
      }
      await client.query("UPDATE users SET status = 'suspended', updated_at = NOW() WHERE id = $1", [report.reported_user_id]);
      await client.query('UPDATE profiles SET is_visible = FALSE, updated_at = NOW() WHERE user_id = $1', [report.reported_user_id]);
      await client.query(
        "UPDATE matches SET status = 'blocked' WHERE status = 'active' AND (user_a_id = $1 OR user_b_id = $1)",
        [report.reported_user_id]
      );
      await client.query('DELETE FROM sessions WHERE user_id = $1', [report.reported_user_id]);
    }
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    await client.query('UPDATE user_reports SET status = $2 WHERE id = $1', [reportId, status]);
    await client.query('COMMIT');
    return res.json({ ok: true, action, accountSuspended: action === 'suspend_user' });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Moderation action failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'moderation_action_failed' });
  } finally {
    client?.release();
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'api_route_not_found' });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`НИТЬ API listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down API`);
  server.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
