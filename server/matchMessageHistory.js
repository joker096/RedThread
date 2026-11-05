export const normalizeMatchMessageHistoryOptions = (query = {}) => {
  const rawLimit = Number.parseInt(String(query.limit ?? '50'), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? '0'), 10);
  return {
    limit: Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50)),
    offset: Math.min(5000, Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0)),
    latest: query.latest === 'true'
  };
};

export const matchMessageHistoryOrder = latest => latest ? 'DESC' : 'ASC';

export const toChronologicalMessageHistory = (rows, latest) =>
  latest ? [...rows].reverse() : rows;
