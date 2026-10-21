import React, { useEffect, useRef, useState } from 'react';
import { 
  Brain, 
  CheckCircle2, 
  Sparkles, 
  ShieldCheck, 
  Heart, 
  Crown, 
  Flame, 
  ArrowRight, 
  Users, 
  Baby, 
  Home, 
  DollarSign, 
  Compass, 
  Check, 
  Lock,
  RotateCcw
} from 'lucide-react';
import type { Gender, UserProfile } from '../types/index.ts';

interface QuestionItem {
  id: string;
  text: string;
  options: { label: string; score: number; trait: string }[];
}

interface TestItem {
  id: string;
  title: string;
  category: string;
  description: string;
  targetGender: Gender;
  estimatedMinutes: number;
  icon: 'family' | 'finance' | 'heart' | 'home';
  completedScore?: number;
  completedResult?: string;
  questions: QuestionItem[];
}

// Tests specifically tailored for Men (Женихи / Мужчины)
const maleTests: TestItem[] = [
  {
    id: 'male_head_of_family',
    title: 'Глава семьи и Отец',
    category: 'Ответственность и Зрелость',
    description: 'Определяет готовность мужчины к роли главы семьи, защите жены и детей, и принятию взвешенных решений в кризисах.',
    targetGender: 'male',
    estimatedMinutes: 2,
    icon: 'family',
    completedScore: 97,
    completedResult: 'Архетип «Опора и Защитник»: высокая надежность, готовность к детям в 1-2 года.',
    questions: [
      {
        id: 'm1',
        text: 'Какова ваша главная роль в будущем браке?',
        options: [
          { label: 'Быть каменной стеной, защищать семью и закрывать базовые потребности', score: 100, trait: 'Традиционный лидер' },
          { label: 'Равный партнер в быту и финансах 50/50', score: 75, trait: 'Партнерский союз' },
          { label: 'Пока не думал об этом, главное чтобы было весело', score: 35, trait: 'Незрелая позиция' }
        ]
      },
      {
        id: 'm2',
        text: 'Когда вы готовы к рождению детей?',
        options: [
          { label: 'В течение 1-2 лет после брака, финансово и морально готов', score: 100, trait: 'Готов к отцовству' },
          { label: 'Через 4-5 лет, нужно пожить для себя', score: 70, trait: 'Отложенный срок' },
          { label: 'Не хочу детей (childfree)', score: 30, trait: 'Не подходит для семейного формата' }
        ]
      },
      {
        id: 'm3',
        text: 'Как вы решаете вопрос жилья для семьи?',
        options: [
          { label: 'Уже есть своя квартира / строю загородный дом для семьи', score: 100, trait: 'Жилищная автономия' },
          { label: 'Арендуем комфортное жилье / планирую ипотеку в ближайшее время', score: 85, trait: 'Развивающийся статус' },
          { label: 'Будем жить с моими или ее родителями', score: 50, trait: 'Зависимость' }
        ]
      }
    ]
  },
  {
    id: 'male_finance_provider',
    title: 'Финансовая опора и Бюджет',
    category: 'Обеспечение',
    description: 'Определяет подход мужчины к заработку, стабильности и финансовой безопасности будущей супруги и детей.',
    targetGender: 'male',
    estimatedMinutes: 2,
    icon: 'finance',
    completedScore: 95,
    completedResult: 'Архетип «Добытчик»: мужчина полностью обеспечивает дом и детей, уважая свободу жены.',
    questions: [
      {
        id: 'mf1',
        text: 'Как должен распределяться бюджет в вашей семье?',
        options: [
          { label: 'Я закрываю жилье, авто, счета и отпуска. Доход жены — ее личный бюджет', score: 100, trait: 'Щедрый добытчик' },
          { label: 'Общий котел: складываем все доходы и согласовываем траты', score: 85, trait: 'Коллегиальный бюджет' },
          { label: 'Строго 50/50, каждый платит за свою чашку кофе', score: 40, trait: 'Скупость' }
        ]
      },
      {
        id: 'mf2',
        text: 'Как вы относитесь к периоду декрета жены?',
        options: [
          { label: 'Полное обеспечение жены и ребенка без упреков и с радостью', score: 100, trait: 'Надежная опора' },
          { label: 'Обеспечу, но пусть быстрее выходит на работу', score: 65, trait: 'Тревожность' },
          { label: 'Пусть копит заранее на декрет сама', score: 20, trait: 'Неприемлемо' }
        ]
      }
    ]
  },
  {
    id: 'male_crisis_temperament',
    title: 'Решение кризисов и Слово Мужчины',
    category: 'Эмоциональный интеллект',
    description: 'Проверка на отсутствие агрессии, манипуляций, умение решать споры спокойно и держать слово.',
    targetGender: 'male',
    estimatedMinutes: 1,
    icon: 'heart',
    completedScore: 98,
    completedResult: 'Зрелое урегулирование: диалог через рот, верность слову, без обид и молчанки.',
    questions: [
      {
        id: 'mc1',
        text: 'Что вы делаете, если между вами и супругой возникло недопонимание?',
        options: [
          { label: 'Спокойно садимся, наливаем чай и говорим без криков и упреков', score: 100, trait: 'Эмоциональная зрелость' },
          { label: 'Ухожу в себя и молчу несколько дней, пока сама не поймет', score: 40, trait: 'Пассивная агрессия' },
          { label: 'Хлопаю дверью и иду с друзьями в бар', score: 25, trait: 'Токсичность' }
        ]
      }
    ]
  }
];

