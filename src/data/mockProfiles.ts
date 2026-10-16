import type { UserProfile } from '../types/index.ts';

export const initialProfiles: UserProfile[] = [
  // --- MALE PROFILES (Shown when Current User is Female) ---
  {
    id: 'user_alexander',
    name: 'Александр',
    age: 32,
    city: 'Москва',
    gender: 'male',
    occupation: 'Руководитель проектов в IT & Девелопменте',
    height: 186,
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Ищу спутницу жизни. Ценю честность, женственность и семейный очаг. Хочу дом за городом, путешествовать вдвоем и растить детей в любви и заботе.',
    voiceIntroSeconds: 24,
    intent: 'marriage_family',
    crucialAnswers: {
      marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
      finances: 'Мужчина основной добытчик',
      free_time: 'Путешествия и активный отдых',
      conflict_resolution: 'Спокойно говорим через рот сразу'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 99.4,
      verifiedAt: '2026-09-18',
      idCheckPassed: true,
      noBotScore: 99.8,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Семья и дети', 'Архитектура', 'Горные лыжи', 'Чтение', 'Кулинария'],
    mbti: 'ENTJ • Лидер & Стратег',
    attachmentStyle: 'Надежный тип (Secure)',
    loveLanguage: 'Забота, поступки и время',
    psychCards: [
      { question: 'Какая роль мужчины в семье?', answer: 'Быть каменной стеной, защищать, обеспечивать и брать ответственность за будущее детей.', matchBonus: 98 },
      { question: 'Как распределяем бюджет?', answer: 'Я закрываю все основные счета, жилье и отпуска. Доходы жены — ее личная свобода.', matchBonus: 96 },
      { question: 'Что делаем при споре?', answer: 'Не терплю эмоциональной молчанки. Садимся, наливаем чай и по-взрослому решаем вопрос.', matchBonus: 99 }
    ],
    onlineStatus: 'online'
  },
  {
    id: 'user_dmitry',
    name: 'Дмитрий',
    age: 34,
    city: 'Санкт-Петербург',
    gender: 'male',
    occupation: 'Главный врач частной клиники',
    height: 182,
    avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Спокойный, надежный. Прошел путь становления карьеры, сейчас главный приоритет — семья и любимая женщина. Не люблю долгих переписок, ценю живой взгляд и тепло.',
    voiceIntroSeconds: 19,
    intent: 'marriage_family',
    crucialAnswers: {
      marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
      finances: 'Мужчина основной добытчик',
      free_time: 'Уютный дом и спокойствие',
      conflict_resolution: 'Спокойно говорим через рот сразу'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 98.9,
      verifiedAt: '2026-09-24',
      idCheckPassed: true,
      noBotScore: 99.2,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Медицина', 'Театр', 'Бег', 'Классическая музыка', 'Психология'],
    mbti: 'INFJ • Гуманист & Мудрец',
    attachmentStyle: 'Надежный тип (Secure)',
    loveLanguage: 'Качественное время и объятия',
    psychCards: [
      { question: 'Что больше всего ценишь в будущей жене?', answer: 'Глубокое душевное спокойствие, верность, нежность и взаимную заботу.', matchBonus: 95 },
      { question: 'Идеальный вечер вдвоем?', answer: 'Приготовить вместе ужин, зажечь камин и делиться самым сокровенным.', matchBonus: 94 }
    ],
    onlineStatus: 'recently'
  },
  {
    id: 'user_mikhail',
    name: 'Михаил',
    age: 29,
    city: 'Казань',
    gender: 'male',
    occupation: 'Инженер-конструктор робототехники',
    height: 180,
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Люблю открытых и глубоких людей. Готов к серьезным отношениям без драмы и игр. Занимаюсь триатлоном, строю свой загородный дом.',
    voiceIntroSeconds: 15,
    intent: 'marriage_family',
    crucialAnswers: {
      marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
      finances: 'Мужчина основной добытчик',
      free_time: 'Путешествия и активный отдых',
      conflict_resolution: 'Спокойно говорим через рот сразу'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 99.1,
      verifiedAt: '2026-10-05',
      idCheckPassed: true,
      noBotScore: 98.4,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Спорт', 'Инженерия', 'Походы', 'Кинематограф'],
    mbti: 'ISTJ • Прагматик & Опора',
    attachmentStyle: 'Надежный тип (Secure)',
    loveLanguage: 'Поступки и верность',
    psychCards: [
      { question: 'Готовность к детям?', answer: 'Полностью созрел, дом почти достроен, готов создать крепкую многодетную семью.', matchBonus: 97 }
    ],
    onlineStatus: 'online'
  },

  // --- FEMALE PROFILES (Shown when Current User is Male) ---
  {
    id: 'user_elena',
    name: 'Елена',
    age: 28,
    city: 'Москва',
    gender: 'female',
    occupation: 'Преподаватель лингвистики & переводчик',
    height: 171,
    avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Ищу надежного, зрелого мужчину с традиционными ценностями для брака. Люблю уют, книги, печь вкусные воскресные пироги и создавать душевное тепло в доме.',
    voiceIntroSeconds: 22,
    intent: 'marriage_family',
    crucialAnswers: {
      marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
      finances: 'Мужчина основной добытчик',
      free_time: 'Уютный дом и спокойствие',
      conflict_resolution: 'Спокойно говорим через рот сразу'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 99.7,
      verifiedAt: '2026-10-02',
      idCheckPassed: true,
      noBotScore: 99.5,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Иностранные языки', 'Литература', 'Кулинария', 'Семейные ценности', 'Йога'],
    mbti: 'ISFJ • Хранительница уюта',
    attachmentStyle: 'Надежный тип (Secure)',
    loveLanguage: 'Забота, тепло и ласковые слова',
    psychCards: [
      { question: 'Каким ты видишь своего мужа?', answer: 'Сильным, великодушным мужчиной с твердым словом, с которым чувствуешь себя в безопасности.', matchBonus: 98 },
      { question: 'Твое отношение к детям?', answer: 'Мечтаю о двоих-троих детях, хочу подарить им счастливое детство в любящей семье.', matchBonus: 99 },
      { question: 'Что создает семейное счастье?', answer: 'Взаимное уважение, отсутствие упреков и вкусный теплый ужин после рабочего дня.', matchBonus: 97 }
    ],
    onlineStatus: 'online'
  },
  {
    id: 'user_sofia',
    name: 'София',
    age: 26,
    city: 'Москва',
    gender: 'female',
    occupation: 'Детский врач-педиатр',
    height: 168,
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Добрая, искренняя, люблю детей и животных. Мечтаю о крепком союзе на всю жизнь, где муж и жена — единое целое. За прямоту и верность.',
    voiceIntroSeconds: 18,
    intent: 'marriage_family',
    crucialAnswers: {
      marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
      finances: 'Мужчина основной добытчик',
      free_time: 'Путешествия и активный отдых',
      conflict_resolution: 'Спокойно говорим через рот сразу'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 99.5,
      verifiedAt: '2026-10-09',
      idCheckPassed: true,
      noBotScore: 99.8,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Медицина', 'Живопись', 'Путешествия', 'Цветы', 'Дети'],
    mbti: 'ENFJ • Вдохновитель & Гармония',
    attachmentStyle: 'Надежный тип (Secure)',
    loveLanguage: 'Качественное время и забота',
    psychCards: [
      { question: 'Главное качество мужчины для брака?', answer: 'Благородство, верность своим принципам и способность заботиться о семье.', matchBonus: 96 },
      { question: 'Как решаем разногласия?', answer: 'С любовью и объятиями. В паре не должно быть победителей и побежденных.', matchBonus: 99 }
    ],
    onlineStatus: 'online'
  },
  {
    id: 'user_ekaterina',
    name: 'Екатерина',
    age: 29,
    city: 'Санкт-Петербург',
    gender: 'female',
    occupation: 'Искусствовед & основательница арт-студии',
    height: 173,
    avatar: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=800&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Воспитанная, с глубоким внутренним миром. Ищу умного, целеустремленного мужчину, готового к созданию крепкой традиционной семьи.',
    voiceIntroSeconds: 21,
    intent: 'marriage_family',
    crucialAnswers: {
      marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
      finances: 'Мужчина основной добытчик',
      free_time: 'Уютный дом и спокойствие',
      conflict_resolution: 'Спокойно говорим через рот сразу'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 99.8,
      verifiedAt: '2026-10-11',
      idCheckPassed: true,
      noBotScore: 99.6,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Искусство', 'Архитектура', 'Классическая музыка', 'Кулинария', 'Садоводство'],
    mbti: 'INFJ • Мудрость & Верность',
    attachmentStyle: 'Надежный тип (Secure)',
    loveLanguage: 'Глубокие беседы и преданность',
    psychCards: [
      { question: 'Семейные ценности?', answer: 'Традиционный брак, верность на всю жизнь, уважение мужа как главы дома.', matchBonus: 98 }
    ],
    onlineStatus: 'recently'
  },

  // --- SPONSOR CARD (Universal) ---
  {
    id: 'ad_sponsor_restaurant',
    name: 'Ресторан «Белый Рубин»',
    age: 0,
    city: 'Москва • Патриаршие пруды',
    gender: 'male',
    occupation: 'Спонсор свиданий премиум-класса',
    height: 0,
    avatar: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Идеальное место для вашего первого свидания без суеты. Панорамный вид, свечи, авторская винная карта и десерт в подарок для пар из «Красной Нити».',
    intent: 'serious_relationship',
    crucialAnswers: {
      marriage_and_kids: 'Идеальная атмосфера для предложения',
      finances: 'Скидка 20% по промокоду REDSOUL',
      free_time: 'Живая джазовая музыка по пятницам',
      conflict_resolution: 'Приятная уединенная посадка'
    },
    verification: {
      isVerified: true,
      livenessConfidence: 100,
      verifiedAt: '2026-10-01',
      idCheckPassed: true,
      noBotScore: 100,
      botRiskLevel: 'low',
      reportCount: 0
    },
    interests: ['Романтика', 'Высокая кухня', 'Джаз', 'Первое свидание'],
    onlineStatus: 'online',
    isSponsorAd: true,
    sponsorTitle: 'Спонсорское свидание: Ужин для двоих',
    sponsorDescription: 'Забронируйте столик у окна с комплиментом от шеф-повара для вашего первого свидания.',
    sponsorCta: 'Получить скидку 20%',
    sponsorUrl: 'https://example.com/date-reservation'
  },

  // --- BOT SPAM TEST PROFILE (For Anti-Bot Scanner Test) ---
  {
    id: 'user_suspect_bot',
    name: 'Crypto_Kristina (Подозрительный профиль)',
    age: 23,
    city: 'Дубай / Москва',
    gender: 'female',
    occupation: 'Финансовый эксперт',
    height: 172,
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80',
    photos: [
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80'
    ],
    bio: 'Привет красавчик! Редко бываю тут, пиши сразу в телеграм t.me/kristina_vip_invest расскажу как заработать +300% на пассивном доходе!',
    intent: 'not_sure',
    crucialAnswers: {
      marriage_and_kids: 'Пока не планирую детей',
      finances: 'Спонсорство',
      free_time: 'Клубы и рестораны',
      conflict_resolution: 'Нужно время остыть'
    },
    verification: {
      isVerified: false,
      livenessConfidence: 34.2,
      verifiedAt: '—',
      idCheckPassed: false,
      noBotScore: 24.1,
      botRiskLevel: 'high',
      reportCount: 5
    },
    interests: ['Криптовалюта', 'Инвестиции', 'VIP'],
    onlineStatus: 'offline'
  }
];

export const initialCurrentUser: UserProfile = {
  id: 'current_user',
  name: 'Анна',
  age: 27,
  city: 'Москва',
  gender: 'female',
  occupation: 'Дизайнер интерьеров',
  height: 169,
  avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&auto=format&fit=crop&q=80',
  photos: [
    'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=800&auto=format&fit=crop&q=80'
  ],
  bio: 'Хочу встретить зрелого, доброго мужчину для создания настоящей семьи. Без пустых переписок: за живое общение и взаимное уважение.',
  voiceIntroSeconds: 18,
  intent: 'marriage_family',
  crucialAnswers: {
    marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
    finances: 'Мужчина основной добытчик',
    free_time: 'Путешествия и активный отдых',
    conflict_resolution: 'Спокойно говорим через рот сразу'
  },
  verification: {
    isVerified: true,
    livenessConfidence: 99.6,
    verifiedAt: '2026-10-12',
    idCheckPassed: true,
    noBotScore: 99.9,
    botRiskLevel: 'low',
    reportCount: 0
  },
  interests: ['Семья и дети', 'Архитектура', 'Путешествия', 'Искусство'],
  mbti: 'ENFJ • Гармония & Тепло',
  attachmentStyle: 'Надежный тип (Secure)',
  loveLanguage: 'Забота и качественное время',
  onlineStatus: 'online'
};
