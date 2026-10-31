import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentDiscoverySearchResponse, isSafeProfilePhotoUrl } from './ServerDiscoveryPanel.tsx';

test('server profile photos must use private same-origin photo assets', () => {
  assert.equal(
    isSafeProfilePhotoUrl('/api/photos/123e4567-e89b-12d3-a456-426614174000'),
    true
  );
  for (const value of [
    'https://tracker.example/photo.jpg',
    'http://images.example/photo.jpg',
    '//tracker.example/photo.jpg',
    '/uploads/private/photo.jpg',
    '/api/photos/not-a-uuid',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    ' /api/photos/123e4567-e89b-12d3-a456-426614174000',
    '/api/photos/123e4567-e89b-12d3-a456-426614174000?track=1'
  ]) {
    assert.equal(isSafeProfilePhotoUrl(value), false, String(value));
  }
});

test('discovery ignores a response parsed after a newer search or account session starts', () => {
  assert.equal(isCurrentDiscoverySearchResponse(4, 4, 2, 2), true);
  assert.equal(isCurrentDiscoverySearchResponse(4, 5, 2, 2), false,
    'a newer filter/search request invalidates the earlier response');
  assert.equal(isCurrentDiscoverySearchResponse(4, 4, 2, 3), false,
    'a session switch invalidates a response even when its body resolves later');
  assert.equal(isCurrentDiscoverySearchResponse(0, 0, 2, 2), false);
  assert.equal(isCurrentDiscoverySearchResponse(4, 4, Number.NaN, 2), false);
});
