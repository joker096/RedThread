import React from 'react';
import { describe, expect, it } from 'vitest';
import { normalizeGiftReceivingPayload } from './GiftReceivingPreferencesPanel';

describe('normalizeGiftReceivingPayload', () => {
  it('accepts an explicit boolean setting', () => {
    expect(normalizeGiftReceivingPayload({ requestsEnabled: true })).toEqual({ requestsEnabled: true });
    expect(normalizeGiftReceivingPayload({ requestsEnabled: false })).toEqual({ requestsEnabled: false });
  });
  it('fails closed for malformed or missing preference payloads', () => {
    expect(normalizeGiftReceivingPayload(null)).toEqual({ requestsEnabled: false });
    expect(normalizeGiftReceivingPayload({})).toEqual({ requestsEnabled: false });
    expect(normalizeGiftReceivingPayload({ requestsEnabled: 'true' })).toEqual({ requestsEnabled: false });
    expect(normalizeGiftReceivingPayload([])).toEqual({ requestsEnabled: false });
  });
});
