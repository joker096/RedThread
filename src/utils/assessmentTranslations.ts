import { ASSESSMENT_QUESTIONS } from './relationshipAssessment.ts';

const english: Record<string, { category: string; prompt: string; options: Record<string, string> }> = {
  relationshipGoal: { category: 'Relationship goals', prompt: 'What kind of relationship are you looking for?', options: { marriage_soon: 'Marriage and family within the next 1–3 years', marriage_later: 'Marriage when we are both ready', serious_no_rush: 'A serious relationship without a fixed deadline' }},
  children: { category: 'Family and children', prompt: 'How do you feel about having children?', options: { want_soon: 'I want children in the foreseeable future', want_later: 'I want children, but later', unsure: 'I have not decided yet', do_not_want: 'I do not plan to have children' }},
  financialModel: { category: 'Money and contribution', prompt: 'Which family financial model suits you best?', options: { shared_equal: 'Shared budget and joint decisions', proportional: 'Each contributes according to their means', provider_primary: 'One partner is the main earner; the other contributes by agreement', provider_full: 'One partner fully supports the family', independent: 'Separate finances, with shared expenses discussed together' }},
  lifestyleExpectation: { category: 'Lifestyle', prompt: 'How important are high spending, travel and shopping to you?', options: { modest: 'A comfortable life without chasing status', balanced: 'A balance between saving and enjoyable spending', premium: 'A high level of comfort and experiences is very important' }},
  gifts: { category: 'Money and attention', prompt: 'How important are gifts and material gestures of affection?', options: { low: 'Not essential; care and time matter more', medium: 'Nice, but within our means', high: 'An important way to express love' }},
  household: { category: 'Home and responsibility', prompt: 'How should household responsibilities be divided?', options: { equal: 'Roughly equally', strengths: 'According to workload, ability and mutual agreement', traditional: 'A traditional division of roles' }},
  fidelity: { category: 'Trust', prompt: 'What does fidelity mean to you?', options: { strict: 'Exclusive relationship without romantic exceptions', discussed: 'We discuss boundaries in advance and respect them' }},
  conflictStyle: { category: 'Communication', prompt: 'How do you prefer to resolve conflicts?', options: { talk_soon: 'Discuss calmly after a short break', time_first: 'Take some time alone first, then talk', avoid: 'I prefer not to revisit unpleasant topics' }},
  honesty: { category: 'Honesty', prompt: 'How important is it to speak openly about intentions and capabilities?', options: { essential: 'Essential from the beginning', gradual: 'I open up gradually as trust grows' }},
  trustRepair: { category: 'Rebuilding trust', prompt: 'What do you need if trust has been seriously broken?', options: { accountability_actions: 'Taking responsibility and consistent actions to repair the harm', time_transparency: 'Time, open conversation and agreed boundaries', not_reconcile: 'I do not continue a relationship after a serious breach' }},
  conflictSafety: { category: 'Safe communication', prompt: 'Which boundaries must be respected even during an argument?', options: { no_insults_control: 'No insults, threats, controlling behaviour or physical aggression', pause_then_talk: 'Take a break and return to the conversation without humiliation', learning_boundaries: 'Willingness to learn healthy communication and respect agreements' }},
  debtTransparency: { category: 'Debt and obligations', prompt: 'When should loans, debts and recurring financial obligations be discussed?', options: { open_before_commitment: 'Before a shared budget, major purchase or move', gradual_disclosure: 'Gradually, as trust develops', keep_separate: 'Keep finances separate and discuss details relevant to shared obligations' }},
  substanceLifestyle: { category: 'Habits and lifestyle', prompt: 'Which partner habits fit your lifestyle?', options: { no_smoking_no_drugs: 'No smoking or recreational drugs; no alcohol or very rare use', occasional_social: 'Rare social use is acceptable', flexible: 'Flexible, as long as it does not harm the relationship or health' }},
  relocation: { category: 'Where to live', prompt: 'Would you move for a life together?', options: { stay_local: 'I want to stay in my city or country', within_country: 'I would consider moving within my country', international: 'I would consider moving to another country', depends_on_plan: 'It depends on work, children and the concrete plan' }},
  caregiving: { category: 'Family responsibilities', prompt: 'How do you see helping parents or relatives if they need care?', options: { shared_care: 'Discuss and share the responsibility together', family_primary: 'Their own child takes primary responsibility, with partner support by agreement', professional_support: 'Use professional care where possible', case_by_case: 'Decide based on circumstances and capacity' }}
};

export function getLocalizedAssessmentQuestions(locale: string) {
  if (locale === 'ru') return ASSESSMENT_QUESTIONS;
  return ASSESSMENT_QUESTIONS.map(question => {
    const translated = english[question.id];
    if (!translated) return question;
    return { ...question, category: translated.category, prompt: translated.prompt,
      options: question.options.map(option => ({ ...option, label: translated.options[option.value] || option.label })) };
  });
}
