// Privacy-first automated screening. No network calls and no raw text persistence.
// This is a rules engine, not a truth detector or a substitute for human review.
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/iu;
const CONTACT_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\+?\d[\d\s().-]{7,}\d)/iu;
const REPEATED_TEXT_PATTERN = /(.)\1{7,}/u;
const SCAM_PATTERN = /\b(?:send\s+me\s+money|gift\s+card|crypto\s+investment|guaranteed\s+profit|мгновенн(?:ый|ая)\s+доход|переведи\s+деньги|подарочн(?:ая|ые)\s+карт(?:а|ы)|инвестици(?:я|и)\s+с\s+гарантией)\b/iu;
const PRESSURE_PATTERN = /\b(?:send\s+money\s+now|urgent\s+transfer|срочно\s+переведи|никому\s+не\s+говори|не\s+говори\s+модераторам)\b/iu;
export function screenText(text, scope = 'profile') {
  const value = typeof text === 'string' ? text.trim() : '';
  const flags = [];
  if (value && URL_PATTERN.test(value)) flags.push({ code: 'external_link', severity: 'low' });
  if (value && CONTACT_PATTERN.test(value)) flags.push({ code: 'contact_details', severity: 'low' });
  if (value && REPEATED_TEXT_PATTERN.test(value)) flags.push({ code: 'repetitive_text', severity: 'low' });
  if (value && SCAM_PATTERN.test(value)) flags.push({ code: 'possible_financial_scam', severity: 'high' });
  if (value && PRESSURE_PATTERN.test(value)) flags.push({ code: 'coercive_or_secretive_request', severity: 'high' });
  if (scope === 'profile' && value && value.length < 12) flags.push({ code: 'very_short_profile_text', severity: 'info' });
  const rank = { info: 0, low: 1, high: 2 };
  const severity = flags.reduce((current, flag) => rank[flag.severity] > rank[current] ? flag.severity : current, 'none');
  return { engine: 'local-rules-v1', scope, checked: true, externalProcessing: false, flags, severity, requiresReview: flags.some(flag => flag.severity === 'high'), sourceLength: value.length };
}
export function screenProfile(profile) {
  const checks = [screenText(profile?.bio || '', 'profile'), screenText(profile?.occupation || '', 'occupation'), screenText(profile?.education || '', 'education')];
  const flags = checks.flatMap(check => check.flags);
  if (profile?.hasChildren === false && ['with_me', 'shared_custody'].includes(profile?.childrenLivingArrangement)) {
    flags.push({ code: 'children_fields_inconsistent', severity: 'high' });
  }
  const uniqueFlags = [...new Map(flags.map(flag => [flag.code, flag])).values()];
  return { engine: 'local-rules-v1', externalProcessing: false, flags: uniqueFlags, severity: uniqueFlags.some(flag => flag.severity === 'high') ? 'high' : uniqueFlags.some(flag => flag.severity === 'low') ? 'low' : uniqueFlags.some(flag => flag.severity === 'info') ? 'info' : 'none', requiresReview: uniqueFlags.some(flag => flag.severity === 'high') };
}