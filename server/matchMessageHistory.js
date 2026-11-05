export const normalizeMatchMessageHistoryOptions = (query = {}) => {
  const rawLimit = Number.parseInt(String(query.limit ?? '50'), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? '0'), 10);
  return {
    limit: Math.min(100, Math.max(1, rawLimit || 50)),
    offset: Math.min(5000, Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)),
    latest: query.latest === 'true',
    beforeCreatedAt: typeof query.beforeCreatedAt === 'string' && query.beforeCreatedAt.length <= 100 && Number.isFinite(Date.parse(query.beforeCreatedAt)) ? query.beforeCreatedAt : null,
    beforeId: typeof query.beforeId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.beforeId) ? query.beforeId : null
  };
};

export const matchMessageHistoryOrder = latest => latest ? 'DESC' : 'ASC';

export const toChronologicalMessageHistory = (rows, latest) =>
  latest ? [...rows].reverse() : rows;
