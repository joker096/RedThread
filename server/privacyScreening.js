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

// Optional free local LLM through Ollama. It contacts loopback only, never a configurable remote URL.
// Keep LOCAL_AI_ENABLED=false unless Ollama is installed on the same host.
const ALLOWED_AI_FLAGS = new Set([
  'possible_financial_scam', 'coercive_or_secretive_request', 'external_link',
  'contact_details', 'impersonation_claim', 'possible_harassment'
]);

async function classifyWithLocalModel(text, scope) {
  if (process.env.LOCAL_AI_ENABLED !== 'true') return null;
  const model = (process.env.LOCAL_AI_MODEL || 'qwen2.5:3b').trim().slice(0, 80);
  const prompt = [
    'You are a cautious safety classifier for a dating application.',
    'Classify only observable text signals; do not infer identity, gender, income, parenthood, honesty, or criminality.',
    'Return JSON only: {"flags":[{"code":"possible_financial_scam|coercive_or_secretive_request|external_link|contact_details|impersonation_claim|possible_harassment","severity":"low|high"}]}.',
    'Only flag clear textual indicators. Empty flags are preferred when uncertain. Never recommend automatic bans.',
    'Scope: ' + scope,
    'Untrusted text to classify:',
    String(text).slice(0, 4000)
  ].join('\\n');
  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const parsed = JSON.parse(payload.response || '{}');
    if (!Array.isArray(parsed.flags)) return null;
    return parsed.flags
      .filter(flag => flag && ALLOWED_AI_FLAGS.has(flag.code) && ['low', 'high'].includes(flag.severity))
      .map(flag => ({ code: flag.code, severity: flag.severity }));
  } catch {
    // Local model may be absent or starting up; the deterministic local rules still run.
    return null;
  }
}

export async function screenTextPrivate(text, scope = 'profile') {
  const rules = screenText(text, scope);
  const aiFlags = await classifyWithLocalModel(text, scope);
  const combined = [...new Map([...rules.flags, ...(aiFlags || [])].map(flag => [flag.code, flag])).values()];
  return {
    ...rules,
    engine: aiFlags === null ? 'local-rules-v1' : 'ollama-local+rules-v1',
    flags: combined,
    severity: combined.some(flag => flag.severity === 'high') ? 'high'
      : combined.some(flag => flag.severity === 'low') ? 'low'
      : combined.some(flag => flag.severity === 'info') ? 'info' : 'none',
    requiresReview: combined.some(flag => flag.severity === 'high'),
    localModelEnabled: process.env.LOCAL_AI_ENABLED === 'true',
    externalProcessing: false
  };
}

export async function screenProfilePrivate(profile) {
  const texts = [
    await screenTextPrivate(profile?.displayName || '', 'profile'),
    await screenTextPrivate(profile?.bio || '', 'profile'),
    await screenTextPrivate(profile?.country || '', 'profile'),
    await screenTextPrivate(profile?.city || '', 'profile'),
    await screenTextPrivate(profile?.occupation || '', 'occupation'),
    await screenTextPrivate(profile?.education || '', 'education')
  ];
  const flags = texts.flatMap(check => check.flags);
  if (profile?.hasChildren === false && ['with_me', 'shared_custody'].includes(profile?.childrenLivingArrangement)) {
    flags.push({ code: 'children_fields_inconsistent', severity: 'high' });
  }
  const uniqueFlags = [...new Map(flags.map(flag => [flag.code, flag])).values()];
  return {
    engine: process.env.LOCAL_AI_ENABLED === 'true' ? 'ollama-local+rules-v1' : 'local-rules-v1',
    externalProcessing: false,
    localModelEnabled: process.env.LOCAL_AI_ENABLED === 'true',
    flags: uniqueFlags,
    severity: uniqueFlags.some(flag => flag.severity === 'high') ? 'high'
      : uniqueFlags.some(flag => flag.severity === 'low') ? 'low'
      : uniqueFlags.some(flag => flag.severity === 'info') ? 'info' : 'none',
    requiresReview: uniqueFlags.some(flag => flag.severity === 'high')
  };
}
