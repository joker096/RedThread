const EVENT_TYPES = new Set([
  "account_erasure_requested",
  "voice_intro_consent_withdrawn",
  "voice_intro_erasure_requested",
  "private_photo_erasure_requested",
  "identity_l3_consent_withdrawn",
  "ad_consent_revoked",
  "gift_order_consent_withdrawn"
]);
const MAX_BODY_BYTES = 4096;
const MAX_CLOCK_SKEW_SECONDS = 300;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), part => Number.parseInt(part, 16));
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function signature(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function authenticate(request, env, signedPayload) {
  if (typeof env.LEDGER_HMAC_SECRET !== "string" || env.LEDGER_HMAC_SECRET.length < 32) return false;
  const timestamp = request.headers.get("x-ledger-timestamp");
  const supplied = fromHex(request.headers.get("x-ledger-signature"));
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !supplied) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = await signature(env.LEDGER_HMAC_SECRET, `${timestamp}. ${signedPayload}`.replace(". ", "."));
  return constantTimeEqual(expected, supplied);
}

function validEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = ["event_id", "schema_version", "event_type", "subject_ref", "resource_ref", "occurred_at"];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (Object.keys(value).length !== 5 + (value.resource_ref === undefined ? 0 : 1)) return false;
  if (typeof value.event_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.event_id)) return false;
  if (value.schema_version !== 1 || !EVENT_TYPES.has(value.event_type)) return false;
  if (typeof value.subject_ref !== "string" || !/^[a-f0-9]{64}$/i.test(value.subject_ref)) return false;
  if (value.resource_ref !== undefined && (typeof value.resource_ref !== "string" || !/^[a-f0-9]{64}$/i.test(value.resource_ref))) return false;
  if (typeof value.occurred_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.occurred_at)) return false;
  return Number.isFinite(Date.parse(value.occurred_at));
}

export async function handleRequest(request, env) {
  if (!env?.LEDGER_DB || !env?.LEDGER_HMAC_SECRET) return json({ error: "ledger_not_configured" }, 503);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/v1/events") {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: "request_too_large" }, 413);
    if (!await authenticate(request, env, rawBody)) return json({ error: "unauthorized" }, 401);
    let event;
    try { event = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }
    if (!validEvent(event)) return json({ error: "invalid_event" }, 400);
    const payloadHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)));
    try {
      await env.LEDGER_DB.prepare(
        `INSERT INTO privacy_events
          (event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at, payload_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        event.event_id, event.schema_version, event.event_type, event.subject_ref,
        event.resource_ref ?? null, event.occurred_at, new Date().toISOString(), payloadHash
      ).run();
      const row = await env.LEDGER_DB.prepare("SELECT sequence FROM privacy_events WHERE event_id = ?")
        .bind(event.event_id).first();
      return json({ accepted: true, duplicate: false, sequence: row.sequence }, 201);
    } catch (error) {
      const existing = await env.LEDGER_DB.prepare(
        "SELECT sequence, payload_sha256 FROM privacy_events WHERE event_id = ?"
      ).bind(event.event_id).first();
      if (existing) {
        if (existing.payload_sha256 !== payloadHash) return json({ error: "event_id_conflict" }, 409);
        return json({ accepted: true, duplicate: true, sequence: existing.sequence }, 200);
      }
      return json({ error: "ledger_write_failed" }, 503);
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/events") {
    const after = url.searchParams.get("after") ?? "0";
    const limit = url.searchParams.get("limit") ?? "200";
    const through = url.searchParams.get("through");
    if (!/^\d+$/.test(after) || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 500 ||
        (through !== null && (!/^\d+$/.test(through) || Number(through) < Number(after)))) {
      return json({ error: "invalid_pagination" }, 400);
    }
    if (![Number(after), Number(limit), ...(through === null ? [] : [Number(through)])].every(Number.isSafeInteger)) {
      return json({ error: "invalid_pagination" }, 400);
    }
    const signedPath = "GET\n" + url.pathname + url.search;
    if (!await authenticate(request, env, signedPath)) return json({ error: "unauthorized" }, 401);
    try {
      const current = await env.LEDGER_DB.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM privacy_events"
      ).first();
      const watermark = through === null ? current.sequence : Number(through);
      if (watermark > current.sequence) return json({ error: "watermark_not_available" }, 409);
      const page = await env.LEDGER_DB.prepare(
        "SELECT sequence, event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at " +
        "FROM privacy_events WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?"
      ).bind(Number(after), watermark, Number(limit)).all();
      return json({ events: page.results ?? [], next_after: page.results?.at(-1)?.sequence ?? Number(after), watermark });
    } catch {
      return json({ error: "ledger_read_failed" }, 503);
    }
  }

  return json({ error: "not_found" }, 404);
}

export default { fetch: handleRequest };
