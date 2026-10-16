export const ASSESSMENT_VERSION = 1;

export const ASSESSMENT_QUESTIONS = [
  {
    id: 'relationshipGoal',
    category: 'Цели отношений',
    prompt: 'Какой формат отношений вы ищете?',
    options: [
      { value: 'marriage_soon', label: 'Брак и семья в ближайшие 1–3 года' },
      { value: 'marriage_later', label: 'Брак возможен, когда будем готовы' },
      { value: 'serious_no_rush', label: 'Серьёзные отношения без жёстких сроков' }
    ]
  },
  {
    id: 'children',
    category: 'Семья и дети',
    prompt: 'Как вы относитесь к детям?',
    options: [
      { value: 'want_soon', label: 'Хочу детей в обозримом будущем' },
      { value: 'want_later', label: 'Хочу, но позже' },
      { value: 'unsure', label: 'Пока не определился(-ась)' },
      { value: 'do_not_want', label: 'Не планирую детей' }
    ]
  },
  {
    id: 'financialModel',
    category: 'Деньги и вклад',
    prompt: 'Какая финансовая модель семьи вам ближе?',
    options: [
      { value: 'shared_equal', label: 'Общий бюджет и совместные решения' },
      { value: 'proportional', label: 'Вклад каждого по возможностям' },
      { value: 'provider_primary', label: 'Один партнёр — основной добытчик, второй вносит вклад по договорённости' },
      { value: 'provider_full', label: 'Один партнёр полностью обеспечивает семью' },
      { value: 'independent', label: 'Раздельные финансы, общие расходы обсуждаем' }
    ]
  },
  {
    id: 'lifestyleExpectation',
    category: 'Образ жизни',
    prompt: 'Насколько важен для вас высокий уровень трат, поездок и покупок?',
    options: [
      { value: 'modest', label: 'Комфортная жизнь без гонки за статусом' },
      { value: 'balanced', label: 'Баланс накоплений и приятных трат' },
      { value: 'premium', label: 'Высокий уровень комфорта и впечатлений очень важен' }
    ]
  },
  {
    id: 'gifts',
    category: 'Деньги и внимание',
    prompt: 'Какое значение для вас имеют подарки и материальные знаки внимания?',
    options: [
      { value: 'low', label: 'Не принципиальны; важнее забота и время' },
      { value: 'medium', label: 'Приятны, но в рамках возможностей' },
      { value: 'high', label: 'Это важный способ проявлять любовь' }
    ]
  },
  {
    id: 'household',
    category: 'Быт и ответственность',
    prompt: 'Как лучше распределять бытовые обязанности?',
    options: [
      { value: 'equal', label: 'Примерно поровну' },
      { value: 'strengths', label: 'По занятости, силам и договорённости' },
      { value: 'traditional', label: 'Традиционное распределение ролей' }
    ]
  },
  {
    id: 'fidelity',
    category: 'Доверие',
    prompt: 'Что для вас означает верность?',
    options: [
      { value: 'strict', label: 'Эксклюзивные отношения без романтических исключений' },
      { value: 'discussed', label: 'Границы заранее обсуждаем и соблюдаем' }
    ]
  },
  {
    id: 'conflictStyle',
    category: 'Общение',
    prompt: 'Как вы предпочитаете решать конфликты?',
    options: [
      { value: 'talk_soon', label: 'Спокойно обсудить после небольшой паузы' },
      { value: 'time_first', label: 'Сначала побыть одному/одной, затем обсудить' },
      { value: 'avoid', label: 'Предпочитаю не возвращаться к неприятным темам' }
    ]
  },
  {
    id: 'honesty',
    category: 'Честность',
    prompt: 'Насколько важно открыто говорить о намерениях и возможностях?',
    options: [
      { value: 'essential', label: 'Принципиально важно с самого начала' },
      { value: 'gradual', label: 'Открываюсь постепенно, по мере доверия' }
    ]
  }
] as const;

export type AssessmentAnswers = Record<string, string>;

const VALID_OPTIONS = new Map<string, Set<string>>(
  ASSESSMENT_QUESTIONS.map(question => [
    question.id,
    new Set<string>(question.options.map(option => option.value))
  ])
);

export function validateAssessmentAnswers(value: unknown): value is AssessmentAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const answers = value as Record<string, unknown>;
  const keys = Object.keys(answers);
  return keys.length === ASSESSMENT_QUESTIONS.length &&
    ASSESSMENT_QUESTIONS.every(question =>
      typeof answers[question.id] === 'string' &&
      VALID_OPTIONS.get(question.id)?.has(answers[question.id] as string)
    );
}

const WEIGHTS: Record<string, number> = {
  relationshipGoal: 2,
  children: 2,
  financialModel: 3,
  lifestyleExpectation: 1,
  gifts: 1,
  household: 1,
  fidelity: 2,
  conflictStyle: 1,
  honesty: 2
};

export function calculateAssessmentCompatibility(
  first: AssessmentAnswers,
  second: AssessmentAnswers
): { score: number; alignedCategories: string[]; differences: string[] } {
  let earned = 0;
  let possible = 0;
  const alignedCategories: string[] = [];
  const differences: string[] = [];

  for (const question of ASSESSMENT_QUESTIONS) {
    const weight = WEIGHTS[question.id] ?? 1;
    possible += weight;
    if (first[question.id] === second[question.id]) {
      earned += weight;
      alignedCategories.push(question.category);
    } else {
      differences.push(question.category);
    }
  }

  return {
    score: possible ? Math.round((earned / possible) * 100) : 0,
    alignedCategories,
    differences
  };
}

/**
 * This is a transparent preference-alignment signal, not a diagnosis or a fraud score.
 * It never labels a person as materialistic; it only identifies declared mismatches.
 */
export function getFinancialAlignment(
  first: AssessmentAnswers,
  second: AssessmentAnswers
): { score: number; differences: string[] } {
  const dimensions = ['financialModel', 'lifestyleExpectation', 'gifts'] as const;
  const differences = dimensions.filter(key => first[key] !== second[key]);
  return {
    score: Math.round(((dimensions.length - differences.length) / dimensions.length) * 100),
    differences
  };
}
