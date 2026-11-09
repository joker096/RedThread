import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, isNativeVowApp } from './apiClient.ts';

test('browser API transport delegates to the current fetch implementation', async () => {
  assert.equal(isNativeVowApp(), false);
  const previousFetch = globalThis.fetch;
  let receivedInput: RequestInfo | URL | undefined;
  let receivedInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    receivedInput = input;
    receivedInit = init;
    return new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const response = await apiFetch('/api/auth/me', { credentials: 'include' });
    assert.equal(response.status, 200);
    assert.equal(receivedInput, '/api/auth/me');
    assert.equal(receivedInit?.credentials, 'include');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
