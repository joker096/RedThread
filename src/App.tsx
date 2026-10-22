import React, { useEffect, useState } from 'react';
import { useLocale } from './i18n/LocaleProvider.tsx';
import { 
  Heart, 
  MessageCircle, 
  Sparkles, 
  ShieldCheck, 
  DollarSign, 
  Crown, 
  Brain,
  Smartphone,
  Gift
} from 'lucide-react';
import { initialProfiles, initialCurrentUser } from './data/mockProfiles.ts';
import { RelationshipAssessmentPanel } from './components/RelationshipAssessmentPanel.tsx';
import { AccountAccessPanel } from './components/AccountAccessPanel.tsx';
import { ServerDiscoveryPanel } from './components/ServerDiscoveryPanel.tsx';
import { ServerMatchesPanel } from './components/ServerMatchesPanel.tsx';
import { ProfileEditorPanel } from './components/ProfileEditorPanel.tsx';
import { ModeratorConsolePanel } from './components/ModeratorConsolePanel.tsx';
import { NotificationCenterPanel } from './components/NotificationCenterPanel.tsx';
import type { 
  UserProfile, 
  Gender, 
  DeviceFrame, 
  ChatThread, 
  AdStats 
} from './types/index.ts';
import { calculateCompatibility, shouldShowAds, filterBinaryCandidates } from './utils/compatibility.ts';
import { matchesProfileLocation } from './utils/location.ts';
import { HeaderNav } from './components/HeaderNav.tsx';
import { PWAInstallBanner } from './components/PWAInstallBanner.tsx';
import { RadarDiscovery } from './components/RadarDiscovery.tsx';
import { CompatibilityMatrixModal } from './components/CompatibilityMatrixModal.tsx';
import { ChatMessenger } from './components/ChatMessenger.tsx';
import { LadyPremiumModal } from './components/LadyPremiumModal.tsx';
import { BotSafetyScanner } from './components/BotSafetyScanner.tsx';
import { AdManagerModal } from './components/AdManagerModal.tsx';
import { FilterDrawer } from './components/FilterDrawer.tsx';
import { BrandNamingModal, brandOptions } from './components/BrandNamingModal.tsx';
import { GenderSpecificTests } from './components/GenderSpecificTests.tsx';

