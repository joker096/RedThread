import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMobileCorsHeaders } from './mobileAuthRoutes.js';

function responseHeaders() {
  const values = new Map();
  return {
    values,
    setHeader(name, value) { values.set(name.toLowerCase(), value); }
  };
}

test('trusted Capacitor origins may send the versioned voice consent headers', () => {
  const response = responseHeaders();
  assert.equal(applyMobileCorsHeaders('capacitor://localhost', response), true);
  const allowed = response.values.get('access-control-allow-headers')
    .split(',').map(value => value.trim().toLowerCase());
  assert.ok(allowed.includes('authorization'));
  assert.ok(allowed.includes('content-type'));
  assert.ok(allowed.includes('x-vow-voice-intro-consent'));
  assert.ok(allowed.includes('x-vow-voice-intro-consent-version'));
});

test('untrusted origins receive no mobile CORS permission', () => {
  const response = responseHeaders();
  assert.equal(applyMobileCorsHeaders('https://untrusted.example', response), false);
  assert.equal(response.values.has('access-control-allow-origin'), false);
});
