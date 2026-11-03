import rateLimit from 'express-rate-limit';
import { PostgresRateLimitStore } from './postgresRateLimitStore.js';
import { rollbackPooledTransaction } from './withPooledTransaction.js';

const STREET_SUFFIX = '(?:street|st\\.?|avenue|ave\\.?|road|rd\\.?|lane|ln\\.?|drive|dr\\.?|boulevard|blvd\\.?|way|улица|ул\\.?|проспект|пр-т|переулок|пер\\.?|набережная|шоссе|ქუჩა|გამზირი)';
const STREET_PREFIX = '(?:улица|ул\\.?|проспект|пр-т|переулок|пер\\.?|набережная|шоссе|ქუჩა|გამზირი)';
const STREET_WORD = '[\\p{L}\\p{M}][\\p{L}\\p{M}\\u2019’\\x27.-]*';
const HOUSE_NUMBER = '(?:№|#)?\\s*\\d+[a-zа-я]?(?:[-/]\\d+[a-zа-я]?)?';
const LEFT_ADDRESS_BOUNDARY = '(?:^|[^\\p{L}\\p{M}\\p{N}])';
const RIGHT_ADDRESS_BOUNDARY = '(?=$|[^\\p{L}\\p{M}\\p{N}])';
const PRIVATE_ADDRESS_PATTERNS = [
  new RegExp(LEFT_ADDRESS_BOUNDARY + STREET_WORD + '(?:\\s+' + STREET_WORD + '){0,5}\\s+' + STREET_SUFFIX + '\\s*,?\\s*' + HOUSE_NUMBER + RIGHT_ADDRESS_BOUNDARY, 'iu'),
  new RegExp(LEFT_ADDRESS_BOUNDARY + STREET_PREFIX + '\\s+' + STREET_WORD + '(?:\\s+' + STREET_WORD + '){0,5}\\s*,?\\s*' + HOUSE_NUMBER + RIGHT_ADDRESS_BOUNDARY, 'iu'),
  new RegExp(LEFT_ADDRESS_BOUNDARY + HOUSE_NUMBER + '\\s+' + STREET_WORD + '(?:\\s+' + STREET_WORD + '){0,5}\\s+' + STREET_SUFFIX + RIGHT_ADDRESS_BOUNDARY, 'iu'),
  new RegExp(LEFT_ADDRESS_BOUNDARY + '(?:apt\\.?|apartment|flat|unit|suite|дом|д\\.?|квартира|кв\\.?|building|bldg\\.?)\\s*(?:№|#)?\\s*\\d+' + RIGHT_ADDRESS_BOUNDARY, 'iu'),
  /\b-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/
];

export function normalizeDatePlanInput(body) {
  const venueName = typeof body?.venueName === 'string' ? body.venueName.trim() : '';
  const startsAt = typeof body?.startsAt === 'string' ? body.startsAt : '';
  const timeZone = typeof body?.timeZone === 'string' ? body.timeZone.trim() : '';
  if (venueName.length < 2 || venueName.length > 120 || /[\u0000-\u001f\u007f]/.test(venueName) || body?.isPublicVenue !== true) return null;
  if (/(?:https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{7,}\d)/i.test(venueName) || /^\d{1,6}\s+\S+/.test(venueName) || PRIVATE_ADDRESS_PATTERNS.some(pattern => pattern.test(venueName))) return null;
  const dateParts = startsAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!dateParts) return null;
  const [, year, month, day, hour, minute, second = '0'] = dateParts;
  const maxDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > maxDay || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const instant = new Date(startsAt);
  const now = Date.now();
  if (!Number.isFinite(instant.getTime()) || instant.getTime() < now + 30 * 60_000 || instant.getTime() > now + 90 * 86_400_000) return null;
  if (!timeZone || timeZone.length > 80) return null;
  try { new Intl.DateTimeFormat('en', { timeZone }).format(instant); } catch { return null; }
  return { venueName, startsAt: instant, timeZone };
}

