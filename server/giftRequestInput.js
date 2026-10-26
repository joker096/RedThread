const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const ALLOWED_KEYS = new Set(['matchId', 'catalogItemId', 'idempotencyKey']);

export function normalizeGiftRequestInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalid('invalid_body');
  }

  const keys = Object.keys(body);
  if (keys.some(key => !ALLOWED_KEYS.has(key))) {
    // In particular, never accept recipient IDs, delivery location, address, phone,
    // email, price, status, consent, or payment fields from the sender.
    return invalid('unexpected_field');
  }

  if (typeof body.matchId !== 'string' || !UUID_PATTERN.test(body.matchId)) {
    return invalid('invalid_match_id', 'matchId');
  }
  if (typeof body.catalogItemId !== 'string' || !UUID_PATTERN.test(body.catalogItemId)) {
    return invalid('invalid_catalog_item_id', 'catalogItemId');
  }
  if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(body.idempotencyKey)) {
    return invalid('invalid_idempotency_key', 'idempotencyKey');
  }

  return {
    ok: true,
    value: {
      matchId: body.matchId.toLowerCase(),
      catalogItemId: body.catalogItemId.toLowerCase(),
      idempotencyKey: body.idempotencyKey
    }
  };
}

function invalid(error, field) {
  return { ok: false, error, ...(field ? { field } : {}) };
}
