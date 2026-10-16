import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
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
app.use(express.json({ limit: '32kb', strict: true }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_auth_attempts' }
});

function requireDatabase(_req, res, next) {
  if (!pool) {
    return res.status(503).json({ error: 'database_not_configured' });
  }
  next();
}

function validateRequestOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();

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
      `SELECT u.id, u.email, u.status, p.display_name, p.gender, p.country, p.city, p.relationship_intent, s.id AS session_id
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
    req.authUser = user;
    await pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [user.session_id]);
    return next();
  } catch (error) {
    console.error('Authentication middleware failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'authentication_failed' });
  }
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

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'password_must_be_12_to_128_characters' });
  }
  if (displayName.length < 2 || displayName.length > 80) {
    return res.status(400).json({ error: 'display_name_must_be_2_to_80_characters' });
  }
  if (!isAdultDate(birthDate)) {
    return res.status(400).json({ error: 'must_be_18_or_older_with_valid_birth_date' });
  }
  if (gender !== 'female' && gender !== 'male') {
    return res.status(400).json({ error: 'invalid_gender' });
  }
  if (!country || country.length > 100 || !city || city.length > 120) {
    return res.status(400).json({ error: 'valid_country_and_city_required' });
  }
  if (!['marriage_family', 'serious_relationship'].includes(relationshipIntent)) {
    return res.status(400).json({ error: 'invalid_relationship_intent' });
  }

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );
    const user = userResult.rows[0];
    const profileResult = await client.query(
      `INSERT INTO profiles (user_id, display_name, birth_date, gender, country, city, relationship_intent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING user_id AS id, display_name, gender, country, city, relationship_intent`,
      [user.id, displayName, birthDate, gender, country, city, relationshipIntent]
    );
    const token = await createSession(client, user.id);
    await client.query('COMMIT');

    writeSessionCookie(res, token);
    return res.status(201).json({ user: { ...publicUser({ ...profileResult.rows[0], email: user.email }) } });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'email_already_registered' });
    }
    console.error('Registration failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'registration_failed' });
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
      `SELECT u.id, u.email, u.password_hash, u.status, p.display_name, p.gender, p.country, p.city, p.relationship_intent
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
      return res.status(403).json({ error: 'account_unavailable' });
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
      `SELECT u.id, u.email, u.status, p.display_name, p.gender, p.country, p.city, p.relationship_intent, s.id AS session_id
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

app.get('/api/profiles/search', requireSession, async (req, res) => {
  const cleanFilter = (value, maxLength) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLocaleLowerCase() === 'all') return null;
    return trimmed.slice(0, maxLength);
  };

  const country = cleanFilter(req.query.country, 100);
  const city = cleanFilter(req.query.city, 120);
  const intent = cleanFilter(req.query.intent, 40);
  if (intent && !['marriage_family', 'serious_relationship'].includes(intent)) {
    return res.status(400).json({ error: 'invalid_relationship_intent' });
  }

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
         p.relationship_intent AS "relationshipIntent"
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       JOIN profiles me ON me.user_id = $1
       WHERE p.user_id <> $1
         AND p.gender <> me.gender
         AND p.is_visible = TRUE
         AND p.birth_date IS NOT NULL
         AND u.status = 'active'
         AND ($2::text IS NULL OR p.country ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR p.city ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR p.relationship_intent = $4)
       ORDER BY p.updated_at DESC, p.user_id
       LIMIT $5 OFFSET $6`,
      [req.authUser.id, country, city, intent, parsedLimit + 1, parsedOffset]
    );
    const hasMore = result.rows.length > parsedLimit;
    const profiles = hasMore ? result.rows.slice(0, parsedLimit) : result.rows;
    return res.json({
      profiles,
      pagination: { limit: parsedLimit, offset: parsedOffset, hasMore }
    });
  } catch (error) {
    console.error('Profile search failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'profile_search_failed' });
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
