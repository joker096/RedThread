export const normalizeMatchMessageHistoryOptions = (query = {}) => {
  const rawLimit = Number.parseInt(String(query.limit ?? '50'), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? '0'), 10);
  const latest = query.latest === 'true';
  const cursorRequested = query.beforeCreatedAt !== undefined || query.beforeId !== undefined;
  const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
  const timestampMatch = typeof query.beforeCreatedAt === 'string'
    ? timestampPattern.exec(query.beforeCreatedAt)
    : null;
  const year = timestampMatch ? Number(timestampMatch[1]) : 0;
  const month = timestampMatch ? Number(timestampMatch[2]) : 0;
  const day = timestampMatch ? Number(timestampMatch[3]) : 0;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  const validBeforeCreatedAt = Boolean(timestampMatch && year > 0 && month >= 1 &&
    month <= 12 && day >= 1 && day <= daysInMonth &&
    Number.isFinite(Date.parse(query.beforeCreatedAt)));
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
