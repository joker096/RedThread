export class PostgresRateLimitStore {
  constructor(pool, namespace) {
    this.pool = pool;
    this.namespace = namespace;
    this.windowMs = 60_000;
    this.cleanupCounter = 0;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const result = await this.pool.query(
      `INSERT INTO api_rate_limit_counters (key, window_started_at, hits)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE
           WHEN api_rate_limit_counters.window_started_at + ($2::int * INTERVAL '1 millisecond') <= NOW() THEN 1
           ELSE api_rate_limit_counters.hits + 1
         END,
         window_started_at = CASE
           WHEN api_rate_limit_counters.window_started_at + ($2::int * INTERVAL '1 millisecond') <= NOW() THEN NOW()
           ELSE api_rate_limit_counters.window_started_at
         END
       RETURNING hits, window_started_at`,
      [this.namespace + ':' + key, this.windowMs]
    );
    this.cleanupCounter += 1;
    if (this.cleanupCounter >= 1000) {
      this.cleanupCounter = 0;
      void this.pool.query("DELETE FROM api_rate_limit_counters WHERE window_started_at < NOW() - INTERVAL '2 days'").catch(() => {});
    }
    const row = result.rows[0];
    return {
      totalHits: Number(row.hits),
      resetTime: new Date(new Date(row.window_started_at).getTime() + this.windowMs)
    };
  }

  async decrement(key) {
    await this.pool.query(
      "UPDATE api_rate_limit_counters SET hits = GREATEST(hits - 1, 0) WHERE key = $1",
      [this.namespace + ':' + key]
    );
  }

  async resetKey(key) {
    await this.pool.query('DELETE FROM api_rate_limit_counters WHERE key = $1', [this.namespace + ':' + key]);
  }
}
