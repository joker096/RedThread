import React, { useEffect, useRef, useState } from 'react';
import { 
  Send, 
  LoaderCircle,
  Clock, 
  Calendar, 
  Coffee, 
  Phone, 
  Sparkles, 
  Crown, 
  Check, 
  MapPin, 
  Video,
  ArrowLeft,
  Flame,
  AlertCircle,
  HeartHandshake,
  LockKeyhole
} from 'lucide-react';
import type { ChatThread, Message, UserProfile } from '../types/index.ts';
import { checkAntiChitChatDeadline } from '../utils/compatibility.ts';
import { PartnerServicesMarketplace } from './PartnerServicesMarketplace.tsx';
import { useLocale } from '../i18n/LocaleProvider';

interface ChatMessengerProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onSendMessage: (threadId: string, text: string) => void | Promise<void>;
  onSendDateInvite: (threadId: string, place: string, day: string, time: string) => void;
  onAcceptDateInvite: (threadId: string, messageId: string) => void;
  isLadyPremium: boolean;
  onOpenLadyPremium: () => void;
  onBackToList: () => void;
}

export const ChatMessenger: React.FC<ChatMessengerProps> = ({
  threads,
  activeThreadId,
  onSelectThread,
  onSendMessage,
  onSendDateInvite,
  onAcceptDateInvite,
  isLadyPremium,
  onOpenLadyPremium,
  onBackToList
}) => {
  const { t, locale } = useLocale();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  const sendingThreadIdsRef = useRef(new Set<string>());
  const [sendingThreadIds, setSendingThreadIds] = useState<Set<string>>(new Set());
  const [showInviteModal, setShowInviteModal] = useState(false);
  const inviteDialogRef = useRef<HTMLDivElement | null>(null);
  const messagesLogRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollMessagesRef = useRef(true);

  useEffect(() => {
    if (!showInviteModal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = inviteDialogRef.current;
    const getFocusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []).filter(element => !element.closest('[aria-hidden="true"], [hidden], [inert]'));
    getFocusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowInviteModal(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(getFocusable());
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [showInviteModal]);
  const [selectedPlace, setSelectedPlace] = useState('cafe');
  const [selectedDay, setSelectedDay] = useState('tomorrow');
  const [selectedTime, setSelectedTime] = useState('19:00');
  const [showDirectContactUnlocked, setShowDirectContactUnlocked] = useState(false);
  const [showPartnerServices, setShowPartnerServices] = useState(false);

  // Reset thread-specific UI when switching conversations to avoid carrying
  // an invite or unlocked contact panel into a different chat.
  useEffect(() => {
    setShowInviteModal(false);
    setShowDirectContactUnlocked(false);
    setShowPartnerServices(false);
    setSelectedPlace('cafe');
    setSelectedDay('tomorrow');
    setSelectedTime('19:00');
  }, [activeThreadId]);

  const activeThread = threads.find(t => t.id === activeThreadId) || threads[0];
  const inputText = activeThread ? drafts[activeThread.id] ?? '' : '';

  useEffect(() => {
    shouldAutoScrollMessagesRef.current = true;
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread || !shouldAutoScrollMessagesRef.current) return;
    const log = messagesLogRef.current;
    if (!log) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [activeThread?.id, activeThread?.messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const thread = activeThread;
    const messageText = inputText.trim().slice(0, 10000);
    if (!messageText || !thread || sendingThreadIdsRef.current.has(thread.id)) return;

    sendingThreadIdsRef.current.add(thread.id);
    setSendingThreadIds(current => new Set(current).add(thread.id));
    setSendErrors(current => ({ ...current, [thread.id]: '' }));
    try {
      await onSendMessage(thread.id, messageText);
      setDrafts(current => (current[thread.id] ?? '').trim().slice(0, 10000) === messageText
        ? { ...current, [thread.id]: '' }
        : current);
    } catch {
      // Keep the original draft so the user can retry without retyping.
      setSendErrors(current => ({ ...current, [thread.id]: t('sendMessageError') }));
    } finally {
      sendingThreadIdsRef.current.delete(thread.id);
      setSendingThreadIds(current => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const handleCreateInvite = () => {
    if (!activeThread) return;
    const placeLabelKey = ({ cafe: 'chatPlaceCafe', park: 'chatPlacePark', dinner: 'chatPlaceDinner', video: 'chatPlaceVideo' } as const)[selectedPlace as 'cafe' | 'park' | 'dinner' | 'video'] ?? 'chatPlaceCafe';
    const dayLabelKey = ({ today: 'chatDayToday', tomorrow: 'chatDayTomorrow', saturday: 'chatDaySaturday', sunday: 'chatDaySunday' } as const)[selectedDay as 'today' | 'tomorrow' | 'saturday' | 'sunday'] ?? 'chatDayTomorrow';
    onSendDateInvite(activeThread.id, t(placeLabelKey), t(dayLabelKey), selectedTime);
    setShowInviteModal(false);
  };

  if (!activeThread) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center min-h-[400px]">
        <Coffee className="w-12 h-12 text-rose-500 mb-3" />
        <h3 className="font-heading text-lg font-bold text-white mb-1">{t('chatEmptyTitle')}</h3>
        <p className="text-xs text-stone-400 max-w-xs">
          {t('chatEmptyDescription')}
        </p>
      </div>
    );
  }

  const antiChitChat = checkAntiChitChatDeadline(activeThread.createdAt, activeThread.messages.length);

  return (
    <div className="vow-chat-layout vow-screen w-full max-w-4xl mx-auto h-[75vh] min-h-[550px] flex rounded-3xl overflow-hidden bg-stone-900 border border-rose-950/40 shadow-2xl">
      {/* Threads sidebar (desktop / tablet) */}
      <div className={`w-full md:w-80 border-e border-white/5 flex flex-col bg-stone-950/60 ${activeThreadId ? 'hidden md:flex' : 'flex'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 p-3.5">
          <div className="flex items-center gap-2">
            <h3 className="font-heading text-sm font-bold text-white">{t('chatThreads')}</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-600/30 text-rose-300 font-bold border border-rose-500/20">
              {threads.length} {t('chatMatches')}
            </span>
          </div>
          <span className="text-[10px] text-stone-400">{t('chat72HourRule')}</span>
        </div>

        {/* Anti-chit-chat notice banner */}
        <div className="p-2.5 mx-3 my-2 rounded-xl bg-rose-950/30 border border-rose-800/30 text-[11px] text-rose-200 flex items-start gap-2">
          <Clock className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>
            <strong>{t('chatDateGoal')}</strong> {t('chat72HourNotice')}
          </span>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto space-y-1 p-2">
          {threads.map(thread => {
            const isSelected = thread.id === activeThread.id;
            return (
              <button
                type="button"
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                aria-pressed={isSelected}
                className={`min-h-11 w-full text-start flex items-center gap-3 p-3 rounded-2xl cursor-pointer transition-all focus-visible:border-rose-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 ${
                  isSelected
                    ? 'bg-rose-950/50 border border-rose-800/40 text-white'
                    : 'hover:bg-stone-900 text-stone-300'
                }`}
              >
                <span className="relative block">
                  <img
                    src={thread.partnerProfile.avatar || thread.partnerProfile.photos?.[0] || ''}
                    alt={thread.partnerProfile.name}
                    loading="lazy"
                    decoding="async"
                    width={48}
                    height={48}
                    className="w-12 h-12 rounded-xl object-cover"
                  />
                  <span role="img" aria-label={`${t('compatibility')}: ${thread.compatibilityScore}%`} className="absolute -bottom-1 -end-1 px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-rose-600 text-white">
                    {thread.compatibilityScore}%
                  </span>
                </span>

                <span className="flex-1 min-w-0 text-start block">
                  <span className="flex items-center justify-between">
                    <span className="font-bold text-sm text-white truncate">
                      {thread.partnerProfile.name}
                    </span>
                    <span className="text-[10px] text-stone-400">{thread.lastMessageTime}</span>
                  </span>
                  <span dir="auto" className="block text-xs text-stone-400 truncate mt-0.5">{thread.lastMessage}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Active chat window */}
      <div className={`flex-1 flex flex-col bg-stone-900/90 ${!activeThreadId ? 'hidden md:flex' : 'flex'}`}>
        {/* Chat Header */}
        <div className="p-3 sm:p-4 border-b border-white/5 flex flex-wrap items-center justify-between gap-2 bg-stone-950/40">
          <div className="flex items-center gap-3">
            <button type="button"
              onClick={onBackToList}
              className="md:hidden flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-transparent bg-stone-800 text-stone-300 hover:text-white focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              aria-label={t('chatBackToList')}
            >
              <ArrowLeft className="vow-rtl-back-icon w-4 h-4" />
            </button>

            <div className="relative shrink-0">
              <img
                src={activeThread.partnerProfile.photos?.[0] || activeThread.partnerProfile.avatar || ''}
                alt={activeThread.partnerProfile.name}
                decoding="async"
                width={44}
                height={44}
                className="w-11 h-11 rounded-xl object-cover ring-1 ring-rose-500/40 shrink-0"
              />
            </div>

            <div className="text-start">
              <div className="flex items-center gap-1.5">
                <span className="break-words font-heading text-sm font-bold text-white sm:text-base">
                  {activeThread.partnerProfile.name}, {activeThread.partnerProfile.age}
                </span>
              </div>
              <p className="text-[11px] text-stone-400">
                {activeThread.partnerProfile.occupation} • {activeThread.partnerProfile.city}
              </p>
            </div>
          </div>

          {/* Partner services are only exposed inside an established mutual-match chat. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPartnerServices(true)}
              aria-haspopup="dialog"
              aria-expanded={showPartnerServices}
              className="flex min-h-11 min-w-11 items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-emerald-600/30 bg-emerald-950/30 text-emerald-200 font-semibold text-xs hover:bg-emerald-900/40 transition-colors focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              title={t('chatPartnerServicesTitle')}
            >
              <HeartHandshake className="w-4 h-4" />
              <span className="hidden lg:inline">{t('chatForCouple')}</span>
              <span className="lg:hidden">{t('chatServices')}</span>
            </button>
            <button type="button"
              onClick={() => setShowInviteModal(true)}
              aria-haspopup="dialog"
              aria-expanded={showInviteModal}
              className="flex min-h-11 min-w-11 items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 text-white font-semibold text-xs shadow-md shadow-rose-950 hover:from-rose-500 hover:to-red-500 transition-all focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              <Coffee className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('chatPlanDate')}</span>
              <span className="sm:hidden">{t('chatDateShort')}</span>
            </button>

            {/* Direct contact unlock button */}
            <button type="button"
              onClick={() => {
                if (!isLadyPremium) {
                  onOpenLadyPremium();
                } else {
                  setShowDirectContactUnlocked(!showDirectContactUnlocked);
                }
              }}
              className={`flex min-h-11 min-w-11 items-center justify-center p-2 rounded-xl border text-xs transition-colors focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
                isLadyPremium
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-stone-800 border-white/5 text-stone-400 hover:text-white'
              }`}
              title={isLadyPremium ? t('chatDirectContactOpen') : t('chatDirectContactVip')}
              aria-label={isLadyPremium ? t('chatDirectContactOpen') : t('chatDirectContactVip')}
              aria-pressed={isLadyPremium ? showDirectContactUnlocked : undefined}
            >
              <Phone className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Anti-chit-chat 72-hour countdown warning bar */}
        <div className="px-4 py-2 bg-stone-950/80 border-b border-rose-950/30 flex items-center justify-between text-xs text-stone-300">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-rose-500" />
            <span>
              {t('chatDateCountdown')} <strong className="text-white font-mono">{new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(antiChitChat.hoursLeft)}</strong>
            </span>
          </div>
          <span className="text-[11px] text-rose-300 hidden sm:inline">
            {antiChitChat.recommendation}
          </span>
        </div>

        {/* Lady VIP direct contacts drawer if unlocked */}
        {showDirectContactUnlocked && isLadyPremium && (
          <div className="p-3 mx-4 my-2 rounded-2xl bg-amber-950/30 border border-amber-500/40 text-xs text-amber-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crown className="w-4 h-4 text-amber-400" />
              <span>
                <strong>{t('chatPartnerContact')}</strong> {t('chatContactNotAvailable')}
              </span>
            </div>
            <span className="text-[10px] bg-amber-500/20 px-2 py-0.5 rounded font-bold">
              {t('chatVipBenefit')}
            </span>
          </div>
        )}

        {/* Messages Feed */}
        <div ref={messagesLogRef} onScroll={event => {
          const log = event.currentTarget;
          shouldAutoScrollMessagesRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        }} role="log" aria-label={t('chatMessages')} aria-live="polite" aria-relevant="additions text" aria-atomic="false" className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Compatibility recap chip */}
          <div className="flex justify-center mb-2">
            <div className="px-3 py-1 rounded-full bg-stone-950/80 border border-rose-900/30 text-[11px] text-stone-400 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-rose-400" />
              <span>{t('chatFamilyCompatibility')} {activeThread.compatibilityScore}%</span>
            </div>
          </div>

          {activeThread.messages.map(msg => {
            const isMe = msg.senderId === 'current_user';
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
              >
                {/* Regular text or Date Invite Card */}
                {msg.isDateInvite ? (
                  <div className="max-w-sm rounded-2xl p-4 bg-gradient-to-br from-rose-950 via-stone-900 to-stone-950 border border-rose-600/50 text-white shadow-xl">
                    <div className="flex items-center gap-2 text-rose-400 text-xs font-bold uppercase tracking-wider mb-2">
                      <Coffee className="w-4 h-4" aria-hidden="true" />
                      <span>{t('chatFirstDateInvite')}</span>
                    </div>
                    <div className="space-y-1.5 text-xs text-stone-200 mb-3">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-3.5 h-3.5 text-rose-400" />
                        <span>{msg.dateInviteDetails?.place}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Calendar className="w-3.5 h-3.5 text-rose-400" />
                        <span>{msg.dateInviteDetails?.day}, {msg.dateInviteDetails?.time}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {msg.dateInviteDetails?.status === 'accepted' ? (
                        <div role="status" aria-live="polite" aria-atomic="true" className="w-full py-2 rounded-xl bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center justify-center gap-1.5">
                          <Check className="w-4 h-4" />
                          <span>{t('chatDateConfirmed')}</span>
                        </div>
                      ) : msg.dateInviteDetails?.status === 'pending' && !isMe ? (
                        <button type="button"
                          aria-label={t('chatAcceptInvite')}
                          onClick={() => onAcceptDateInvite(activeThread.id, msg.id)}
                          className="min-h-11 w-full py-2 rounded-xl border border-transparent bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-colors flex items-center justify-center gap-1.5 focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                        >
                          <Check className="w-4 h-4" />
                          <span>{t('chatAcceptInvite')}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div
                    dir="auto"
                    className={`max-w-[85%] sm:max-w-[75%] break-words [overflow-wrap:anywhere] px-4 py-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                      isMe
                        ? 'bg-rose-600 text-white rounded-br-none shadow-md shadow-rose-950/30'
                        : 'bg-stone-800 text-stone-200 rounded-bl-none border border-white/5'
                    }`}
                  >
                    {msg.text}
                  </div>
                )}
                <time dir="auto" className="text-[10px] text-stone-500 mt-1 px-1">{msg.timestamp}</time>
              </div>
            );
          })}
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSend} className="flex flex-wrap items-center gap-1.5 border-t border-white/5 bg-stone-950/70 p-2 sm:flex-nowrap sm:gap-2 sm:p-3">
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-transparent bg-stone-800 text-rose-400 transition-colors hover:bg-stone-700 focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            title={t('chatInviteDate')}
            aria-label={t('chatInviteDate')}
            aria-haspopup="dialog"
            aria-expanded={showInviteModal}
          >
            <Coffee className="w-4 h-4" />
          </button>

          <input
            name="chat-message"
            key={activeThread.id}
            type="text"
            dir="auto"
            maxLength={10000}
            value={inputText}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) {
                e.preventDefault();
              }
            }}
            onChange={e => {
              const threadId = activeThread.id;
              setDrafts(current => ({ ...current, [threadId]: e.target.value }));
              setSendErrors(current => ({ ...current, [threadId]: '' }));
            }}
            placeholder={t('chatMessagePlaceholder')}
            aria-label={t('chatMessageLabel')}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-stone-900 px-3 py-3 text-xs text-white placeholder-stone-500 focus:border-rose-500/60 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 sm:px-4 sm:text-sm"
          />

          {sendErrors[activeThread.id] && <p role="alert" className="order-last basis-full px-1 text-xs text-rose-300 sm:order-none sm:basis-auto sm:max-w-36">{sendErrors[activeThread.id]}</p>}
          <button
            type="submit"
            disabled={!inputText.trim() || sendingThreadIds.has(activeThread.id)}
            aria-busy={sendingThreadIds.has(activeThread.id)}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-white shadow-md transition-all hover:bg-rose-500 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            aria-label={t('chatSendMessage')}
          >
            {sendingThreadIds.has(activeThread.id)
              ? <LoaderCircle className="w-4 h-4 animate-spin" aria-hidden="true" />
              : <Send className="w-4 h-4" aria-hidden="true" />
            }
          </button>
        </form>
      </div>

      {/* Date Invite Modal */}
      {showInviteModal && (
        <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-stone-950/80 p-2 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setShowInviteModal(false); }}>
          <div ref={inviteDialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="date-invite-title" aria-describedby="date-invite-description" className="my-auto max-h-[calc(100dvh-1rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-3xl border border-rose-900/50 bg-stone-900 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-start shadow-2xl sm:p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Coffee className="w-5 h-5 text-rose-500" />
                <h4 id="date-invite-title" className="font-heading text-base font-bold text-white">{t('chatInviteDate')}</h4>
              </div>
              <button
                type="button"
                onClick={() => setShowInviteModal(false)}
                aria-label={t('chatCloseInvite')}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-full border border-transparent text-stone-400 hover:text-white focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                ✕
              </button>
            </div>

            <p id="date-invite-description" className="text-xs text-stone-300 mb-4">
              {t('chatInviteDescription')}
            </p>

            <div className="space-y-3 mb-5 text-xs">
              <div>
                <label htmlFor="date-invite-place" className="block text-stone-400 mb-1">{t('chatPlaceFormat')}</label>
                <select
                  id="date-invite-place"
                  name="date-invite-place"
                  value={selectedPlace}
                  onChange={e => setSelectedPlace(e.target.value)}
                  className="min-h-11 w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  <option value="cafe">☕ {t('chatPlaceCafe')}</option>
                  <option value="park">🌳 {t('chatPlacePark')}</option>
                  <option value="dinner">🍷 {t('chatPlaceDinner')}</option>
                  <option value="video">📹 {t('chatPlaceVideo')}</option>
                </select>
              </div>

              <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                <div>
                  <label htmlFor="date-invite-day" className="block text-stone-400 mb-1">{t('chatDay')}</label>
                  <select
                    id="date-invite-day"
                    name="date-invite-day"
                    value={selectedDay}
                    onChange={e => setSelectedDay(e.target.value)}
                    className="min-h-11 w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                  >
                    <option value="today">{t('chatDayToday')}</option>
                    <option value="tomorrow">{t('chatDayTomorrow')}</option>
                    <option value="saturday">{t('chatDaySaturday')}</option>
                    <option value="sunday">{t('chatDaySunday')}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="date-invite-time" className="block text-stone-400 mb-1">{t('chatTime')}</label>
                  <select
                    id="date-invite-time"
                    name="date-invite-time"
                    value={selectedTime}
                    onChange={e => setSelectedTime(e.target.value)}
                    className="min-h-11 w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                  >
                    <option value="18:30">18:30</option>
                    <option value="19:00">19:00</option>
                    <option value="19:30">19:30</option>
                    <option value="20:00">20:00</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button type="button"
                onClick={() => setShowInviteModal(false)}
                className="min-h-11 flex-1 py-2.5 rounded-xl border border-transparent bg-stone-800 text-stone-300 font-semibold text-xs focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                {t('cancel')}
              </button>
              <button type="button"
                onClick={handleCreateInvite}
                className="min-h-11 flex-1 py-2.5 rounded-xl border border-transparent bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs focus-visible:border-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
              >
                {t('chatSendInvite')}
              </button>
            </div>
          </div>
        </div>
      )}

      <PartnerServicesMarketplace
        isOpen={showPartnerServices}
        onClose={() => setShowPartnerServices(false)}
        coupleNames={`Вы и ${activeThread.partnerProfile.name}`}
        compatibilityScore={activeThread.compatibilityScore}
      />
    </div>
  );
};
