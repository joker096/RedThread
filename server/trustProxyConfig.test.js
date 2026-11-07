import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveTrustProxyHops } from './trustProxyConfig.js';

test('proxy hop configuration defaults to direct mode', () => {
  assert.equal(resolveTrustProxyHops(undefined), 0);
  assert.equal(resolveTrustProxyHops(null), 0);
  assert.equal(resolveTrustProxyHops(''), 0);
  assert.equal(resolveTrustProxyHops('0'), 0);
});

test('proxy hop configuration accepts bounded integer hop counts', () => {
  for (const value of ['1', '2', '5']) {
    assert.equal(resolveTrustProxyHops(value), Number(value));
  }
});

test('proxy hop configuration rejects ambiguous and unsafe values', () => {
  for (const value of ['true', 'false', '1.5', '-1', '6', '1,2', ' 1 ', '01', '999999999999999999999']) {
    assert.throws(() => resolveTrustProxyHops(value), /invalid_trust_proxy_hops/);
  }
});

test('Compose and Nginx use the documented single trusted proxy topology', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const nginx = await readFile(new URL('../docker/nginx.conf', import.meta.url), 'utf8');
  const apiStart = compose.indexOf('\n  api:');
  const webStart = compose.indexOf('\n  web:', apiStart);
  assert.ok(apiStart >= 0 && webStart > apiStart, 'API and web services must be present');
  const apiService = compose.slice(apiStart, webStart);
  assert.match(apiService, /TRUST_PROXY_HOPS: \$\{TRUST_PROXY_HOPS:-1\}/);
  assert.doesNotMatch(apiService, /^\s+ports:/m, 'the API must not be published directly');
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/,
    'Nginx must append the address it observed to the forwarded chain');
});