export function registerDatePlanRoutes(app, deps) {
  const { pool, requireSession, validateRequestOrigin, createNotification, acquireGiftSafetyUserLocks, isUuid } = deps;
  const limiter = rateLimit({
    ...(pool ? { store: new PostgresRateLimitStore(pool, 'date-plan') } : {}),
    windowMs: 15 * 60_000, limit: 12, standardHeaders: true, legacyHeaders: false,
    message: { error: 'date_plan_rate_limited' }
  });

  async function lockMatch(client, matchId, actorId) {
    const preview = await client.query(
      'SELECT user_a_id, user_b_id FROM matches WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2)',
      [matchId, actorId]
    );
    if (!preview.rowCount) return null;
    const { user_a_id: userAId, user_b_id: userBId } = preview.rows[0];
    await acquireGiftSafetyUserLocks(client, userAId, userBId);
    // Didit webhooks update the L2 row under a row lock. Lock the same row
    // before checking eligibility so a concurrent verification revocation
    // either waits for this plan transaction or is observed before it proceeds.
    await client.query(
      `SELECT user_id FROM identity_verifications
       WHERE user_id = ANY($1::uuid[]) AND provider = 'didit'
       ORDER BY user_id
       FOR SHARE`,
      [[userAId, userBId]]
    );
    const access = await client.query(
      `SELECT m.user_a_id, m.user_b_id FROM matches m
       JOIN users ua ON ua.id = m.user_a_id AND ua.status = 'active'
       JOIN users ub ON ub.id = m.user_b_id AND ub.status = 'active'
       JOIN profiles pa ON pa.user_id = m.user_a_id
       JOIN profiles pb ON pb.user_id = m.user_b_id
       WHERE m.id = $1 AND m.status = 'active'
         AND ((m.user_a_id = $2 AND m.user_b_id = $3) OR (m.user_a_id = $3 AND m.user_b_id = $2))
         AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
           (b.blocker_id = m.user_a_id AND b.blocked_id = m.user_b_id) OR
           (b.blocker_id = m.user_b_id AND b.blocked_id = m.user_a_id))
         AND (pa.gender <> 'male' OR (
           EXISTS (SELECT 1 FROM identity_verifications iv WHERE iv.user_id = pa.user_id
             AND iv.provider = 'didit' AND iv.status = 'verified'
             AND iv.provider_environment = 'live' AND iv.provider_status = 'Approved'
             AND iv.provider_session_id IS NOT NULL)
           AND identity_l3_has_active_approval(pa.user_id)))
         AND (pb.gender <> 'male' OR (
           EXISTS (SELECT 1 FROM identity_verifications iv WHERE iv.user_id = pb.user_id
             AND iv.provider = 'didit' AND iv.status = 'verified'
             AND iv.provider_environment = 'live' AND iv.provider_status = 'Approved'
             AND iv.provider_session_id IS NOT NULL)
           AND identity_l3_has_active_approval(pb.user_id)))
       FOR UPDATE OF m, ua, ub`,
      [matchId, userAId, userBId]
    );
    if (!access.rowCount) {
      // Identity approvals can expire by timestamp without a provider webhook.
      // If either participant is no longer eligible, cancel the saved plan now
      // so a later re-verification cannot silently revive stale consent.
      const safetyState = await client.query(
        `SELECT m.user_a_id AS "userAId", m.user_b_id AS "userBId",
           CASE
             WHEN ua.status <> 'active' OR (pa.gender = 'male' AND (
               NOT EXISTS (SELECT 1 FROM identity_verifications iv WHERE iv.user_id = pa.user_id
                 AND iv.provider = 'didit' AND iv.status = 'verified'
                 AND iv.provider_environment = 'live' AND iv.provider_status = 'Approved'
                 AND iv.provider_session_id IS NOT NULL)
               OR NOT identity_l3_has_active_approval(pa.user_id)
             )) THEN m.user_a_id
             WHEN ub.status <> 'active' OR (pb.gender = 'male' AND (
               NOT EXISTS (SELECT 1 FROM identity_verifications iv WHERE iv.user_id = pb.user_id
                 AND iv.provider = 'didit' AND iv.status = 'verified'
                 AND iv.provider_environment = 'live' AND iv.provider_status = 'Approved'
                 AND iv.provider_session_id IS NOT NULL)
               OR NOT identity_l3_has_active_approval(pb.user_id)
             )) THEN m.user_b_id
             ELSE NULL
           END AS "ineligibleUserId"
         FROM matches m
         JOIN users ua ON ua.id = m.user_a_id
         JOIN users ub ON ub.id = m.user_b_id
         JOIN profiles pa ON pa.user_id = m.user_a_id
         JOIN profiles pb ON pb.user_id = m.user_b_id
        WHERE m.id = $1 AND m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
            (b.blocker_id = m.user_a_id AND b.blocked_id = m.user_b_id) OR
            (b.blocker_id = m.user_b_id AND b.blocked_id = m.user_a_id))
        FOR UPDATE OF m, ua, ub`,
        [matchId]
      );
      const ineligibleUserId = safetyState.rows[0]?.ineligibleUserId;
      if (ineligibleUserId) {
        const otherUserId = safetyState.rows[0].userAId === ineligibleUserId
          ? safetyState.rows[0].userBId
          : safetyState.rows[0].userAId;
        const cancelled = await client.query(
          `UPDATE date_plans
              SET status = 'cancelled',
                  confirmed_by_a_at = NULL,
                  confirmed_by_b_at = NULL,
                  updated_at = statement_timestamp()
            WHERE match_id = $1 AND status IN ('proposed', 'confirmed')
            RETURNING id`,
          [matchId]
        );
        for (const plan of cancelled.rows) {
          await client.query(
            `INSERT INTO date_plan_events (date_plan_id, actor_id, event_type, details)
             VALUES ($1, $2, 'cancelled', $3::jsonb)`,
            [plan.id, ineligibleUserId, JSON.stringify({ reason: 'participant_safety_eligibility_lost' })]
          );
          const activeRecipient = await client.query(
            "SELECT 1 FROM users WHERE id = $1 AND status = 'active'",
            [otherUserId]
          );
          if (activeRecipient.rowCount) {
            await createNotification(
              otherUserId,
              'date_plan_cancelled',
              { matchId, datePlanId: plan.id },
              'date-plan-safety-' + plan.id,
              client
            );
          }
        }
      }
      return null;
    }
    await client.query(
      "UPDATE date_plans SET status = 'expired', confirmed_by_a_at = NULL, confirmed_by_b_at = NULL, updated_at = NOW() WHERE match_id = $1 AND status IN ('proposed', 'confirmed') AND starts_at <= NOW()",
      [matchId]
    );
    return { userAId, userBId };
  }

  app.get('/api/matches/:matchId/date-plan', requireSession, async (req, res) => {
    if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const pair = await lockMatch(client, req.params.matchId, req.authUser.id);
      if (!pair) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'match_not_found' }); }
      const result = await client.query(
        `SELECT id, match_id AS "matchId", proposed_by AS "proposedBy", venue_name AS "venueName",
          starts_at AS "startsAt", time_zone AS "timeZone", status,
          confirmed_by_a_at AS "confirmedByAAt", confirmed_by_b_at AS "confirmedByBAt",
          created_at AS "createdAt", updated_at AS "updatedAt"
         FROM date_plans WHERE match_id = $1 AND status IN ('proposed', 'confirmed')
         ORDER BY created_at DESC LIMIT 1`,
        [req.params.matchId]
      );
      await client.query('COMMIT');
      return res.json({ datePlan: result.rows[0] || null, currentUserId: req.authUser.id, ...pair });
    } catch (error) {
      if (client && !await rollbackPooledTransaction(client)) client = null;
      console.error('Date plan read failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'date_plan_read_failed' });
    } finally { client?.release(); }
  });

  app.post('/api/matches/:matchId/date-plan', limiter, validateRequestOrigin, requireSession, async (req, res) => {
    if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
    const input = normalizeDatePlanInput(req.body);
    if (!input) return res.status(400).json({ error: 'invalid_date_plan' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const pair = await lockMatch(client, req.params.matchId, req.authUser.id);
      if (!pair) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'match_not_found' }); }
      const existing = await client.query(
        "SELECT id FROM date_plans WHERE match_id = $1 AND status IN ('proposed', 'confirmed') FOR UPDATE",
        [req.params.matchId]
      );
      const saved = existing.rowCount
        ? await client.query(
          `UPDATE date_plans SET proposed_by = $2, venue_name = $3, is_public_venue = TRUE,
             starts_at = $4, time_zone = $5, status = 'proposed',
             confirmed_by_a_at = NULL, confirmed_by_b_at = NULL, updated_at = NOW()
           WHERE id = $1
           RETURNING id, match_id AS "matchId", proposed_by AS "proposedBy", venue_name AS "venueName",
             starts_at AS "startsAt", time_zone AS "timeZone", status,
             confirmed_by_a_at AS "confirmedByAAt", confirmed_by_b_at AS "confirmedByBAt",
             created_at AS "createdAt", updated_at AS "updatedAt"`,
          [existing.rows[0].id, req.authUser.id, input.venueName, input.startsAt, input.timeZone])
        : await client.query(
          `INSERT INTO date_plans (match_id, proposed_by, venue_name, is_public_venue, starts_at, time_zone)
           VALUES ($1, $2, $3, TRUE, $4, $5)
           RETURNING id, match_id AS "matchId", proposed_by AS "proposedBy", venue_name AS "venueName",
             starts_at AS "startsAt", time_zone AS "timeZone", status,
             confirmed_by_a_at AS "confirmedByAAt", confirmed_by_b_at AS "confirmedByBAt",
             created_at AS "createdAt", updated_at AS "updatedAt"`,
          [req.params.matchId, req.authUser.id, input.venueName, input.startsAt, input.timeZone]);
      const plan = saved.rows[0];
      await client.query(
        'INSERT INTO date_plan_events (date_plan_id, actor_id, event_type) VALUES ($1, $2, $3)',
        [plan.id, req.authUser.id, existing.rowCount ? 'updated' : 'proposed']);
      const recipientId = pair.userAId === req.authUser.id ? pair.userBId : pair.userAId;
      await createNotification(recipientId, 'date_plan_proposed', { matchId: req.params.matchId, datePlanId: plan.id }, null, client);
      await client.query('COMMIT');
      return res.status(201).json({ datePlan: plan });
    } catch (error) {
      if (client && !await rollbackPooledTransaction(client)) client = null;
      console.error('Date plan proposal failed:', error?.message || 'unknown error');
      return res.status(error?.code === '23505' ? 409 : 500).json({ error: error?.code === '23505' ? 'date_plan_conflict' : 'date_plan_proposal_failed' });
    } finally { client?.release(); }
  });

  app.post('/api/matches/:matchId/date-plan/confirm', limiter, validateRequestOrigin, requireSession, async (req, res) => {
    if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const pair = await lockMatch(client, req.params.matchId, req.authUser.id);
      if (!pair) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'match_not_found' }); }
      const current = await client.query(
        "SELECT id, confirmed_by_a_at, confirmed_by_b_at FROM date_plans WHERE match_id = $1 AND status = 'proposed' FOR UPDATE",
        [req.params.matchId]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'date_plan_not_proposed' }); }
      const row = current.rows[0];
      const isA = pair.userAId === req.authUser.id;
      const column = isA ? 'confirmed_by_a_at' : 'confirmed_by_b_at';
      // This request records the current participant's confirmation. The plan
      // becomes confirmed only if the other participant had already confirmed.
      const both = isA
        ? Boolean(row.confirmed_by_b_at)
        : Boolean(row.confirmed_by_a_at);
      const updated = await client.query(
        `UPDATE date_plans SET ${column} = COALESCE(${column}, NOW()),
           status = CASE WHEN $2 THEN 'confirmed' ELSE 'proposed' END, updated_at = NOW()
         WHERE id = $1
         RETURNING id, match_id AS "matchId", proposed_by AS "proposedBy", venue_name AS "venueName",
           starts_at AS "startsAt", time_zone AS "timeZone", status,
           confirmed_by_a_at AS "confirmedByAAt", confirmed_by_b_at AS "confirmedByBAt",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [row.id, both || Boolean(isA ? row.confirmed_by_b_at : row.confirmed_by_a_at)]);
      const plan = updated.rows[0];
      await client.query(
        "INSERT INTO date_plan_events (date_plan_id, actor_id, event_type) VALUES ($1, $2, 'confirmed')",
        [row.id, req.authUser.id]);
      if (plan.status === 'confirmed') {
        const recipientId = isA ? pair.userBId : pair.userAId;
        await createNotification(recipientId, 'date_plan_confirmed', { matchId: req.params.matchId, datePlanId: row.id }, null, client);
      }
      await client.query('COMMIT');
      return res.json({ datePlan: plan });
    } catch (error) {
      if (client && !await rollbackPooledTransaction(client)) client = null;
      console.error('Date plan confirmation failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'date_plan_confirmation_failed' });
    } finally { client?.release(); }
  });

  app.post('/api/matches/:matchId/date-plan/cancel', limiter, validateRequestOrigin, requireSession, async (req, res) => {
    if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const pair = await lockMatch(client, req.params.matchId, req.authUser.id);
      if (!pair) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'match_not_found' }); }
      const current = await client.query(
        "SELECT id FROM date_plans WHERE match_id = $1 AND status IN ('proposed', 'confirmed') FOR UPDATE",
        [req.params.matchId]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'date_plan_not_available' }); }
      const planId = current.rows[0].id;
      await client.query(
        "UPDATE date_plans SET status = 'cancelled', confirmed_by_a_at = NULL, confirmed_by_b_at = NULL, updated_at = NOW() WHERE id = $1",
        [planId]);
      await client.query(
        "INSERT INTO date_plan_events (date_plan_id, actor_id, event_type) VALUES ($1, $2, 'cancelled')",
        [planId, req.authUser.id]);
      const recipientId = pair.userAId === req.authUser.id ? pair.userBId : pair.userAId;
      await createNotification(recipientId, 'date_plan_cancelled', { matchId: req.params.matchId, datePlanId: planId }, null, client);
      await client.query('COMMIT');
      return res.json({ cancelled: true });
    } catch (error) {
      if (client && !await rollbackPooledTransaction(client)) client = null;
      console.error('Date plan cancellation failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'date_plan_cancellation_failed' });
    } finally { client?.release(); }
  });

  app.post('/api/matches/:matchId/date-plan/decline', limiter, validateRequestOrigin, requireSession, async (req, res) => {
    if (!isUuid(req.params.matchId)) return res.status(400).json({ error: 'invalid_match_id' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const pair = await lockMatch(client, req.params.matchId, req.authUser.id);
      if (!pair) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'match_not_found' }); }
      const current = await client.query(
        "SELECT id FROM date_plans WHERE match_id = $1 AND status = 'proposed' FOR UPDATE",
        [req.params.matchId]);
      if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'date_plan_not_proposed' }); }
      await client.query(
        "UPDATE date_plans SET status = 'declined', confirmed_by_a_at = NULL, confirmed_by_b_at = NULL, updated_at = NOW() WHERE id = $1",
        [current.rows[0].id]);
      await client.query(
        "INSERT INTO date_plan_events (date_plan_id, actor_id, event_type) VALUES ($1, $2, 'declined')",
        [current.rows[0].id, req.authUser.id]);
      const recipientId = pair.userAId === req.authUser.id ? pair.userBId : pair.userAId;
      await createNotification(recipientId, 'date_plan_declined', { matchId: req.params.matchId, datePlanId: current.rows[0].id }, null, client);
      await client.query('COMMIT');
      return res.json({ declined: true });
    } catch (error) {
      if (client && !await rollbackPooledTransaction(client)) client = null;
      console.error('Date plan decline failed:', error?.message || 'unknown error');
      return res.status(500).json({ error: 'date_plan_decline_failed' });
    } finally { client?.release(); }
  });
}
