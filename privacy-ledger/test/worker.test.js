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
