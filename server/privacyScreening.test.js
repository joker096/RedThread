import test from 'node:test';
import assert from 'node:assert/strict';
import { screenProfile, screenText } from './privacyScreening.js';
test('local screening flags suspicious money requests without returning raw text', () => {
 const result=screenText('Please send me money now, urgent transfer','message');
 assert.equal(result.externalProcessing,false); assert.equal(result.requiresReview,true);
 assert.ok(result.flags.some(flag=>flag.code==='possible_financial_scam')); assert.equal(Object.hasOwn(result,'text'),false);
});
test('links and contact details are flagged but not auto-banned', () => {
 const result=screenText('Contact user@example.com https://example.org','profile');
 assert.ok(result.flags.some(flag=>flag.code==='external_link')); assert.ok(result.flags.some(flag=>flag.code==='contact_details')); assert.equal(result.requiresReview,false);
});
test('contradictory child fields require human review', () => {
 const result=screenProfile({bio:'I enjoy reading books and hiking.',hasChildren:false,childrenLivingArrangement:'with_me'});
 assert.equal(result.requiresReview,true); assert.ok(result.flags.some(flag=>flag.code==='children_fields_inconsistent'));
});
test('ordinary profile text is not suspicious by default', () => {
 const result=screenProfile({bio:'Люблю путешествия, книги и спокойные вечера.',hasChildren:false,childrenLivingArrangement:'not_applicable'});
 assert.equal(result.requiresReview,false); assert.equal(result.externalProcessing,false);
});