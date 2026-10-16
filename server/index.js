import 'dotenv/config';
import express from 'express';
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
  if (!['marriage_family', 'serious_relationship'].includes(relationshipIntent)) {
    return res.status(400).json({ error: 'invalid_relationship_intent' });
  }

  let client;
  try {
    const passwordHash = await hashPassword(password);
    client = await pool.connect();
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
  const parseAge = value => value === undefined || value === '' ? null : Number.parseInt(String(value), 10);
  const minAge = parseAge(req.query.minAge);
  const maxAge = parseAge(req.query.maxAge);
  const minFinancialAlignment = req.query.minFinancialAlignment === undefined ? 0 : Number.parseInt(String(req.query.minFinancialAlignment), 10);
  if ((minAge !== null && (!Number.isInteger(minAge) || minAge < 18 || minAge > 120)) || (maxAge !== null && (!Number.isInteger(maxAge) || maxAge < 18 || maxAge > 120)) || (minAge !== null && maxAge !== null && minAge > maxAge) || !Number.isInteger(minFinancialAlignment) || minFinancialAlignment < 0 || minFinancialAlignment > 100) return res.status(400).json({ error: 'invalid_age_or_financial_alignment_filter' });
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
         p.relationship_intent AS "relationshipIntent",
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
         AND p.birth_date IS NOT NULL
         AND u.status = 'active'
         AND ($2::text IS NULL OR p.country ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR p.city ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR p.relationship_intent = $4)
         AND EXTRACT(YEAR FROM AGE(CURRENT_DATE, p.birth_date))::int BETWEEN COALESCE($7::int, 18) AND COALESCE($8::int, 120)
         AND ($9::int = 0 OR (candidate_assessment.answers IS NOT NULL AND my_assessment.answers IS NOT NULL AND (CASE WHEN candidate_assessment.answers->>'financialModel' = my_assessment.answers->>'financialModel' THEN 1 ELSE 0 END + CASE WHEN candidate_assessment.answers->>'lifestyleExpectation' = my_assessment.answers->>'lifestyleExpectation' THEN 1 ELSE 0 END + CASE WHEN candidate_assessment.answers->>'gifts' = my_assessment.answers->>'gifts' THEN 1 ELSE 0 END) * 100.0 / 3 >= ($9 - 0.5)))
       ORDER BY p.updated_at DESC, p.user_id
       LIMIT $5 OFFSET $6`,
      [req.authUser.id, country, city, intent, parsedLimit + 1, parsedOffset, minAge, maxAge, minFinancialAlignment]
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

app.get('/api/assessment', requireSession, async (req, res) => {
  try {
    const result = await pool.query('SELECT answers, assessment_version AS "assessmentVersion", completed_at AS "completedAt", updated_at AS "updatedAt" FROM relationship_assessments WHERE user_id = $1', [req.authUser.id]);
    return res.json({ assessment: result.rows[0] || null, version: ASSESSMENT_VERSION });
  } catch (error) {
    console.error('Assessment read failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'assessment_read_failed' });
  }
});

app.put('/api/assessment', validateRequestOrigin, requireSession, async (req, res) => {
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
        gender, country, city, bio, relationship_intent AS "relationshipIntent", is_visible AS "isVisible"
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
    updates.push(`${column} = ${values.length}`);
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
  if (Object.hasOwn(body, 'relationshipIntent')) {
    if (!['marriage_family', 'serious_relationship'].includes(body.relationshipIntent)) {
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
         relationship_intent AS "relationshipIntent", is_visible AS "isVisible"`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'profile_not_found' });
    return res.json({ profile: result.rows[0] });
  } catch (error) {
    console.error('Profile update failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'profile_update_failed' });
  }
});

app.post('/api/likes/:targetId', validateRequestOrigin, requireSession, async (req, res) => {
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
       WHERE p.user_id = $1 AND p.is_visible = TRUE AND u.status = 'active'`,
      [targetId]
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

app.delete('/api/likes/:targetId', validateRequestOrigin, requireSession, async (req, res) => {
  if (!isUuid(req.params.targetId)) return res.status(400).json({ error: 'invalid_target_id' });
  try {
    await pool.query('DELETE FROM likes WHERE sender_id = $1 AND target_id = $2', [req.authUser.id, req.params.targetId]);
    return res.status(204).end();
  } catch (error) {
    console.error('Unlike failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'unlike_failed' });
  }
});

app.get('/api/matches', requireSession, async (req, res) => {
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

app.get('/api/matches/:matchId/messages', requireSession, async (req, res) => {
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

    const result = await pool.query(
      `INSERT INTO messages (match_id, sender_id, body) VALUES ($1, $2, $3)
       RETURNING id, sender_id AS "senderId", body AS text, created_at AS "createdAt"`,
      [req.params.matchId, req.authUser.id, body]
    );
    return res.status(201).json({ message: result.rows[0] });
  } catch (error) {
    console.error('Message send failed:', error?.message || 'unknown error');
    return res.status(500).json({ error: 'message_send_failed' });
  }
});

app.post('/api/reports', validateRequestOrigin, requireSession, async (req, res) => {
  const reportedUserId = req.body?.reportedUserId;
  const category = req.body?.category;
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
  const validCategories = ['spam', 'fake_profile', 'harassment', 'safety', 'other'];
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
