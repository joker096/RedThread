import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePartnerCountry,
  isPartnerServiceCategory,
  isPartnerServiceCurrency
} from './partnerServicePolicy.js';

test('partner country filters accept ISO alpha-2 codes only', () => {
  assert.equal(normalizePartnerCountry(' ge '), 'GE');
  assert.equal(normalizePartnerCountry('RU'), 'RU');
  assert.equal(normalizePartnerCountry('Грузия'), null);
  assert.equal(normalizePartnerCountry('Georgia'), null);
  assert.equal(normalizePartnerCountry('OTHER'), null);
  assert.equal(normalizePartnerCountry(null), null);
});

test('partner categories cover every category exposed by the marketplace', () => {
  for (const category of ['cafe', 'photography', 'videography', 'venue', 'beauty', 'legal', 'transport', 'dress', 'host', 'other']) {
    assert.equal(isPartnerServiceCategory(category), true, category);
  }
  assert.equal(isPartnerServiceCategory('wedding'), false);
  assert.equal(isPartnerServiceCategory(''), false);
});

test('partner prices accept only supported currencies', () => {
  for (const currency of ['USD', 'GEL', 'EUR', 'RUB', 'KZT', 'AMD']) assert.equal(isPartnerServiceCurrency(currency), true);
  assert.equal(isPartnerServiceCurrency('BTC'), false);
});
