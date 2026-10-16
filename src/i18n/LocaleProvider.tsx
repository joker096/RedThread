import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const LANGUAGE_OPTIONS = [
  { code: 'auto', name: 'Automatic / Авто', nativeName: 'Automatic / Авто' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'ka', name: 'Georgian', nativeName: 'ქართული' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'fil', name: 'Filipino', nativeName: 'Filipino' },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ' },
  { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycanca' },
  { code: 'hy', name: 'Armenian', nativeName: 'Հայերեն' },
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақша' },
  { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha' },
  { code: 'sr', name: 'Serbian', nativeName: 'Српски' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' }
] as const;

export type LocaleCode = typeof LANGUAGE_OPTIONS[number]['code'];
type MessageKey = keyof typeof messages.en;

const messages = {
  en: {
    language: 'Language', autoLanguage: 'Automatic', discovery: 'Discover', tests: 'Values test', chats: 'Chats',
    safety: 'Safety', filters: 'Profile filters', login: 'Sign in / Register', serverSearch: 'Server search',
    registeredProfiles: 'Registered profiles', country: 'Country', anyCountry: 'Any country', city: 'City',
    anyCity: 'Any city', ageFrom: 'Age from', ageTo: 'Age to', relationshipGoal: 'Relationship goal',
    any: 'Any', marriageFamily: 'Marriage and family', familyWithoutMarriage: 'Family without marriage registration',
    seriousRelationship: 'Serious relationship', familyFormat: 'Family format', anyFormat: 'Any format',
    marriageOnly: 'Marriage only', cohabitation: 'Living together without marriage registration',
    openToBoth: 'Open to both', children: 'Children', notImportant: 'Does not matter', noChildren: 'No children',
    hasChildren: 'Has children', financialMatch: 'Financial expectations match', doNotFilter: 'Do not filter',
    search: 'Find profiles', searching: 'Searching…', swipeMode: 'Swipe mode — one profile at a time',
    listMode: 'Switch to profile list', undoPass: 'Undo last pass', like: 'Like', liked: 'Like sent',
    pass: 'Pass profile', block: 'Hide and block', report: 'Report', noPhotos: 'No photos added',
    childrenWant: 'Wants children', childrenNoWant: 'Does not plan to have children', languages: 'Languages',
    profileGoal: 'Goal', finance: 'Finances', profileMarriage: 'Marriage and family',
    profileSerious: 'Serious relationship', serverProfilesTitle: 'Profiles from registered accounts',
    realProfilesNote: 'These are registered accounts matching your filters. Demo cards below are not real users.',
    signInToSearch: 'Sign in or create an account to search registered profiles and send likes.',
    sendReport: 'Send report', sending: 'Sending…', reportReason: 'Reason', reportComment: 'Comment (optional)',
    reportFake: 'Suspicious or fake profile', reportSpam: 'Spam or scam', reportHarassment: 'Abuse or harassment',
    reportSafety: 'Safety threat', reportChildren: 'Misrepresentation about children', reportDuplicate: 'Duplicate profile',
    reportOther: 'Other', swipeHint: 'Swipe right to pass or left to like. Buttons are also available.',
    serverSearchEyebrow: 'SERVER SEARCH', languageAutoHelp: 'Use device language when available',
    cancel: 'Cancel', save: 'Save', retry: 'Try again', loading: 'Loading…'
  },
  ru: {
    language: 'Язык', autoLanguage: 'Автоматически', discovery: 'Знакомства', tests: 'Тест ценностей', chats: 'Чаты',
    safety: 'Безопасность', filters: 'Фильтры анкет', login: 'Вход и регистрация', serverSearch: 'Поиск на сервере',
    registeredProfiles: 'Анкеты зарегистрированных пользователей', country: 'Страна', anyCountry: 'Любая страна', city: 'Город',
    anyCity: 'Любой город', ageFrom: 'Возраст от', ageTo: 'Возраст до', relationshipGoal: 'Цель отношений',
    any: 'Любая', marriageFamily: 'Брак и семья', familyWithoutMarriage: 'Семья без регистрации брака',
    seriousRelationship: 'Серьёзные отношения', familyFormat: 'Формат семьи', anyFormat: 'Любой формат',
    marriageOnly: 'Только брак', cohabitation: 'Совместная жизнь без регистрации', openToBoth: 'Открыт(а) к обоим',
    children: 'Наличие детей', notImportant: 'Не важно', noChildren: 'Детей нет', hasChildren: 'Есть дети',
    financialMatch: 'Совпадение финансовых ожиданий', doNotFilter: 'Не фильтровать', search: 'Найти анкеты',
    searching: 'Ищем…', swipeMode: 'Режим свайпов — по одной анкете', listMode: 'Переключиться на список анкет',
    undoPass: 'Отменить последний пропуск', like: 'Отправить симпатию', liked: 'Симпатия отправлена',
    pass: 'Пропустить анкету', block: 'Скрыть и заблокировать', report: 'Пожаловаться', noPhotos: 'Фотографии не добавлены',
    childrenWant: 'Хочет детей', childrenNoWant: 'Не планирует детей', languages: 'Языки', profileGoal: 'Цель',
    finance: 'Финансы', profileMarriage: 'Брак и семья', profileSerious: 'Серьёзные отношения',
    serverProfilesTitle: 'Анкеты из базы аккаунтов',
    realProfilesNote: 'Показываются зарегистрированные аккаунты по вашим фильтрам. Демо-карточки ниже — не реальные пользователи.',
    signInToSearch: 'Чтобы искать зарегистрированные анкеты и отправлять симпатии, войдите или создайте аккаунт.',
    sendReport: 'Отправить жалобу', sending: 'Отправляем…', reportReason: 'Причина', reportComment: 'Комментарий (необязательно)',
    reportFake: 'Подозрение на фейковую анкету', reportSpam: 'Спам или мошенничество', reportHarassment: 'Оскорбления или преследование',
    reportSafety: 'Угроза безопасности', reportChildren: 'Сокрытие наличия детей', reportDuplicate: 'Повторная анкета',
    reportOther: 'Другое', swipeHint: 'Проведите вправо, чтобы пропустить, или влево, чтобы отправить симпатию. Можно также использовать кнопки.',
    serverSearchEyebrow: 'ПОИСК НА СЕРВЕРЕ', languageAutoHelp: 'Использовать язык устройства, если он поддерживается',
    cancel: 'Отмена', save: 'Сохранить', retry: 'Повторить', loading: 'Загрузка…'
  },
  es: { language:'Idioma', autoLanguage:'Automático', discovery:'Descubrir', tests:'Test de valores', chats:'Chats', safety:'Seguridad', filters:'Filtros de perfiles', login:'Iniciar sesión / Registrarse', country:'País', city:'Ciudad', ageFrom:'Edad mínima', ageTo:'Edad máxima', search:'Buscar perfiles', searching:'Buscando…', undoPass:'Deshacer último descarte', like:'Me gusta', liked:'Me gusta enviado', pass:'Descartar perfil', block:'Ocultar y bloquear', report:'Denunciar', noPhotos:'No hay fotos', any:'Cualquiera', anyCountry:'Cualquier país', anyCity:'Cualquier ciudad', relationshipGoal:'Objetivo de relación', marriageFamily:'Matrimonio y familia', familyWithoutMarriage:'Familia sin matrimonio legal', seriousRelationship:'Relación seria', familyFormat:'Formato familiar', children:'Hijos', notImportant:'No importa', noChildren:'Sin hijos', hasChildren:'Tiene hijos', doNotFilter:'Sin filtro', financialMatch:'Compatibilidad financiera', sendReport:'Enviar denuncia', sending:'Enviando…', cancel:'Cancelar', save:'Guardar', loading:'Cargando…' },
  fr: { language:'Langue', autoLanguage:'Automatique', discovery:'Découvrir', tests:'Test de valeurs', chats:'Messages', safety:'Sécurité', filters:'Filtres de profils', login:'Connexion / Inscription', country:'Pays', city:'Ville', ageFrom:'Âge minimum', ageTo:'Âge maximum', search:'Rechercher des profils', searching:'Recherche…', undoPass:'Annuler le dernier refus', like:'Aimer', liked:'J’aime envoyé', pass:'Ignorer le profil', block:'Masquer et bloquer', report:'Signaler', noPhotos:'Aucune photo', any:'Tous', anyCountry:'Tous les pays', anyCity:'Toutes les villes', relationshipGoal:'Objectif relationnel', marriageFamily:'Mariage et famille', familyWithoutMarriage:'Famille sans mariage officiel', seriousRelationship:'Relation sérieuse', familyFormat:'Format familial', children:'Enfants', notImportant:'Sans importance', noChildren:'Sans enfants', hasChildren:'A des enfants', doNotFilter:'Ne pas filtrer', financialMatch:'Compatibilité financière', sendReport:'Envoyer le signalement', sending:'Envoi…', cancel:'Annuler', save:'Enregistrer', loading:'Chargement…' },
  de: { language:'Sprache', autoLanguage:'Automatisch', discovery:'Entdecken', tests:'Wertetest', chats:'Chats', safety:'Sicherheit', filters:'Profilfilter', login:'Anmelden / Registrieren', country:'Land', city:'Stadt', ageFrom:'Alter ab', ageTo:'Alter bis', search:'Profile suchen', searching:'Suche…', undoPass:'Letztes Überspringen rückgängig', like:'Gefällt mir', liked:'Like gesendet', pass:'Profil überspringen', block:'Ausblenden und blockieren', report:'Melden', noPhotos:'Keine Fotos hinzugefügt', any:'Alle', anyCountry:'Jedes Land', anyCity:'Jede Stadt', relationshipGoal:'Beziehungsziel', marriageFamily:'Ehe und Familie', familyWithoutMarriage:'Familie ohne Trauschein', seriousRelationship:'Ernsthafte Beziehung', familyFormat:'Familienmodell', children:'Kinder', notImportant:'Unwichtig', noChildren:'Keine Kinder', hasChildren:'Hat Kinder', doNotFilter:'Nicht filtern', financialMatch:'Finanzielle Übereinstimmung', sendReport:'Meldung senden', sending:'Wird gesendet…', cancel:'Abbrechen', save:'Speichern', loading:'Wird geladen…' },
  pt: { language:'Idioma', autoLanguage:'Automático', discovery:'Descobrir', tests:'Teste de valores', chats:'Conversas', safety:'Segurança', filters:'Filtros de perfil', login:'Entrar / Registar', country:'País', city:'Cidade', ageFrom:'Idade mínima', ageTo:'Idade máxima', search:'Encontrar perfis', searching:'A procurar…', undoPass:'Desfazer última rejeição', like:'Gostar', liked:'Gostei enviado', pass:'Ignorar perfil', block:'Ocultar e bloquear', report:'Denunciar', noPhotos:'Sem fotografias', any:'Qualquer', anyCountry:'Qualquer país', anyCity:'Qualquer cidade', relationshipGoal:'Objetivo da relação', marriageFamily:'Casamento e família', familyWithoutMarriage:'Família sem casamento oficial', seriousRelationship:'Relação séria', familyFormat:'Formato familiar', children:'Filhos', notImportant:'Não importa', noChildren:'Sem filhos', hasChildren:'Tem filhos', doNotFilter:'Não filtrar', financialMatch:'Compatibilidade financeira', sendReport:'Enviar denúncia', sending:'A enviar…', cancel:'Cancelar', save:'Guardar', loading:'A carregar…' },
  it: { language:'Lingua', autoLanguage:'Automatico', discovery:'Scopri', tests:'Test dei valori', chats:'Chat', safety:'Sicurezza', filters:'Filtri profilo', login:'Accedi / Registrati', country:'Paese', city:'Città', ageFrom:'Età minima', ageTo:'Età massima', search:'Cerca profili', searching:'Ricerca…', undoPass:'Annulla ultimo scarto', like:'Mi piace', liked:'Mi piace inviato', pass:'Salta profilo', block:'Nascondi e blocca', report:'Segnala', noPhotos:'Nessuna foto', any:'Qualsiasi', anyCountry:'Qualsiasi paese', anyCity:'Qualsiasi città', relationshipGoal:'Obiettivo della relazione', marriageFamily:'Matrimonio e famiglia', familyWithoutMarriage:'Famiglia senza matrimonio civile', seriousRelationship:'Relazione seria', familyFormat:'Formato familiare', children:'Figli', notImportant:'Non importa', noChildren:'Senza figli', hasChildren:'Ha figli', doNotFilter:'Non filtrare', financialMatch:'Compatibilità finanziaria', sendReport:'Invia segnalazione', sending:'Invio…', cancel:'Annulla', save:'Salva', loading:'Caricamento…' },
  tr: { language:'Dil', autoLanguage:'Otomatik', discovery:'Keşfet', tests:'Değerler testi', chats:'Sohbetler', safety:'Güvenlik', filters:'Profil filtreleri', login:'Giriş / Kayıt', country:'Ülke', city:'Şehir', ageFrom:'En az yaş', ageTo:'En çok yaş', search:'Profilleri bul', searching:'Aranıyor…', undoPass:'Son geçişi geri al', like:'Beğen', liked:'Beğeni gönderildi', pass:'Profili geç', block:'Gizle ve engelle', report:'Şikâyet et', noPhotos:'Fotoğraf eklenmemiş', any:'Herhangi', anyCountry:'Herhangi bir ülke', anyCity:'Herhangi bir şehir', relationshipGoal:'İlişki amacı', marriageFamily:'Evlilik ve aile', familyWithoutMarriage:'Resmî nikâhsız aile', seriousRelationship:'Ciddi ilişki', familyFormat:'Aile biçimi', children:'Çocuklar', notImportant:'Fark etmez', noChildren:'Çocuğu yok', hasChildren:'Çocuğu var', doNotFilter:'Filtreleme', financialMatch:'Mali beklenti uyumu', sendReport:'Şikâyeti gönder', sending:'Gönderiliyor…', cancel:'İptal', save:'Kaydet', loading:'Yükleniyor…' },
  ka: { language:'ენა', autoLanguage:'ავტომატურად', discovery:'გაცნობა', tests:'ღირებულებების ტესტი', chats:'ჩატები', safety:'უსაფრთხოება', filters:'პროფილის ფილტრები', login:'შესვლა / რეგისტრაცია', country:'ქვეყანა', city:'ქალაქი', ageFrom:'ასაკი მინ.', ageTo:'ასაკი მაქს.', search:'პროფილების ძიება', searching:'ძიება…', undoPass:'ბოლო გამოტოვების გაუქმება', like:'მოწონება', liked:'მოწონება გაგზავნილია', pass:'პროფილის გამოტოვება', block:'დამალვა და დაბლოკვა', report:'გასაჩივრება', noPhotos:'ფოტოები დამატებული არ არის', any:'ნებისმიერი', anyCountry:'ნებისმიერი ქვეყანა', anyCity:'ნებისმიერი ქალაქი', relationshipGoal:'ურთიერთობის მიზანი', marriageFamily:'ქორწინება და ოჯახი', familyWithoutMarriage:'ოჯახი ქორწინების რეგისტრაციის გარეშე', seriousRelationship:'სერიოზული ურთიერთობა', familyFormat:'ოჯახის ფორმატი', children:'შვილები', notImportant:'მნიშვნელობა არ აქვს', noChildren:'შვილები არ ჰყავს', hasChildren:'ჰყავს შვილები', doNotFilter:'არ გაფილტრო', financialMatch:'ფინანსური მოლოდინების თანხვედრა', sendReport:'საჩივრის გაგზავნა', sending:'იგზავნება…', cancel:'გაუქმება', save:'შენახვა', loading:'იტვირთება…' },
  ar: { language:'اللغة', autoLanguage:'تلقائي', discovery:'اكتشف', tests:'اختبار القيم', chats:'المحادثات', safety:'الأمان', filters:'تصفية الملفات الشخصية', login:'تسجيل الدخول / إنشاء حساب', country:'الدولة', city:'المدينة', ageFrom:'العمر من', ageTo:'العمر إلى', search:'البحث عن ملفات شخصية', searching:'جارٍ البحث…', undoPass:'التراجع عن آخر تخطٍ', like:'إعجاب', liked:'تم إرسال الإعجاب', pass:'تخطي الملف الشخصي', block:'إخفاء وحظر', report:'إبلاغ', noPhotos:'لا توجد صور', any:'أي', anyCountry:'أي دولة', anyCity:'أي مدينة', relationshipGoal:'هدف العلاقة', marriageFamily:'الزواج والأسرة', familyWithoutMarriage:'أسرة دون زواج رسمي', seriousRelationship:'علاقة جادة', familyFormat:'شكل الأسرة', children:'الأطفال', notImportant:'لا يهم', noChildren:'ليس لديه أطفال', hasChildren:'لديه أطفال', doNotFilter:'بدون تصفية', financialMatch:'توافق التوقعات المالية', sendReport:'إرسال البلاغ', sending:'جارٍ الإرسال…', cancel:'إلغاء', save:'حفظ', loading:'جارٍ التحميل…' },
  zh: { language:'语言', autoLanguage:'自动', discovery:'发现', tests:'价值观测试', chats:'聊天', safety:'安全', filters:'资料筛选', login:'登录 / 注册', country:'国家', city:'城市', ageFrom:'最小年龄', ageTo:'最大年龄', search:'查找资料', searching:'搜索中…', undoPass:'撤销上次跳过', like:'喜欢', liked:'已发送喜欢', pass:'跳过资料', block:'隐藏并屏蔽', report:'举报', noPhotos:'尚未添加照片', any:'不限', anyCountry:'任何国家', anyCity:'任何城市', relationshipGoal:'关系目标', marriageFamily:'婚姻与家庭', familyWithoutMarriage:'不登记婚姻的家庭', seriousRelationship:'认真交往', familyFormat:'家庭形式', children:'孩子', notImportant:'不限', noChildren:'没有孩子', hasChildren:'有孩子', doNotFilter:'不筛选', financialMatch:'财务期望匹配', sendReport:'提交举报', sending:'发送中…', cancel:'取消', save:'保存', loading:'加载中…' },
  hi: { language:'भाषा', autoLanguage:'स्वचालित', discovery:'खोजें', tests:'मूल्य परीक्षण', chats:'चैट', safety:'सुरक्षा', filters:'प्रोफ़ाइल फ़िल्टर', login:'लॉग इन / पंजीकरण', country:'देश', city:'शहर', ageFrom:'न्यूनतम आयु', ageTo:'अधिकतम आयु', search:'प्रोफ़ाइल खोजें', searching:'खोज रहे हैं…', undoPass:'पिछला स्किप वापस लें', like:'पसंद करें', liked:'पसंद भेजी गई', pass:'प्रोफ़ाइल छोड़ें', block:'छिपाएँ और ब्लॉक करें', report:'रिपोर्ट करें', noPhotos:'कोई फ़ोटो नहीं', any:'कोई भी', anyCountry:'कोई भी देश', anyCity:'कोई भी शहर', relationshipGoal:'रिश्ते का उद्देश्य', marriageFamily:'विवाह और परिवार', familyWithoutMarriage:'विवाह पंजीकरण के बिना परिवार', seriousRelationship:'गंभीर रिश्ता', familyFormat:'परिवार का स्वरूप', children:'बच्चे', notImportant:'महत्वपूर्ण नहीं', noChildren:'बच्चे नहीं हैं', hasChildren:'बच्चे हैं', doNotFilter:'फ़िल्टर न करें', financialMatch:'वित्तीय अपेक्षाओं का मेल', sendReport:'रिपोर्ट भेजें', sending:'भेज रहे हैं…', cancel:'रद्द करें', save:'सहेजें', loading:'लोड हो रहा है…' }
};

const rtlLocales = new Set(['ar', 'he', 'fa', 'ur']);
const availableTranslations = new Set(Object.keys(messages));
const storageKey = 'nit-locale-preference-v1';

function detectLocale(): string {
  const candidates = typeof navigator === 'undefined' ? ['en'] : [...(navigator.languages || []), navigator.language || 'en'];
  for (const candidate of candidates) {
    const base = candidate.toLowerCase().split('-')[0];
    if (availableTranslations.has(base)) return base;
  }
  return 'en';
}

type LocaleContextValue = {
  locale: string;
  requestedLocale: string;
  setLocale: (locale: string) => void;
  t: (key: MessageKey) => string;
  formatDate: (date: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export const LocaleProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [requestedLocale, setRequestedLocale] = useState('auto');
  const [deviceLocale, setDeviceLocale] = useState('en');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      setRequestedLocale(saved || 'auto');
    } catch {
      setRequestedLocale('auto');
    }
    setDeviceLocale(detectLocale());
  }, []);

  const locale = requestedLocale === 'auto' ? deviceLocale : requestedLocale;
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = rtlLocales.has(locale) ? 'rtl' : 'ltr';
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const setLocale = useCallback((next: string) => {
    const safe = next === 'auto' || LANGUAGE_OPTIONS.some(item => item.code === next);
    if (!safe) return;
    setRequestedLocale(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* Private browsing may disable storage. */ }
  }, []);

  const t = useCallback((key: MessageKey) => {
    const active = (messages[locale as keyof typeof messages] || messages.en) as Record<string, string>;
    const english = messages.en as Record<string, string>;
    return active[key] || english[key] || key;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale, requestedLocale, setLocale, t,
    formatDate: (date, options) => new Intl.DateTimeFormat(locale, options || { dateStyle: 'medium' }).format(new Date(date)),
    formatNumber: (number, options) => new Intl.NumberFormat(locale, options).format(number)
  }), [locale, requestedLocale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used inside LocaleProvider');
  return context;
}

export type { MessageKey };
