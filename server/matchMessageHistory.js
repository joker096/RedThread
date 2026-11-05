export const normalizeMatchMessageHistoryOptions = (query = {}) => {
  const rawLimit = Number.parseInt(String(query.limit ?? '50'), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? '0'), 10);
  const latest = query.latest === 'true';
  const cursorRequested = query.beforeCreatedAt !== undefined || query.beforeId !== undefined;
  const validBeforeCreatedAt = typeof query.beforeCreatedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(query.beforeCreatedAt) &&
    Number.isFinite(Date.parse(query.beforeCreatedAt));
  const validBeforeId = typeof query.beforeId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.beforeId);
  return {
    limit: Math.min(100, Math.max(1, rawLimit || 50)),
    offset: Math.min(5000, Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)),
    latest,
    beforeCreatedAt: validBeforeCreatedAt ? query.beforeCreatedAt : null,
    beforeId: validBeforeId ? query.beforeId : null,
    invalidCursor: cursorRequested && (!latest || !validBeforeCreatedAt || !validBeforeId)
  };
};

export const matchMessageHistoryOrder = latest => latest ? 'DESC' : 'ASC';

export const toChronologicalMessageHistory = (rows, latest) =>
  latest ? [...rows].reverse() : rows;
