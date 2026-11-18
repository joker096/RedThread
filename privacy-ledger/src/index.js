const EVENT_TYPES = new Set([
  "account_erasure_requested",
  "voice_intro_consent_withdrawn",
  "voice_intro_erasure_requested",
  "private_photo_erasure_requested",
  "identity_l3_consent_withdrawn",
  "ad_consent_revoked",
  "gift_order_consent_withdrawn",
  "gift_address_draft_consent_withdrawn"
]);
const MAX_BODY_BYTES = 4096;
const MAX_CLOCK_SKEW_SECONDS = 300;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function readBoundedBody(request, maxBytes) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel("request_too_large").catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
  if (value.event_type === 'gift_address_draft_consent_withdrawn' &&
      (typeof value.resource_ref !== 'string' || !/^[a-f0-9]{64}$/i.test(value.resource_ref))) return false;
  if (typeof value.subject_ref !== "string" || !/^[a-f0-9]{64}$/i.test(value.subject_ref)) return false;
  if (value.resource_ref !== undefined && (typeof value.resource_ref !== "string" || !/^[a-f0-9]{64}$/i.test(value.resource_ref))) return false;
  if (typeof value.occurred_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.occurred_at)) return false;
  return Number.isFinite(Date.parse(value.occurred_at));
}


const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SNAPSHOT_BARRIER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validSnapshotBarrierRequest(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every(key => ["snapshot_id", "barrier_id"].includes(key)) &&
    typeof value.snapshot_id === "string" && SNAPSHOT_ID_PATTERN.test(value.snapshot_id) &&
    typeof value.barrier_id === "string" && SNAPSHOT_BARRIER_ID_PATTERN.test(value.barrier_id));
}

async function signedBarrierProof(env, row) {
  if (typeof env.LEDGER_PROOF_PRIVATE_KEY !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(env.LEDGER_PROOF_PRIVATE_KEY)) {
    throw new Error("snapshot_barrier_proof_key_not_configured");
  }
  const binary = atob(env.LEDGER_PROOF_PRIVATE_KEY);
  const privateKeyBytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", privateKeyBytes, { name: "Ed25519" }, false, ["sign"]
  );
  const proof = {
    barrier_id: row.barrier_id,
    snapshot_id: row.snapshot_id,
    ledger_sequence: row.ledger_sequence,
    status: row.status,
    created_at: row.created_at,
    released_at: row.released_at ?? null
  };
  const signed = await crypto.subtle.sign(
    "Ed25519", privateKey, new TextEncoder().encode(JSON.stringify(proof))
  );
  return { ...proof, signature: hex(signed) };
}