export default function App() {
  const { t } = useLocale();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return window.localStorage.getItem('vow-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { window.localStorage.setItem('vow-theme', theme); } catch { /* Theme still applies for this session. */ }
  }, [theme]);
  // Current user state
  const [currentUser, setCurrentUser] = useState<UserProfile>(initialCurrentUser);
  const [currentGender, setCurrentGender] = useState<Gender>('female');
  const [isLadyPremium, setIsLadyPremium] = useState<boolean>(false);
  const [deviceFrame, setDeviceFrame] = useState<DeviceFrame>('responsive');

  // Navigation tab
  const [activeTab, setActiveTab] = useState<'discovery' | 'tests' | 'chats' | 'safety' | 'monetization'>('discovery');

  // Candidate profiles
  const [profiles, setProfiles] = useState<UserProfile[]>(initialProfiles);

  // Modals state
  const [isMatrixOpen, setIsMatrixOpen] = useState(false);
  const [matrixTargetProfile, setMatrixTargetProfile] = useState<UserProfile | null>(null);
  const [isLadyPremiumOpen, setIsLadyPremiumOpen] = useState(false);
  const [isBotScannerOpen, setIsBotScannerOpen] = useState(false);
  const [botScanTargetProfile, setBotScanTargetProfile] = useState<UserProfile | null>(null);
  const [isAdManagerOpen, setIsAdManagerOpen] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  // Brand naming state
  const [currentBrandId, setCurrentBrandId] = useState<string>('vow');
  const [isBrandModalOpen, setIsBrandModalOpen] = useState(false);

  const currentBrand = brandOptions.find(b => b.id === currentBrandId) || brandOptions[0];

  // Filters state
  const [minCompatibility, setMinCompatibility] = useState(70);
  const [onlyVerified, setOnlyVerified] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState('all');
  const [selectedCity, setSelectedCity] = useState('all');
  const [intentFilter, setIntentFilter] = useState('all');
  const [assessmentRevision, setAssessmentRevision] = useState(0);
  const [discoveryMode, setDiscoveryMode] = useState<'server' | 'demo'>('server');
  const [minAge, setMinAge] = useState(18);
  const [maxAge, setMaxAge] = useState(99);

  // Superlikes & Boosts inventory
  const [superLikesCount, setSuperLikesCount] = useState(3);
  const [boostActive, setBoostActive] = useState(false);

  // Ad Stats
  // Live ad metrics start at zero; production values must come from the ad provider.
  const [adStats, setAdStats] = useState<AdStats>({
    impressions: 0,
    clicks: 0,
    rewardedWatched: 0,
    estimatedRevenueRub: 0,
    averageEcpmRub: 0
  });

  // Pre-configured chat threads
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([
    {
      id: 'thread_alexander',
      partnerProfile: initialProfiles[0],
      compatibilityScore: 97,
      createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      lastMessage: 'Александр: С радостью встречусь завтра в 19:00. Какой кофе предпочитаешь?',
      lastMessageTime: '15:20',
      unreadCount: 1,
      meetingDeadlineHoursLeft: 48,
      messages: [
        {
          id: 'm1',
          senderId: 'user_alexander',
          text: 'Добрый день, Анна! Изучил твою анкету: редкое совпадение по взглядам на семью и детей.',
          timestamp: 'Вчера 18:40'
        },
        {
          id: 'm2',
          senderId: 'current_user',
          text: 'Привет, Александр! Меня приятно удивили твои ответы про брак и ответственность.',
          timestamp: 'Вчера 19:10'
        },
        {
          id: 'm3',
          senderId: 'user_alexander',
          text: 'В Vow есть отличное правило: не тратить недели на переписки. Предлагаю живую встречу!',
          timestamp: 'Сегодня 14:30'
        },
        {
          id: 'm4',
          senderId: 'user_alexander',
          text: 'Приглашение на встречу',
          timestamp: 'Сегодня 15:20',
          isDateInvite: true,
          dateInviteDetails: {
            place: 'Уютная кофейня в центре',
            day: 'Завтра',
            time: '19:00',
            status: 'pending'
          }
        }
      ]
    },
    {
      id: 'thread_dmitry',
      partnerProfile: initialProfiles[1],
      compatibilityScore: 92,
      createdAt: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
      lastMessage: 'Дмитрий: Отправил симпатию. Ценю искренность.',
      lastMessageTime: '11:05',
      unreadCount: 0,
      meetingDeadlineHoursLeft: 62,
      messages: [
        {
          id: 'dm1',
          senderId: 'user_dmitry',
          text: 'Здравствуйте, Анна! Рад взаимной симпатии. Вижу совпадение по ценностям.',
          timestamp: '11:05'
        }
      ]
    }
  ]);

  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>('thread_alexander');
  // Prototype conversations are opt-in so they cannot be mistaken for real matches.
  const [showDemoChats, setShowDemoChats] = useState(false);

  // Demo-only persistence: keep the prototype usable across refreshes on this device.
  // Production accounts and cross-device sync must use an authenticated backend.
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('nit-demo-state-v1');
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        if (saved.currentUser) setCurrentUser(saved.currentUser as UserProfile);
        if (saved.currentGender === 'female' || saved.currentGender === 'male') setCurrentGender(saved.currentGender);
        if (Array.isArray(saved.profiles)) setProfiles(saved.profiles as UserProfile[]);
        if (Array.isArray(saved.chatThreads)) setChatThreads(saved.chatThreads as ChatThread[]);
        if (saved.adStats && typeof saved.adStats === 'object') setAdStats(saved.adStats as AdStats);
        if (typeof saved.currentBrandId === 'string') setCurrentBrandId(saved.currentBrandId);
        if (typeof saved.minCompatibility === 'number') setMinCompatibility(saved.minCompatibility);
        if (typeof saved.onlyVerified === 'boolean') setOnlyVerified(saved.onlyVerified);
        if (typeof saved.selectedCountry === 'string') setSelectedCountry(saved.selectedCountry);
        if (typeof saved.selectedCity === 'string') setSelectedCity(saved.selectedCity);
        if (typeof saved.intentFilter === 'string') setIntentFilter(saved.intentFilter);
        if (typeof saved.superLikesCount === 'number') setSuperLikesCount(saved.superLikesCount);
        if (typeof saved.boostActive === 'boolean') setBoostActive(saved.boostActive);
        if (typeof saved.activeTab === 'string' && ['discovery', 'tests', 'chats', 'safety', 'monetization'].includes(saved.activeTab)) {
          setActiveTab(saved.activeTab as 'discovery' | 'tests' | 'chats' | 'safety' | 'monetization');
        }
        if (typeof saved.activeChatThreadId === 'string' || saved.activeChatThreadId === null) {
          setActiveChatThreadId(saved.activeChatThreadId as string | null);
        }
      }
    } catch {
      // Ignore stale or malformed local demo data and continue with sample defaults.
    } finally {
      setIsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      window.localStorage.setItem('nit-demo-state-v1', JSON.stringify({
        currentUser, currentGender, profiles, chatThreads, adStats,
        currentBrandId, minCompatibility, onlyVerified, selectedCountry, selectedCity, intentFilter,
        superLikesCount, boostActive, activeTab, activeChatThreadId
      }));
    } catch {
      // Storage can be disabled or full; the app remains usable for this session.
    }
  }, [
    isHydrated, currentUser, currentGender, profiles, chatThreads, adStats,
    currentBrandId, minCompatibility, onlyVerified, selectedCountry, selectedCity, intentFilter,
    superLikesCount, boostActive, activeTab, activeChatThreadId
  ]);

  // Paid status comes from the authenticated backend, never from local demo storage.
  useEffect(() => {
    let active = true;
    const refreshPremiumStatus = async () => {
      try {
        const response = await fetch('/api/billing/status', { credentials: 'include' });
        if (!response.ok) { if (active) setIsLadyPremium(false); return; }
        const data = await response.json();
        if (active) setIsLadyPremium(Boolean(data?.premiumActive));
      } catch {
        if (active) setIsLadyPremium(false);
      }
    };
    void refreshPremiumStatus();
    window.addEventListener('focus', refreshPremiumStatus);
    window.addEventListener('vow:session-changed', refreshPremiumStatus);
    return () => { active = false; window.removeEventListener('focus', refreshPremiumStatus); window.removeEventListener('vow:session-changed', refreshPremiumStatus); };
  }, []);

  // A confirmed mutual server match should take the user straight to real chats.
  useEffect(() => {
    const openChatsForMatch = () => setActiveTab('chats');
    window.addEventListener('vow:match-created', openChatsForMatch);
    return () => window.removeEventListener('vow:match-created', openChatsForMatch);
  }, []);

  // Gender persona toggle (strictly binary: Female seeking Male, Male seeking Female)
  const handleToggleGender = () => {
    // The gender switch is a demo persona switch, not a paid-account transfer.
    if (currentGender === 'female') {
      setCurrentGender('male');
      setCurrentUser(prev => ({
        ...prev,
        name: 'Александр',
        gender: 'male',
        occupation: 'Руководитель проектов & Архитектор',
        avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&auto=format&fit=crop&q=80',
        photos: ['https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800&auto=format&fit=crop&q=80'],
        bio: 'Ищу будущую жену и хранительницу очага для создания крепкой традиционной семьи.',
        mbti: 'ENTJ • Лидер & Стратег'
      }));
      // Switch active chats to female candidates
      setChatThreads([
        {
          id: 'thread_elena',
          partnerProfile: initialProfiles[3], // Elena (female)
          compatibilityScore: 98,
          createdAt: new Date(Date.now() - 16 * 3600 * 1000).toISOString(),
          lastMessage: 'Елена: Здравствуйте! Рада взаимной симпатии. Для меня семья тоже на 1 месте.',
          lastMessageTime: '14:20',
          unreadCount: 1,
          meetingDeadlineHoursLeft: 56,
          messages: [
            {
              id: 'em1',
              senderId: 'user_elena',
              text: 'Здравствуйте! У нас очень совпадают взгляды на семью и детей.',
              timestamp: 'Вчера 20:15'
            },
            {
              id: 'em2',
              senderId: 'current_user',
              text: 'Привет, Елена! В нашем приложении ценится живое общение. Буду рад пригласить вас на кофе.',
              timestamp: 'Сегодня 11:30'
            },
            {
              id: 'em3',
              senderId: 'user_elena',
              text: 'С удовольствием! Ценю решительных и надежных мужчин.',
              timestamp: '14:20'
            }
          ]
        },
        {
          id: 'thread_sofia',
          partnerProfile: initialProfiles[4], // Sofia (female)
          compatibilityScore: 95,
          createdAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
          lastMessage: 'София: Отправила вам симпатию! Хорошего дня!',
          lastMessageTime: '09:40',
          unreadCount: 0,
          meetingDeadlineHoursLeft: 66,
          messages: [
            {
              id: 'sm1',
              senderId: 'user_sofia',
              text: 'Добрый день! Прочитала вашу анкету, очень откликаются ваши цели на брак.',
              timestamp: '09:40'
            }
          ]
        }
      ]);
      setActiveChatThreadId('thread_elena');
    } else {
      setCurrentGender('female');
      setCurrentUser(initialCurrentUser);
      // Restore chats with male candidates
      setChatThreads([
        {
          id: 'thread_alexander',
          partnerProfile: initialProfiles[0],
          compatibilityScore: 97,
          createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
          lastMessage: 'Александр: С радостью встречусь завтра в 19:00. Какой кофе предпочитаешь?',
          lastMessageTime: '15:20',
          unreadCount: 1,
          meetingDeadlineHoursLeft: 48,
          messages: [
            {
              id: 'm1',
              senderId: 'user_alexander',
              text: 'Добрый день, Анна! Изучил твою анкету: редкое совпадение по взглядам на семью и детей.',
              timestamp: 'Вчера 18:40'
            },
            {
              id: 'm2',
              senderId: 'current_user',
              text: 'Привет, Александр! Меня приятно удивили твои ответы про брак и ответственность.',
              timestamp: 'Вчера 19:10'
            },
            {
              id: 'm3',
              senderId: 'user_alexander',
              text: 'В Vow есть отличное правило: не тратить недели на переписки. Предлагаю живую встречу!',
              timestamp: 'Сегодня 14:30'
            },
            {
              id: 'm4',
              senderId: 'user_alexander',
              text: 'Приглашение на встречу',
              timestamp: 'Сегодня 15:20',
              isDateInvite: true,
              dateInviteDetails: {
                place: 'Уютная кофейня в центре',
                day: 'Завтра',
                time: '19:00',
                status: 'pending'
              }
            }
          ]
        },
        {
          id: 'thread_dmitry',
          partnerProfile: initialProfiles[1],
          compatibilityScore: 92,
          createdAt: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
          lastMessage: 'Дмитрий: Отправил симпатию. Ценю искренность.',
          lastMessageTime: '11:05',
          unreadCount: 0,
          meetingDeadlineHoursLeft: 62,
          messages: [
            {
              id: 'dm1',
              senderId: 'user_dmitry',
              text: 'Здравствуйте, Анна! Рад взаимной симпатии. Вижу совпадение по ценностям.',
              timestamp: '11:05'
            }
          ]
        }
      ]);
      setActiveChatThreadId('thread_alexander');
    }
  };

  // Like candidate
  const handleLike = (target: UserProfile) => {
    if (target.isSponsorAd) return;

    // A like is not a match. A chat is opened only for a reciprocal demo like.
    setProfiles(prev => prev.map(profile =>
      profile.id === target.id ? { ...profile, likedByMe: true } : profile
    ));

    if (!target.likedByCandidate) return;
    const existing = chatThreads.find(t => t.partnerProfile.id === target.id);
    if (existing) return;

    const comp = calculateCompatibility(
      currentUser.crucialAnswers,
      currentUser.intent,
      currentUser.interests,
      target
    );
    const newThread: ChatThread = {
      id: `thread_${target.id}_${Date.now()}`,
      partnerProfile: target,
      compatibilityScore: comp.overallScore,
      createdAt: new Date().toISOString(),
      lastMessage: 'Взаимная симпатия — можно начать разговор',
      lastMessageTime: 'Только что',
      unreadCount: 0,
      meetingDeadlineHoursLeft: 72,
      messages: []
    };
    setChatThreads(prev => [newThread, ...prev]);
  };

  // Superlike
  const handleSuperLike = (target: UserProfile) => {
    if (target.isSponsorAd || target.superLikedByMe) return false;
    if (superLikesCount > 0) {
      setSuperLikesCount(prev => prev - 1);
    } else if (currentGender === 'male') {
      setIsAdManagerOpen(true);
      return false;
    } else if (!isLadyPremium) {
      setIsLadyPremiumOpen(true);
      return false;
    }
    handleLike(target);
    setProfiles(prev => prev.map(profile => profile.id === target.id ? { ...profile, superLikedByMe: true } : profile));
    return true;
  };

  const handleUndoDemoAction = (
    target: UserProfile,
    action: 'like' | 'superLike',
    previousState: { likedByMe: boolean; superLikedByMe: boolean }
  ) => {
    // A mutual match is a durable state transition; do not undo it from discovery.
    if (chatThreads.some(thread => thread.partnerProfile.id === target.id)) return false;
    setProfiles(prev => prev.map(profile => profile.id === target.id
      ? { ...profile, likedByMe: previousState.likedByMe, superLikedByMe: previousState.superLikedByMe }
      : profile));
    // Refund only a super-like actually spent by this action.
    if (action === 'superLike' && !previousState.superLikedByMe) {
      setSuperLikesCount(count => count + 1);
    }
    return true;
  };

  // Pass candidate
  const handlePass = (_target: UserProfile) => {
    // Skipping a profile is not an ad impression or revenue event.
  };

  // Send message
  const handleSendMessage = (threadId: string, text: string) => {
    setChatThreads(prev =>
      prev.map(t => {
        if (t.id === threadId) {
          const newMsg = {
            id: `msg_${Date.now()}`,
            senderId: 'current_user',
            text,
            timestamp: 'Только что'
          };
          return {
            ...t,
            lastMessage: `Вы: ${text}`,
            lastMessageTime: 'Только что',
            messages: [...t.messages, newMsg]
          };
        }
        return t;
      })
    );
  };

  // Send date invitation
  const handleSendDateInvite = (threadId: string, place: string, day: string, time: string) => {
    setChatThreads(prev =>
      prev.map(t => {
        if (t.id === threadId) {
          const inviteMsg = {
            id: `invite_${Date.now()}`,
            senderId: 'current_user',
            text: 'Приглашение на первое свидание',
            timestamp: 'Только что',
            isDateInvite: true,
            dateInviteDetails: {
              place,
              day,
              time,
              status: 'pending' as const
            }
          };
          return {
            ...t,
            lastMessage: `Приглашение: ${place} (${day}, ${time})`,
            lastMessageTime: 'Только что',
            messages: [...t.messages, inviteMsg]
          };
        }
        return t;
      })
    );
  };

  // Accept date invite
  const handleAcceptDateInvite = (threadId: string, messageId: string) => {
    setChatThreads(prev =>
      prev.map(t => {
        if (t.id === threadId) {
          return {
            ...t,
            messages: t.messages.map(m => {
              if (m.id === messageId && m.dateInviteDetails) {
                return {
                  ...m,
                  dateInviteDetails: {
                    ...m.dateInviteDetails,
                    status: 'accepted'
                  }
                };
              }
              return m;
            })
          };
        }
        return t;
      })
    );
  };

  // Rewarded ad completed
  const handleWatchRewardedAd = () => {
    setSuperLikesCount(prev => prev + 3);
    setBoostActive(true);
    setAdStats(prev => ({
      ...prev,
      rewardedWatched: prev.rewardedWatched + 1
    }));
  };

  // Report profile
  const handleReportProfile = (profileId: string, reason: string) => {
    setProfiles(prev =>
      prev.map(p => {
        if (p.id === profileId) {
          return {
            ...p,
            verification: {
              ...p.verification,
              reportCount: p.verification.reportCount + 1,
              botRiskLevel: 'high',
              noBotScore: Math.max(10, p.verification.noBotScore - 30)
            }
          };
        }
        return p;
      })
    );
  };

  // Filtered profiles strictly binary (Women see Men, Men see Women)
  const binaryPool = filterBinaryCandidates(profiles, currentGender);
  const filteredProfiles = binaryPool.filter(p => {
    // Premium members browse without sponsored placements.
    if (p.isSponsorAd) return !isLadyPremium;
    if (onlyVerified && !p.verification.isVerified) return false;
    if (!matchesProfileLocation(p, selectedCountry, selectedCity)) return false;
    if (p.age < minAge || p.age > maxAge) return false;
    if (intentFilter !== 'all' && p.intent !== intentFilter) return false;
    const comp = calculateCompatibility(
      currentUser.crucialAnswers,
      currentUser.intent,
      currentUser.interests,
      p
    );
    if (comp.overallScore < minCompatibility) return false;
    return true;
  });

  const unreadCount = chatThreads.reduce((acc, t) => acc + t.unreadCount, 0);

  // Content switcher
  const renderMainContent = () => {
    switch (activeTab) {
      case 'tests':
        return (
          <>
            <AccountAccessPanel onAuthenticated={() => setAssessmentRevision(value => value + 1)} />
            <NotificationCenterPanel />
            <ProfileEditorPanel key={assessmentRevision} onOpenAccount={() => setActiveTab('tests')} />
            <ModeratorConsolePanel />
            <RelationshipAssessmentPanel key={assessmentRevision} />
            <GenderSpecificTests
            currentGender={currentGender}
            onOpenMatrix={profile => {
              setMatrixTargetProfile(profile || profiles[0]);
              setIsMatrixOpen(true);
            }}
            brandName={currentBrand.name}
          />
          </>
        );

      case 'chats':
        return (
          <>
            <ServerMatchesPanel onOpenAccount={() => setActiveTab('tests')} />
            {!showDemoChats ? (
              <section className="mx-auto mt-4 w-full max-w-md rounded-2xl border border-white/10 bg-stone-900 p-4 text-left">
                <h3 className="font-semibold text-white">{t('demoChatsHiddenTitle')}</h3>
                <p className="mt-2 text-sm leading-relaxed text-stone-300">{t('demoChatsHiddenDescription')}</p>
                <button
                  type="button"
                  onClick={() => {
                    setActiveChatThreadId(null);
                    setShowDemoChats(true);
                  }}
                  className="mt-4 min-h-11 w-full rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                >
                  {t('showDemoChats')}
                </button>
              </section>
            ) : (
              <>
                <div role="status" className="mb-3 mt-4 rounded-xl border border-amber-400/30 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-100">
                  <strong className="mr-1">DEMO / ДЕМО:</strong>
                  {t('demoChatsPrototypeNotice')}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowDemoChats(false);
                    setActiveChatThreadId(null);
                  }}
                  className="mb-3 min-h-11 rounded-xl border border-white/10 px-4 py-2 text-sm text-stone-300 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                >
                  {t('hideDemoChats')}
                </button>
                <ChatMessenger
                  threads={chatThreads}
                  activeThreadId={activeChatThreadId}
                  onSelectThread={id => setActiveChatThreadId(id)}
                  onSendMessage={handleSendMessage}
                  onSendDateInvite={handleSendDateInvite}
                  onAcceptDateInvite={handleAcceptDateInvite}
                  isLadyPremium={isLadyPremium}
                  onOpenLadyPremium={() => setIsLadyPremiumOpen(true)}
                  onBackToList={() => setActiveChatThreadId(null)}
                />
              </>
            )}
          </>
        );

      case 'safety':
        return (
          <div className="w-full max-w-md mx-auto p-2 text-left">
            <div className="p-5 rounded-3xl bg-stone-900 border border-white/10 shadow-2xl mb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-950 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                  <Brain className="w-5 h-5 text-rose-400" />
                </div>
                <div>
                  <h3 className="font-heading font-black text-white text-base">Психотипы & Защита от ботов</h3>
                  <p className="text-[11px] text-stone-400">Демо-анализ анкеты; проверка личности не подключена</p>
                </div>
              </div>

              <p className="text-xs text-stone-300 leading-relaxed mb-4">
                В демо можно оценить ответы и текст анкеты. Биометрическая проверка, поведенческий анализ и серверная модерация пока не подключены.
              </p>

              <div className="space-y-2 mb-4">
                <div className="text-[11px] font-bold text-white uppercase tracking-wider">
                  Проверить профили кандидатов:
                </div>
                {profiles.map(p => (
                  <div
                    key={p.id}
                    onClick={() => {
                      setBotScanTargetProfile(p);
                      setIsBotScannerOpen(true);
                    }}
                    className="p-2.5 rounded-2xl bg-stone-950 border border-white/5 hover:border-rose-500/40 cursor-pointer flex items-center justify-between transition-all"
                  >
                    <div className="flex items-center gap-2.5">
                      <img src={p.photos[0] || p.avatar} alt={p.name} className="w-9 h-9 rounded-xl object-cover" />
                      <div>
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                          <span>{p.name}</span>
                          {p.mbti && <span className="text-[10px] text-rose-400 font-normal">({p.mbti.split('•')[0]})</span>}
                        </div>
                        <div className="text-[10px] text-stone-400">{p.occupation || p.city}</div>
                      </div>
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      p.verification.isVerified ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'
                    }`}>
                      {p.verification.isVerified ? 'Проверен (демо)' : 'Не проверен'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );

      case 'monetization':
        return (
          <div className="w-full max-w-md mx-auto p-2 text-left">
            <div className="p-5 rounded-3xl bg-stone-900 border border-white/10 shadow-2xl mb-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-950 text-amber-400 flex items-center justify-center border border-amber-500/30">
                  <DollarSign className="w-5 h-5 stroke-[2.5]" />
                </div>
                <div>
                  <h3 className="font-heading font-black text-white text-base">Монетизация платформы</h3>
                  <p className="text-[11px] text-stone-400">Реклама + Lady VIP Club</p>
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-stone-950/70 border border-white/5 mb-4 text-xs text-stone-300 leading-relaxed">
                <strong className="text-white block mb-1">Принцип монетизации:</strong>
                Планируемая модель: бесплатный базовый доступ для мужчин, спонсорские размещения и подписка Lady VIP. Реальные рекламные и платёжные интеграции пока не подключены.
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setIsAdManagerOpen(true)}
                  className="flex-1 py-3 rounded-2xl bg-amber-500 hover:bg-amber-400 font-bold text-stone-950 text-xs transition-colors flex items-center justify-center gap-1.5"
                >
                  <DollarSign className="w-4 h-4" />
                  <span>Статистика рекламы</span>
                </button>
                <button
                  onClick={() => setIsLadyPremiumOpen(true)}
                  className="flex-1 py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 font-bold text-white text-xs transition-colors flex items-center justify-center gap-1.5"
                >
                  <Crown className="w-4 h-4" />
                  <span>Тарифы Lady VIP</span>
                </button>
              </div>
            </div>
          </div>
        );

      case 'discovery':
      default:
        return discoveryMode === 'server' ? (
          <>
            <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-emerald-500/20 bg-stone-900/70 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-white">{t('serverProfilesNotice')}</p>
                <p className="mt-1 text-xs text-stone-400">{t('serverProfilesDescription')}</p>
              </div>
              <button type="button" data-testid="open-demo-preview" onClick={() => setDiscoveryMode('demo')} className="min-h-11 rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-stone-300">{t('openDemoPreview')}</button>
            </div>
            <ServerDiscoveryPanel onOpenAccount={() => setActiveTab('tests')} />
          </>
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-amber-500/20 bg-amber-950/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-amber-100">{t('demoProfilesNotice')}</p>
                <p className="mt-1 text-xs text-amber-200/70">{t('demoProfilesDescription')}</p>
              </div>
              <button type="button" onClick={() => setDiscoveryMode('server')} className="min-h-11 rounded-xl border border-amber-200/20 px-3 py-2 text-xs font-semibold text-amber-100">{t('returnToRealProfiles')}</button>
            </div>
            <RadarDiscovery
            profiles={filteredProfiles}
            myAnswers={currentUser.crucialAnswers}
            myIntent={currentUser.intent}
            myInterests={currentUser.interests}
            isLadyPremium={isLadyPremium}
            onLike={handleLike}
            onSuperLike={handleSuperLike}
            onUndoAction={handleUndoDemoAction}
            onPass={handlePass}
            onOpenCompatibilityMatrix={profile => {
              setMatrixTargetProfile(profile);
              setIsMatrixOpen(true);
            }}
            onInspectBotSafety={profile => {
              setBotScanTargetProfile(profile);
              setIsBotScannerOpen(true);
            }}
            onOpenLadyPremium={() => setIsLadyPremiumOpen(true)}
            onOpenAdManager={() => setIsAdManagerOpen(true)}
            onOpenFilters={() => setIsFilterOpen(true)}
            onAdClicked={() => {
              setAdStats(prev => ({
                ...prev,
                clicks: prev.clicks + 1,
                estimatedRevenueRub: prev.estimatedRevenueRub
              }));
            }}
          />
          </>
        );
    }
  };

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 flex flex-col items-center">
      <PWAInstallBanner />
      {/* Prototype disclosure: prevents mock data from being mistaken for verified production activity. */}
      <div role="status" className="w-full border-b border-amber-500/20 bg-amber-950/70 px-3 py-2 text-center text-[11px] text-amber-100 flex flex-col sm:flex-row items-center justify-center gap-2">
        <span>{t('prototypeNotice')}</span>
        <button
          type="button"
          onClick={() => {
            try {
              window.localStorage.removeItem('nit-demo-state-v1');
            } catch {
              // The page can still be reloaded if storage is unavailable.
            }
            window.location.reload();
          }}
          className="min-h-11 shrink-0 rounded-full border border-amber-200/30 px-2.5 py-1 font-bold hover:bg-amber-900/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200"
        >
          {t('resetDemo')}
        </button>
      </div>
      {/* Device Mode Wrapper */}
      <div className="w-full flex flex-col items-center flex-1">
        {deviceFrame === 'responsive' ? (
          /* RESPONSIVE FULL WEB / MOBILE */
          <div className="w-full flex flex-col min-h-screen">
            {/* NIT header */}
            <HeaderNav
              theme={theme}
              onToggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
              currentGender={currentGender}
              isLadyPremium={isLadyPremium}
              deviceFrame={deviceFrame}
              brandName={currentBrand.name}
              onOpenBrandModal={() => setIsBrandModalOpen(true)}
              onToggleGender={handleToggleGender}
              onToggleDeviceFrame={setDeviceFrame}
              onOpenPremiumModal={() => setIsLadyPremiumOpen(true)}
              onOpenBotScanner={() => {
                setBotScanTargetProfile(profiles[0]);
                setIsBotScannerOpen(true);
              }}
              onOpenAdManager={() => setIsAdManagerOpen(true)}
              onOpenFilters={() => setIsFilterOpen(true)}
              showFilters={activeTab === 'discovery' && discoveryMode === 'demo'}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              unreadChatsCount={unreadCount}
            />

            {/* Main Stage */}
            <main className="flex-1 w-full max-w-xl mx-auto px-3 sm:px-4 py-3 sm:py-5 flex flex-col items-center pb-28">
              {renderMainContent()}
            </main>

            {/* Bottom navigation dock */}
            <div role="navigation" aria-label={t('primaryNavigation')} className="vow-bottom-nav fixed bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] left-1/2 z-30 flex w-[calc(100%-1rem)] max-w-md -translate-x-1/2 items-stretch justify-around gap-1 rounded-[1.6rem] border border-white/10 bg-stone-950/90 px-2 py-2 shadow-2xl shadow-black/30 backdrop-blur-2xl lg:hidden">
              <button
                onClick={() => setActiveTab('discovery')}
                aria-current={activeTab === 'discovery' ? 'page' : undefined}
                className={`vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 transition-colors ${
                  activeTab === 'discovery' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5 hover:text-white'
                }`}
                title={t('radar')}
              >
                <Heart className={`w-5 h-5 ${activeTab === 'discovery' ? 'fill-rose-500' : ''}`} />
                <span className="text-[10px] leading-tight">{t('radar')}</span>
              </button>

              <button
                data-testid="mobile-nav-tests"
                onClick={() => setActiveTab('tests')}
                aria-current={activeTab === 'tests' ? 'page' : undefined}
                className={`vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 transition-colors ${
                  activeTab === 'tests' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5 hover:text-white'
                }`}
                title={t('tests')}
              >
                <Brain className="w-5 h-5" />
                <span className="text-[10px] leading-tight">{t('testsShort')}</span>
              </button>

              <button
                onClick={() => setActiveTab('chats')}
                data-testid="nav-chats"
                aria-current={activeTab === 'chats' ? 'page' : undefined}
                className={`vow-motion-button relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 transition-colors ${
                  activeTab === 'chats' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5 hover:text-white'
                }`}
                title={t('chats')}
              >
                <MessageCircle className="w-5 h-5" />
                <span className="text-[10px] leading-tight">{t('chatsShort')}</span>
                {unreadCount > 0 && (
                  <span aria-label={`${unreadCount}`} className="absolute right-1 top-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-black leading-none text-stone-950">{unreadCount > 99 ? '99+' : unreadCount}</span>
                )}
              </button>

              <button
                onClick={() => setActiveTab('safety')}
                aria-current={activeTab === 'safety' ? 'page' : undefined}
                className={`vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 transition-colors ${
                  activeTab === 'safety' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5 hover:text-white'
                }`}
                title={t('safety')}
              >
                <ShieldCheck className="w-5 h-5" />
                <span className="text-[10px] leading-tight">{t('safetyShort')}</span>
              </button>

              {currentGender === 'female' && (
                <button
                  onClick={() => setIsLadyPremiumOpen(true)}
                  className="vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-amber-400 transition-colors hover:bg-amber-400/10 hover:text-amber-300 font-bold"
                  title="Lady VIP — демо-подписка"
                >
                  <Crown className="w-5 h-5 fill-amber-400/20" />
                  <span className="text-[9px]">VIP</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          /* NATIVE SMARTPHONE EMULATOR FRAME (iPhone / Android) */
          <div className="py-4 px-2 flex flex-col items-center w-full">
            <div className="mb-2 text-xs text-stone-400 flex items-center gap-2">
              <Smartphone className="w-3.5 h-3.5 text-rose-500" />
              <span>Эмуляция:</span>
              <strong className="text-white">
                {deviceFrame === 'iphone' ? 'Apple iPhone 16 Pro' : 'Samsung Galaxy S25'}
              </strong>
              <button
                onClick={() => setDeviceFrame('responsive')}
                className="ml-2 text-rose-400 hover:underline"
              >
                Веб-режим
              </button>
            </div>

            {/* Phone Chassis */}
            <div className={`relative w-full max-w-[390px] h-[780px] rounded-[48px] p-2.5 shadow-2xl transition-all ${
              deviceFrame === 'iphone'
                ? 'bg-stone-900 border-[7px] border-stone-800 ring-2 ring-white/10'
                : 'bg-stone-900 border-[5px] border-stone-800 ring-2 ring-white/10 rounded-[40px]'
            }`}>
              {/* Dynamic Island */}
              {deviceFrame === 'iphone' ? (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 w-26 h-5.5 bg-black rounded-full z-40 flex items-center justify-between px-2 text-[10px] text-white">
                  <div className="w-2 h-2 rounded-full bg-stone-900"></div>
                  <div className="w-2 h-2 rounded-full bg-stone-900"></div>
                </div>
              ) : (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 w-3 h-3 bg-black rounded-full z-40 ring-1 ring-stone-700"></div>
              )}

              {/* Inside Viewport */}
              <div className="w-full h-full rounded-[38px] overflow-hidden bg-stone-950 flex flex-col relative">
                {/* Status Bar */}
                <div className="w-full px-6 pt-2 pb-0.5 flex items-center justify-between text-[11px] font-semibold text-white z-30 select-none">
                  <span>09:41</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px]">5G</span>
                    <div className="w-4 h-2 rounded-sm border border-white p-0.2">
                      <div className="w-2.5 h-full bg-white rounded-xs"></div>
                    </div>
                  </div>
                </div>

                {/* Minimal Header inside phone */}
                <HeaderNav
                  theme={theme}
                  onToggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
                  currentGender={currentGender}
                  isLadyPremium={isLadyPremium}
                  deviceFrame={deviceFrame}
                  brandName={currentBrand.name}
                  onOpenBrandModal={() => {}}
                  onToggleGender={handleToggleGender}
                  onToggleDeviceFrame={setDeviceFrame}
                  onOpenPremiumModal={() => setIsLadyPremiumOpen(true)}
                  onOpenBotScanner={() => {
                    setBotScanTargetProfile(profiles[0]);
                    setIsBotScannerOpen(true);
                  }}
                  onOpenAdManager={() => setIsAdManagerOpen(true)}
                  onOpenFilters={() => setIsFilterOpen(true)}
                  showFilters={activeTab === 'discovery' && discoveryMode === 'demo'}
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  unreadChatsCount={unreadCount}
                />

                {/* Main Content inside phone */}
                <div className="flex-1 overflow-y-auto p-2 no-scrollbar pb-16">
                  {renderMainContent()}
                </div>

                {/* Mobile Bottom Dock inside phone */}
                <div role="navigation" aria-label={t('primaryNavigation')} className="absolute bottom-3 left-3 right-3 z-30 flex items-stretch justify-around gap-1 rounded-[1.4rem] border border-white/10 bg-stone-900/95 px-2 py-2 shadow-2xl backdrop-blur-xl">
                  <button
                    onClick={() => setActiveTab('discovery')}
                aria-current={activeTab === 'discovery' ? 'page' : undefined}
                    className={`vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 ${
                      activeTab === 'discovery' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5'
                    }`}
                  >
                    <Heart className={`w-4 h-4 ${activeTab === 'discovery' ? 'fill-rose-500' : ''}`} />
                    <span className="text-[9px] leading-tight">{t('radar')}</span>
                  </button>

                  <button
                    onClick={() => setActiveTab('tests')}
                aria-current={activeTab === 'tests' ? 'page' : undefined}
                    className={`vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 ${
                      activeTab === 'tests' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5'
                    }`}
                  >
                    <Brain className="w-4 h-4" />
                    <span className="text-[9px] leading-tight">{t('testsShort')}</span>
                  </button>

                  <button
                    onClick={() => setActiveTab('chats')}
                data-testid="nav-chats"
                aria-current={activeTab === 'chats' ? 'page' : undefined}
                    className={`vow-motion-button relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 ${
                      activeTab === 'chats' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5'
                    }`}
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span className="text-[9px] leading-tight">{t('chatsShort')}</span>
                    {unreadCount > 0 && (
                      <span
                        aria-label={`${t('chatsShort')}: ${unreadCount}`}
                        className="absolute -top-1 -right-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-black leading-none text-stone-950"
                      >
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </button>

                  <button
                    onClick={() => setActiveTab('safety')}
                aria-current={activeTab === 'safety' ? 'page' : undefined}
                    className={`vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 ${
                      activeTab === 'safety' ? 'bg-rose-500/10 text-rose-400 font-bold' : 'text-stone-400 hover:bg-white/5'
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span className="text-[9px] leading-tight">{t('safetyShort')}</span>
                  </button>

                  {currentGender === 'female' && (
                    <button
                      onClick={() => setIsLadyPremiumOpen(true)}
                      className="vow-motion-button flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-amber-400 font-bold"
                    >
                      <Crown className="w-4 h-4" />
                      <span className="text-[8px]">VIP</span>
                    </button>
                  )}
                </div>

                {/* Home Indicator bar */}
                <div className="w-full pb-1 flex justify-center bg-stone-950">
                  <div className="w-24 h-1 rounded-full bg-stone-600"></div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MODALS */}
      {/* 1. Deep Compatibility Matrix */}
      <CompatibilityMatrixModal
        isOpen={isMatrixOpen}
        onClose={() => setIsMatrixOpen(false)}
        profile={matrixTargetProfile}
        myAnswers={currentUser.crucialAnswers}
        myIntent={currentUser.intent}
        myInterests={currentUser.interests}
        onStartChat={profile => {
          handleLike(profile);
          setActiveTab(profile.likedByCandidate ? 'chats' : 'discovery');
        }}
      />

      {/* 2. Lady Premium Club Modal */}
      <LadyPremiumModal
        isOpen={isLadyPremiumOpen}
        onClose={() => setIsLadyPremiumOpen(false)}
      />

      {/* 3. Bot & Safety Scanner */}
      <BotSafetyScanner
        isOpen={isBotScannerOpen}
        onClose={() => setIsBotScannerOpen(false)}
        targetProfile={botScanTargetProfile}
        onReportProfile={handleReportProfile}
      />

      {/* 4. Ad Revenue Manager */}
      <AdManagerModal
        isOpen={isAdManagerOpen}
        onClose={() => setIsAdManagerOpen(false)}
        stats={adStats}
        onWatchRewardedAd={handleWatchRewardedAd}
        superLikesCount={superLikesCount}
        boostActive={boostActive}
      />

      {/* 5. Filter Drawer */}
      <FilterDrawer
        isOpen={isFilterOpen}
        onClose={() => setIsFilterOpen(false)}
        minCompatibility={minCompatibility}
        setMinCompatibility={setMinCompatibility}
        onlyVerified={onlyVerified}
        setOnlyVerified={setOnlyVerified}
        selectedCountry={selectedCountry}
        setSelectedCountry={setSelectedCountry}
        selectedCity={selectedCity}
        setSelectedCity={setSelectedCity}
        intentFilter={intentFilter}
        setIntentFilter={setIntentFilter}
        minAge={minAge}
        setMinAge={setMinAge}
        maxAge={maxAge}
        setMaxAge={setMaxAge}
        onApply={() => setIsFilterOpen(false)}
        onReset={() => {
          setMinCompatibility(70);
          setOnlyVerified(false);
          setSelectedCountry('all');
          setSelectedCity('all');
          setIntentFilter('all');
          setMinAge(18);
          setMaxAge(99);
        }}
      />

      {/* 6. Brand Naming Proposals Modal */}
      <BrandNamingModal
        isOpen={isBrandModalOpen}
        onClose={() => setIsBrandModalOpen(false)}
        currentBrandId={currentBrandId}
        onSelectBrand={id => setCurrentBrandId(id)}
      />
    </div>
  );
}