// Tests specifically tailored for Women (Невесты / Девушки)
const femaleTests: TestItem[] = [
  {
    id: 'female_hearth_keeper',
    title: 'Хранительница очага и Мать',
    category: 'Семья и Уют',
    description: 'Определяет готовность женщины к созданию душевного тепла в доме, рождению детей и поддержке мужа.',
    targetGender: 'female',
    estimatedMinutes: 2,
    icon: 'home',
    completedScore: 99,
    completedResult: 'Архетип «Мудрая Веста»: искреннее стремление к семье, теплоте дома и материнству.',
    questions: [
      {
        id: 'w1',
        text: 'Какой вы видите свою роль в создании счастливой семьи?',
        options: [
          { label: 'Быть источником тепла, поддержки и уюта, где муж чувствует покой и верность', score: 100, trait: 'Хранительница очага' },
          { label: 'Равный партнер по карьере, а быт поровну или через клининг', score: 85, trait: 'Современный баланс' },
          { label: 'Жду, чтобы меня только развлекали и возили по ресторанам', score: 30, trait: 'Инфантильность' }
        ]
      },
      {
        id: 'w2',
        text: 'Ваше отношение к рождению и воспитанию детей?',
        options: [
          { label: 'Мечтаю о детях (2+), хочу подарить им счастливое детство в любящей семье', score: 100, trait: 'Материнская зрелость' },
          { label: 'Хочу максимум одного ребенка через 3-5 лет', score: 75, trait: 'Осторожный план' },
          { label: 'Не хочу детей ни при каких условиях', score: 30, trait: 'Не для семейного союза' }
        ]
      },
      {
        id: 'w3',
        text: 'Как вы встречаете мужа после тяжелого рабочего дня?',
        options: [
          { label: 'С теплой улыбкой, вкусным ужином и даю время выдохнуть и отдохнуть', score: 100, trait: 'Женская мудрость' },
          { label: 'Сразу вываливаю список бытовых проблем и претензий', score: 40, trait: 'Бытовое напряжение' },
          { label: 'Каждый сам по себе в своем телефоне', score: 45, trait: 'Дистанция' }
        ]
      }
    ]
  },
  {
    id: 'female_husband_expectations',
    title: 'Ожидания от Мужа и Защитника',
    category: 'Критерии выбора',
    description: 'Определяет ключевые мужские качества, важные для девушки: надежность, лидерство, верность и уважение.',
    targetGender: 'female',
    estimatedMinutes: 2,
    icon: 'heart',
    completedScore: 96,
    completedResult: 'Ориентир на великодушного и твердого мужчину со словом, взаимное уважение.',
    questions: [
      {
        id: 'we1',
        text: 'Какое качество в будущем муже для вас на первом месте?',
        options: [
          { label: 'Надежность, благородство и способность держать слово', score: 100, trait: 'Поиск каменной стены' },
          { label: 'Высокий статус, бренды и дорогая машина', score: 55, trait: 'Материальный фокус' },
          { label: 'Внешность модели и тусовочный характер', score: 40, trait: 'Поверхностность' }
        ]
      },
      {
        id: 'we2',
        text: 'Кто в семье принимает стратегические ключевые решения?',
        options: [
          { label: 'Мужчина как глава семьи, обязательно советуясь с женой', score: 100, trait: 'Здоровая иерархия' },
          { label: 'Только жена, мужчина должен беспрекословно подчиняться', score: 45, trait: 'Матриархальный диктат' },
          { label: 'Постоянно спорим, пока кто-то не уступит', score: 40, trait: 'Конфликтность' }
        ]
      }
    ]
  },
  {
    id: 'female_inspiration_support',
    title: 'Вдохновение и Женская сила',
    category: 'Эмоциональный тыл',
    description: 'Тест на способность поддержать мужчину в минуты трудностей и вдохновить на новые достижения.',
    targetGender: 'female',
    estimatedMinutes: 1,
    icon: 'family',
    completedScore: 98,
    completedResult: 'Вдохновительница: вера в мужа, отсутствие упреков, умение вселить уверенность.',
    questions: [
      {
        id: 'wi1',
        text: 'Если у мужа временные трудности в бизнесе или на работе, как вы поступите?',
        options: [
          { label: 'Буду рядом, поддержу морально и напомню, какой он сильный и способный', score: 100, trait: 'Надежный тыл' },
          { label: 'Начну пилить и сравнивать с успешным мужем подруги', score: 20, trait: 'Разрушение брака' },
          { label: 'Сразу подам на развод и найду другого', score: 10, trait: 'Меркантильность' }
        ]
      }
    ]
  }
];

