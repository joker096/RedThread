import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.js";

const secret = "test-secret-that-is-at-least-thirty-two-bytes";
const env = { LEDGER_HMAC_SECRET: secret, LEDGER_DB: {} };

async function signedRequest(method, url, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = method === "POST" ? body : `GET\n${new URL(url).pathname}${new URL(url).search}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  const signature = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  return new Request(url, { method, body: method === "POST" ? body : undefined, headers: { "x-ledger-timestamp": timestamp, "x-ledger-signature": signature } });
}

test("ledger fails closed when database binding is absent", async () => {
  const response = await handleRequest(new Request("https://ledger.test/v1/events"), { LEDGER_HMAC_SECRET: secret });
  assert.equal(response.status, 503);
});

test("ledger rejects unsigned writes", async () => {
  const response = await handleRequest(new Request("https://ledger.test/v1/events", { method: "POST", body: "{}" }), env);
  assert.equal(response.status, 401);
});

test("ledger rejects stale signed requests", async () => {
  const request = new Request("https://ledger.test/v1/events", {
    method: "POST",
    body: "{}",
    headers: { "x-ledger-timestamp": "1000000000", "x-ledger-signature": "0".repeat(64) }
  });
  const response = await handleRequest(request, env);
  assert.equal(response.status, 401);
});

test("ledger rejects unknown routes and malformed pagination", async () => {
  const unknown = await handleRequest(new Request("https://ledger.test/nope"), env);
  assert.equal(unknown.status, 404);
  const malformed = await signedRequest("GET", "https://ledger.test/v1/events?after=-1&limit=100");
  const response = await handleRequest(malformed, env);
  assert.equal(response.status, 400);
});

test("ledger rejects oversized event payloads before database access", async () => {
  const body = " ".repeat(4097);
  const request = await signedRequest("POST", "https://ledger.test/v1/events", body);
  const response = await handleRequest(request, env);
  assert.equal(response.status, 413);
});

class FakeLedgerDb {
  constructor() { this.rows = []; this.sequence = 0; }
  prepare(sql) {
    const db = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async run() {
        if (sql.includes("INSERT INTO privacy_events")) {
          const [eventId, schemaVersion, eventType, subjectRef, resourceRef, occurredAt, receivedAt, payloadHash] = this.values;
          if (db.rows.some(row => row.event_id === eventId)) throw new Error("unique constraint");
          db.rows.push({
            sequence: ++db.sequence, event_id: eventId, schema_version: schemaVersion,
            event_type: eventType, subject_ref: subjectRef, resource_ref: resourceRef,
            occurred_at: occurredAt, received_at: receivedAt, payload_sha256: payloadHash
          });
          return { success: true };
        }
        if (sql.includes("UPDATE privacy_events") || sql.includes("DELETE FROM privacy_events")) throw new Error("append-only");
        return { success: true };
      },
      async first() {
        if (sql.includes("WHERE event_id = ?")) return db.rows.find(row => row.event_id === this.values[0]) ?? null;
        if (sql.includes("MAX(sequence)")) return { sequence: db.sequence };
        return null;
      },
      async all() {
        if (sql.includes("FROM privacy_events WHERE sequence > ? AND sequence <= ?")) {
          const [after, through, limit] = this.values;
          return { results: db.rows.filter(row => row.sequence > after && row.sequence <= through).slice(0, limit).map(({ payload_sha256, ...row }) => row) };
        }
        return { results: [] };
      }
    };
  }
}

function eventPayload(overrides = {}) {
  return JSON.stringify({
    event_id: "123e4567-e89b-42d3-a456-426614174000",
    schema_version: 1,
    event_type: "account_erasure_requested",
    subject_ref: "a".repeat(64),
    occurred_at: "2026-11-14T07:00:00.000Z",
    ...overrides
  });
}

test("ledger appends a valid event and returns a durable sequence", async () => {
  const db = new FakeLedgerDb();
  const body = eventPayload();
  const request = await signedRequest("POST", "https://ledger.test/v1/events", body);
  const response = await handleRequest(request, { ...env, LEDGER_DB: db });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false, sequence: 1 });
  assert.equal(db.rows.length, 1);
});

test("ledger append is idempotent and rejects event ID payload conflicts", async () => {
  const db = new FakeLedgerDb();
  const body = eventPayload();
  const first = await handleRequest(await signedRequest("POST", "https://ledger.test/v1/events", body), { ...env, LEDGER_DB: db });
  const duplicate = await handleRequest(await signedRequest("POST", "https://ledger.test/v1/events", body), { ...env, LEDGER_DB: db });
  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  const conflictBody = eventPayload({ event_type: "voice_intro_consent_withdrawn" });
  const conflict = await handleRequest(await signedRequest("POST", "https://ledger.test/v1/events", conflictBody), { ...env, LEDGER_DB: db });
  assert.equal(conflict.status, 409);
  assert.equal(db.rows.length, 1);
});

test("ledger pagination is authenticated and exposes a stable watermark", async () => {
  const db = new FakeLedgerDb();
  const body = eventPayload();
  await handleRequest(await signedRequest("POST", "https://ledger.test/v1/events", body), { ...env, LEDGER_DB: db });
  const url = "https://ledger.test/v1/events?after=0&limit=10";
  const response = await handleRequest(await signedRequest("GET", url), { ...env, LEDGER_DB: db });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.events.length, 1);
  assert.equal(page.next_after, 1);
  assert.equal(page.watermark, 1);
  assert.equal("payload_sha256" in page.events[0], false);
});


test("ledger export pagination remains pinned to its first watermark", async () => {
  const db = new FakeLedgerDb();
  const firstEvent = eventPayload();
  await handleRequest(await signedRequest("POST", "https://ledger.test/v1/events", firstEvent), { ...env, LEDGER_DB: db });
  const firstUrl = "https://ledger.test/v1/events?after=0&limit=1";
  const first = await handleRequest(await signedRequest("GET", firstUrl), { ...env, LEDGER_DB: db });
  const firstPage = await first.json();
  assert.equal(firstPage.watermark, 1);

  const secondEvent = eventPayload({ event_id: "123e4567-e89b-42d3-b456-426614174001", event_type: "private_photo_erasure_requested" });
  await handleRequest(await signedRequest("POST", "https://ledger.test/v1/events", secondEvent), { ...env, LEDGER_DB: db });
  const nextUrl = "https://ledger.test/v1/events?after=1&limit=1&through=1";
  const next = await handleRequest(await signedRequest("GET", nextUrl), { ...env, LEDGER_DB: db });
  const nextPage = await next.json();
  assert.equal(nextPage.watermark, 1);
  assert.deepEqual(nextPage.events, []);
  assert.equal(nextPage.next_after, 1);
});

test("ledger rejects a requested watermark that is not yet available", async () => {
  const db = new FakeLedgerDb();
  const url = "https://ledger.test/v1/events?after=0&limit=10&through=2";
  const response = await handleRequest(await signedRequest("GET", url), { ...env, LEDGER_DB: db });
  assert.equal(response.status, 409);
});