export async function handleRequest(request, env) {
  if (!env?.LEDGER_DB || !env?.LEDGER_HMAC_SECRET) return json({ error: "ledger_not_configured" }, 503);
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/v1/events") {
    const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
    if (rawBody === null) return json({ error: "request_too_large" }, 413);
    if (!await authenticate(request, env, rawBody)) return json({ error: "unauthorized" }, 401);
    let event;
    try { event = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }
    if (!validEvent(event)) return json({ error: "invalid_event" }, 400);
    const payloadHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)));
    try {
      const inserted = await env.LEDGER_DB.prepare(
        `INSERT INTO privacy_events
          (event_id, schema_version, event_type, subject_ref, resource_ref, occurred_at, received_at, payload_sha256)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM privacy_snapshot_barriers WHERE status = 'active')`
      ).bind(
        event.event_id, event.schema_version, event.event_type, event.subject_ref,
        event.resource_ref ?? null, event.occurred_at, new Date().toISOString(), payloadHash
      ).run();
      if (inserted?.meta?.changes === 1) {
        const row = await env.LEDGER_DB.prepare("SELECT sequence FROM privacy_events WHERE event_id = ?")
          .bind(event.event_id).first();
        return json({ accepted: true, duplicate: false, event_id: event.event_id, sequence: row.sequence }, 201);
      }
      const existing = await env.LEDGER_DB.prepare(
        "SELECT sequence, payload_sha256 FROM privacy_events WHERE event_id = ?"
      ).bind(event.event_id).first();
      if (existing) {
        if (existing.payload_sha256 !== payloadHash) return json({ error: "event_id_conflict" }, 409);
        return json({ accepted: true, duplicate: true, event_id: event.event_id, sequence: existing.sequence }, 200);
      }
      const activeBarrier = await env.LEDGER_DB.prepare(
        "SELECT barrier_id FROM privacy_snapshot_barriers WHERE status = 'active' LIMIT 1"
      ).first();
      if (activeBarrier) return json({ error: "snapshot_barrier_active" }, 423);
      return json({ error: "ledger_write_failed" }, 503);
    } catch (error) {
      const existing = await env.LEDGER_DB.prepare(
        "SELECT sequence, payload_sha256 FROM privacy_events WHERE event_id = ?"
      ).bind(event.event_id).first();
      if (existing) {
        if (existing.payload_sha256 !== payloadHash) return json({ error: "event_id_conflict" }, 409);
        return json({ accepted: true, duplicate: true, event_id: event.event_id, sequence: existing.sequence }, 200);
      }
      return json({ error: "ledger_write_failed" }, 503);
    }
  }


  if (request.method === "POST" && url.pathname === "/v1/snapshot-barriers") {
    const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
    if (rawBody === null) return json({ error: "request_too_large" }, 413);
    if (!await authenticate(request, env, rawBody)) return json({ error: "unauthorized" }, 401);
    let input;
    try { input = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }
    if (!validSnapshotBarrierRequest(input)) return json({ error: "invalid_snapshot_barrier" }, 400);
    if (!env.LEDGER_PROOF_PRIVATE_KEY) return json({ error: "snapshot_barrier_proof_key_not_configured" }, 503);
    const createdAt = new Date().toISOString();
    let inserted;
    let row;
    try {
      inserted = await env.LEDGER_DB.prepare(
        "INSERT INTO privacy_snapshot_barriers " +
        "(barrier_id, snapshot_id, status, ledger_sequence, created_at, released_at) " +
        "SELECT ?, ?, 'active', COALESCE((SELECT MAX(sequence) FROM privacy_events), 0), ?, NULL " +
        "WHERE NOT EXISTS (SELECT 1 FROM privacy_snapshot_barriers WHERE status = 'active')"
      ).bind(input.barrier_id, input.snapshot_id, createdAt).run();
      row = await env.LEDGER_DB.prepare(
        "SELECT barrier_id, snapshot_id, status, ledger_sequence, created_at, released_at " +
        "FROM privacy_snapshot_barriers WHERE snapshot_id = ?"
      ).bind(input.snapshot_id).first();
    } catch {
      const existing = await env.LEDGER_DB.prepare(
        "SELECT barrier_id, status FROM privacy_snapshot_barriers WHERE snapshot_id = ?"
      ).bind(input.snapshot_id).first();
      if (existing) return json({ error: "snapshot_barrier_snapshot_id_reused" }, 409);
      const active = await env.LEDGER_DB.prepare(
        "SELECT barrier_id FROM privacy_snapshot_barriers WHERE status = 'active' LIMIT 1"
      ).first();
      return active ? json({ error: "snapshot_barrier_already_active" }, 409)
        : json({ error: "snapshot_barrier_write_failed" }, 503);
    }
    if (!row || row.barrier_id !== input.barrier_id || row.status !== "active") {
      return json({ error: "snapshot_barrier_conflict" }, 409);
    }
    let proof;
    try { proof = await signedBarrierProof(env, row); }
    catch { return json({ error: "snapshot_barrier_proof_signing_failed" }, 503); }
    return json({ accepted: true, duplicate: inserted?.meta?.changes !== 1, ...proof },
      inserted?.meta?.changes === 1 ? 201 : 200);
  }

  const releaseMatch = url.pathname.match(/^\/v1\/snapshot-barriers\/([0-9a-f-]{36})\/release$/i);
  if (request.method === "POST" && releaseMatch) {
    const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
    if (rawBody === null) return json({ error: "request_too_large" }, 413);
    if (!await authenticate(request, env, rawBody)) return json({ error: "unauthorized" }, 401);
    let input;
    try { input = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || typeof input.snapshot_id !== "string" ||
        !SNAPSHOT_ID_PATTERN.test(input.snapshot_id)) {
      return json({ error: "invalid_snapshot_barrier_release" }, 400);
    }
    if (!env.LEDGER_PROOF_PRIVATE_KEY) return json({ error: "snapshot_barrier_proof_key_not_configured" }, 503);
    const barrierId = releaseMatch[1];
    if (!SNAPSHOT_BARRIER_ID_PATTERN.test(barrierId)) return json({ error: "invalid_snapshot_barrier_id" }, 400);
    const current = await env.LEDGER_DB.prepare(
      "SELECT barrier_id, snapshot_id, status, ledger_sequence, created_at, released_at FROM privacy_snapshot_barriers WHERE barrier_id = ?"
    ).bind(barrierId).first();
    if (!current) return json({ error: "snapshot_barrier_not_found" }, 404);
    if (current.snapshot_id !== input.snapshot_id) return json({ error: "snapshot_barrier_identity_conflict" }, 409);
    let row = current;
    if (current.status === "active") {
      const releasedAt = new Date().toISOString();
      await env.LEDGER_DB.prepare(
        "UPDATE privacy_snapshot_barriers SET status = 'released', released_at = ? WHERE barrier_id = ? AND snapshot_id = ? AND status = 'active'"
      ).bind(releasedAt, barrierId, input.snapshot_id).run();
      row = await env.LEDGER_DB.prepare(
        "SELECT barrier_id, snapshot_id, status, ledger_sequence, created_at, released_at FROM privacy_snapshot_barriers WHERE barrier_id = ?"
      ).bind(barrierId).first();
    }
    if (!row || row.status !== "released" || !row.released_at) {
      return json({ error: "snapshot_barrier_release_conflict" }, 409);
    }
    const proof = await signedBarrierProof(env, row);
    return json({ accepted: true, ...proof }, 200);
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