interface GenderSpecificTestsProps {
  currentGender: Gender;
  onOpenMatrix: (profile: UserProfile | null) => void;
  brandName: string;
}

export const GenderSpecificTests: React.FC<GenderSpecificTestsProps> = ({
  currentGender,
  onOpenMatrix,
  brandName
}) => {
  const isFemale = currentGender === 'female';
  const tests = isFemale ? femaleTests : maleTests;

  // Interactive active test state
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [completedTests, setCompletedTests] = useState<Record<string, { score: number; trait: string }>>({
    [tests[0].id]: { score: tests[0].completedScore || 98, trait: tests[0].completedResult || 'Высокая совместимость' }
  });

  const activeTest = tests.find(t => t.id === activeTestId);
  const testDialogRef = useRef<HTMLDivElement>(null);
  const pendingCompletedTestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeTestId) return;
    testDialogRef.current
      ?.querySelector<HTMLButtonElement>('[data-test-answer="true"]')
      ?.focus();
  }, [activeTestId, currentQuestionIndex]);

  useEffect(() => {
    if (activeTestId || !pendingCompletedTestIdRef.current) return;
    const completedTestId = pendingCompletedTestIdRef.current;
    pendingCompletedTestIdRef.current = null;
    document.querySelector<HTMLElement>(`[data-test-result="${completedTestId}"]`)?.focus();
  }, [activeTestId, completedTests]);

  useEffect(() => {
    if (!activeTestId) return;

    const dialog = testDialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const getFocusable = () => dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(element => !element.closest('[aria-hidden="true"], [hidden], [inert]'))
      : [];

    getFocusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setActiveTestId(null);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [activeTestId]);


  const handleStartTest = (testId: string) => {
    setActiveTestId(testId);
    setCurrentQuestionIndex(0);
    setSelectedAnswers({});
  };

  const handleSelectOption = (questionId: string, optionScore: number, trait: string) => {
    const updatedAnswers = { ...selectedAnswers, [questionId]: optionScore };
    setSelectedAnswers(updatedAnswers);

    if (activeTest && currentQuestionIndex < activeTest.questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    } else if (activeTest) {
      // Calculate final score
      const totalScore = Object.values(updatedAnswers).reduce((a, b) => a + b, 0);
      const avgScore = Math.round(totalScore / activeTest.questions.length);
      pendingCompletedTestIdRef.current = activeTest.id;
      setCompletedTests(prev => ({
        ...prev,
        [activeTest.id]: {
          score: avgScore,
          trait: `Результат: ${avgScore}% совпадения с семейным эталоном (${trait})`
        }
      }));
      setActiveTestId(null);
    }
  };

  return (
    <div className="vow-screen w-full max-w-md mx-auto text-left">
      {/* Active Test Modal / Runner */}
      {activeTest && (
        <div className="fixed inset-0 z-50 bg-stone-950/80 backdrop-blur-xl flex items-center justify-center p-4">
          <div ref={testDialogRef} role="dialog" aria-modal="true" aria-labelledby="active-test-question-title" tabIndex={-1} className="w-full max-w-md bg-stone-900 border border-white/10 rounded-3xl p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] uppercase font-bold text-rose-400 tracking-wider">
                Вопрос {currentQuestionIndex + 1} из {activeTest.questions.length}
              </span>
              <button
                type="button"
                onClick={() => setActiveTestId(null)}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-stone-800 px-3 py-2 text-xs text-stone-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
              >
                Закрыть
              </button>
            </div>

            <div role="progressbar" aria-label="Прогресс теста" aria-valuemin={0} aria-valuemax={activeTest.questions.length} aria-valuenow={currentQuestionIndex + 1} className="w-full bg-stone-800 h-1.5 rounded-full mb-4 overflow-hidden">
              <div
                className="bg-gradient-to-r from-rose-600 to-amber-500 h-full transition-all duration-300"
                style={{ width: `${((currentQuestionIndex + 1) / activeTest.questions.length) * 100}%` }}
              />
            </div>

            <h3 id="active-test-question-title" aria-live="polite" aria-atomic="true" className="font-heading font-black text-white text-base mb-4 leading-snug">
              {activeTest.questions[currentQuestionIndex].text}
            </h3>

            <div className="space-y-2.5 mb-2">
              {activeTest.questions[currentQuestionIndex].options.map((opt, idx) => (
                <button
                  type="button"
                  key={idx}
                  data-test-answer="true"
                  onClick={() => handleSelectOption(activeTest.questions[currentQuestionIndex].id, opt.score, opt.trait)}
                  className="w-full p-3.5 rounded-2xl bg-stone-950 border border-white/10 hover:border-rose-500/50 hover:bg-rose-950/20 text-left transition-all group focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                >
                  <div className="text-xs font-semibold text-stone-200 group-hover:text-white mb-1">
                    {opt.label}
                  </div>
                  <div className="text-[10px] text-stone-400 group-hover:text-rose-400 flex items-center gap-1 font-medium">
                    <Sparkles className="w-3 h-3 text-rose-500" />
                    <span>{opt.trait}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main Tests View Header */}
      <div className="p-4 sm:p-5 rounded-3xl bg-stone-900/90 border border-white/10 shadow-2xl mb-4">
        {/* Gender badge and tests */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-black uppercase tracking-wider ${
              isFemale 
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' 
                : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
            }`}>
              {isFemale ? '👩 Для Женщин (Невесты)' : '👨 Для Мужчин (Женихи)'}
            </span>
            <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Только серьезный союз
            </span>
          </div>

          <span className="text-[10px] text-stone-400">Тесты совместимости</span>
        </div>

        <h2 className="font-heading font-black text-xl text-white mb-1.5">
          {isFemale ? 'Тесты совместимости для Невесты' : 'Тесты совместимости для Жениха'}
        </h2>
        <p className="text-xs text-stone-300 leading-relaxed mb-4">
          {isFemale
            ? `В ${brandName} девушки проходят профильные тесты на создание семейного очага, материнство и ожидания от мужа. Мужчины видят ваши результаты до первого сообщения.`
            : `В ${brandName} мужчины подтверждают готовность быть главой семьи, надежным добытчиком и отцом. Девушки ценят мужчин, чьи слова подтверждены делом.`}
        </p>

        {/* Gender Psychological Identity Summary Card */}
        <div className="p-3.5 rounded-2xl bg-stone-950/80 border border-white/5 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-bold text-white flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-rose-400" />
              Ваш текущий семейный статус:
            </span>
            <span className="text-[10px] font-black text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/30">
              98% Эталон
            </span>
          </div>
          <p className="text-xs text-stone-300 italic">
            {isFemale
              ? '«Мудрая Хранительница Очага: готова к браку, материнству, ценит великодушие и верность мужа»'
              : '«Опора и Защитник: готов к браку в течение 1-2 лет, финансовая стабильность, ответственность за семью»'}
          </p>
        </div>

        {/* Catalog of Tests for this Gender */}
        <div className="space-y-3">
          <div className="text-[11px] font-bold text-stone-400 uppercase tracking-wider flex items-center justify-between">
            <span>Каталог тестов ({tests.length}):</span>
            <span className="text-[10px] text-rose-400 lowercase">завершите тест для полного профиля</span>
          </div>

          {tests.map(test => {
            const isCompleted = !!completedTests[test.id];
            const resultData = completedTests[test.id];

            return (
              <div
                key={test.id}
                className="p-3.5 rounded-2xl bg-stone-950 border border-white/5 hover:border-rose-500/40 transition-all flex flex-col gap-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-600/20 to-amber-500/20 text-rose-400 flex items-center justify-center border border-rose-500/30">
                      {test.icon === 'family' && <Users className="w-4 h-4" />}
                      {test.icon === 'finance' && <DollarSign className="w-4 h-4" />}
                      {test.icon === 'heart' && <Heart className="w-4 h-4" />}
                      {test.icon === 'home' && <Home className="w-4 h-4" />}
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                        <span>{test.title}</span>
                        {isCompleted && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400/20" />
                        )}
                      </h4>
                      <div className="text-[10px] text-stone-400">{test.category} • {test.estimatedMinutes} мин</div>
                    </div>
                  </div>

                  {isCompleted ? (
                    <span data-test-result={test.id} tabIndex={-1} className="text-[11px] font-black text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
                      {resultData.score}%
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleStartTest(test.id)}
                      className="min-h-11 min-w-11 px-3 py-1 rounded-full bg-rose-600 hover:bg-rose-500 text-white font-bold text-[11px] transition-colors shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                    >
                      Пройти
                    </button>
                  )}
                </div>

                <p className="text-[11px] text-stone-300 leading-snug">
                  {test.description}
                </p>

                {isCompleted && (
                  <div className="p-2.5 rounded-xl bg-stone-900 border border-white/5 flex items-center justify-between text-[10px]">
                    <span className="text-stone-300 font-medium">{resultData.trait}</span>
                    <button
                      type="button"
                      onClick={() => handleStartTest(test.id)}
                      className="min-h-11 min-w-11 px-2 text-stone-400 hover:text-white flex items-center justify-center gap-1 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Пересдать</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Opposite Gender Expectations Section */}
      <div className="p-4 rounded-3xl bg-stone-900/60 border border-white/10 mb-4 text-xs text-stone-300">
        <h4 className="font-heading font-bold text-white text-xs mb-1 flex items-center gap-1.5">
          <Compass className="w-3.5 h-3.5 text-rose-400" />
          <span>{isFemale ? 'Что видят мужчины в вашей анкете:' : 'Что видят женщины в вашей анкете:'}</span>
        </h4>
        <p className="text-[11px] text-stone-400 leading-relaxed">
          {isFemale
            ? 'Мужчины видят вашу приверженность семье, душевность, отношение к детям и одобрение роли мужа как главы. Это сразу привлекает ответственных женихов и отсекает легкомысленных парней.'
            : 'Женщины видят вашу готовность жениться, стабильность работы, жилищный статус и отношение к детям. Они уверены, что вы пришли строить семью, а не тратить время на бесконечные пустые диалоги.'}
        </p>
      </div>
    </div>
  );
};
