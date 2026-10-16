import test from 'node:test';
import assert from 'node:assert/strict';
import { moderateProfilePhoto } from './photoModeration.js';

const image = Buffer.from('test-image');

function mockFetch(result, status = 200) {
  return async (_url, options) => {
    assert.equal(_url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'llava:7b');
    assert.equal(body.messages[0].images[0], image.toString('base64'));
    return {
      ok: status >= 200 && status < 300,
      json: async () => ({ message: { content: JSON.stringify(result) } })
    };
  };
}

test('photo moderation stays pending unless explicitly enabled', async () => {
  const result = await moderateProfilePhoto(image, { enabled: false });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'disabled');
});

test('auto-approves only a high-confidence safe adult photo with no flags', async () => {
  const result = await moderateProfilePhoto(image, {
    enabled: true,
    model: 'llava:7b',
    fetchImpl: mockFetch({ decision: 'safe', confidence: 0.999, adultPersonVisible: true, flags: [] })
  });
  assert.equal(result.status, 'approved');
  assert.equal(result.engine, 'local-ollama-vision-v1');
});

test('rejects only high-confidence explicit unsafe content', async () => {
  const result = await moderateProfilePhoto(image, {
    enabled: true,
    model: 'llava:7b',
    fetchImpl: mockFetch({ decision: 'unsafe', confidence: 0.999, adultPersonVisible: true, flags: ['sexual_nudity'] })
  });
  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.flags, ['sexual_nudity']);
});

test('ambiguous or possible-minor images require human review', async () => {
  const result = await moderateProfilePhoto(image, {
    enabled: true,
    model: 'llava:7b',
    fetchImpl: mockFetch({ decision: 'uncertain', confidence: 0.999, adultPersonVisible: false, flags: ['possible_minor'] })
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'human_review_required');
});

test('model failures and malformed output fail closed to pending', async () => {
  const unavailable = await moderateProfilePhoto(image, {
    enabled: true,
    fetchImpl: async () => ({ ok: false, json: async () => ({}) })
  });
  assert.equal(unavailable.status, 'pending');
  assert.equal(unavailable.reason, 'model_unavailable');

  const malformed = await moderateProfilePhoto(image, {
    enabled: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) })
  });
  assert.equal(malformed.status, 'pending');
  assert.equal(malformed.reason, 'model_error');
});

test('invalid image inputs never reach the model', async () => {
  let called = false;
  const result = await moderateProfilePhoto(Buffer.alloc(0), {
    enabled: true,
    fetchImpl: async () => { called = true; throw new Error('should not be called'); }
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'invalid_image_input');
  assert.equal(called, false);
});
