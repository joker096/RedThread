import React, { useEffect, useRef, useState } from 'react';
import { 
  Send, 
  Clock, 
  Calendar, 
  Coffee, 
  Phone, 
  ShieldCheck, 
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
  onSendMessage: (threadId: string, text: string) => void;
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
  const { t } = useLocale();
  const [inputText, setInputText] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const inviteDialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showInviteModal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = inviteDialogRef.current;
    const getFocusable = () => dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? [];
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
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
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
  const [selectedPlace, setSelectedPlace] = useState('Уютная кофейня в центре');
  const [selectedDay, setSelectedDay] = useState('Завтра');
  const [selectedTime, setSelectedTime] = useState('19:00');
  const [showDirectContactUnlocked, setShowDirectContactUnlocked] = useState(false);
  const [showPartnerServices, setShowPartnerServices] = useState(false);

  const activeThread = threads.find(t => t.id === activeThreadId) || threads[0];

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !activeThread) return;
    onSendMessage(activeThread.id, inputText.trim());
    setInputText('');
  };

  const handleCreateInvite = () => {
    if (!activeThread) return;
    onSendDateInvite(activeThread.id, selectedPlace, selectedDay, selectedTime);
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
                className={`w-full text-start flex items-center gap-3 p-3 rounded-2xl cursor-pointer transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-400 ${
                  isSelected
                    ? 'bg-rose-950/50 border border-rose-800/40 text-white'
                    : 'hover:bg-stone-900 text-stone-300'
                }`}
              >
                <span className="relative block">
                  <img
                    src={thread.partnerProfile.avatar}
                    alt={thread.partnerProfile.name}
                    className="w-12 h-12 rounded-xl object-cover"
                  />
                  <span className="absolute -bottom-1 -end-1 px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-rose-600 text-white">
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
                  <span className="block text-xs text-stone-400 truncate mt-0.5">{thread.lastMessage}</span>
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
              className="md:hidden p-1.5 rounded-lg bg-stone-800 text-stone-300 hover:text-white"
              aria-label={t('chatBackToList')}
            >
              <ArrowLeft className="vow-rtl-back-icon w-4 h-4" />
            </button>

            <div className="relative shrink-0">
              <img
                src={activeThread.partnerProfile.photos[0] || activeThread.partnerProfile.avatar}
                alt={activeThread.partnerProfile.name}
                className="w-11 h-11 rounded-xl object-cover ring-1 ring-rose-500/40 shrink-0"
              />
              <span className="absolute bottom-0 end-0 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-stone-900"></span>
            </div>

            <div className="text-start">
              <div className="flex items-center gap-1.5">
                <span className="break-words font-heading text-sm font-bold text-white sm:text-base">
                  {activeThread.partnerProfile.name}, {activeThread.partnerProfile.age}
                </span>
                <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-500/20 font-semibold flex items-center gap-0.5">
                  <ShieldCheck className="w-3 h-3" />
                  {t('chatOnline')}
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
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-emerald-600/30 bg-emerald-950/30 text-emerald-200 font-semibold text-xs hover:bg-emerald-900/40 transition-colors"
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 text-white font-semibold text-xs shadow-md shadow-rose-950 hover:from-rose-500 hover:to-red-500 transition-all"
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
              className={`p-2 rounded-xl border text-xs transition-colors ${
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
              {t('chatDateCountdown')} <strong className="text-white font-mono">{antiChitChat.hoursLeft} ч</strong>
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
                <strong>{t('chatPartnerContact')}</strong> Telegram: @{activeThread.partnerProfile.id.replace('user_', '')}_direct • Тел: +7 (926) 841-**-**
              </span>
            </div>
            <span className="text-[10px] bg-amber-500/20 px-2 py-0.5 rounded font-bold">
              {t('chatVipBenefit')}
            </span>
          </div>
        )}

        {/* Messages Feed */}
        <div role="log" aria-label={t('chatMessages')} aria-live="polite" aria-relevant="additions text" aria-atomic="false" className="flex-1 overflow-y-auto p-4 space-y-3">
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
                      <Coffee className="w-4 h-4" />
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
                        <div className="w-full py-2 rounded-xl bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center justify-center gap-1.5">
                          <Check className="w-4 h-4" />
                          <span>{t('chatDateConfirmed')}</span>
                        </div>
                      ) : (
                        <button type="button"
                          onClick={() => onAcceptDateInvite(activeThread.id, msg.id)}
                          className="w-full py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Check className="w-4 h-4" />
                          <span>{t('chatAcceptInvite')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    className={`max-w-[85%] sm:max-w-[75%] break-words [overflow-wrap:anywhere] px-4 py-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                      isMe
                        ? 'bg-rose-600 text-white rounded-br-none shadow-md shadow-rose-950/30'
                        : 'bg-stone-800 text-stone-200 rounded-bl-none border border-white/5'
                    }`}
                  >
                    {msg.text}
                  </div>
                )}
                <span className="text-[10px] text-stone-500 mt-1 px-1">{msg.timestamp}</span>
              </div>
            );
          })}
        </div>

        {/* Input Bar */}
        <form onSubmit={handleSend} className="flex items-center gap-1.5 border-t border-white/5 bg-stone-950/70 p-2 sm:gap-2 sm:p-3">
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl bg-stone-800 text-rose-400 transition-colors hover:bg-stone-700"
            title={t('chatInviteDate')}
            aria-label={t('chatInviteDate')}
            aria-haspopup="dialog"
            aria-expanded={showInviteModal}
          >
            <Coffee className="w-4 h-4" />
          </button>

          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder={t('chatMessagePlaceholder')}
            aria-label={t('chatMessageLabel')}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-stone-900 px-3 py-3 text-xs text-white placeholder-stone-500 focus:border-rose-500/60 focus:outline-none sm:px-4 sm:text-sm"
          />

          <button
            type="submit"
            disabled={!inputText.trim()}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl bg-rose-600 text-white shadow-md transition-all hover:bg-rose-500 disabled:opacity-40"
            aria-label={t('chatSendMessage')}
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Date Invite Modal */}
      {showInviteModal && (
        <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-stone-950/80 p-2 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setShowInviteModal(false); }}>
          <div ref={inviteDialogRef} role="dialog" aria-modal="true" aria-labelledby="date-invite-title" className="my-auto max-h-[calc(100dvh-1rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-3xl border border-rose-900/50 bg-stone-900 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-start shadow-2xl sm:p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Coffee className="w-5 h-5 text-rose-500" />
                <h4 id="date-invite-title" className="font-heading text-base font-bold text-white">{t('chatInviteDate')}</h4>
              </div>
              <button
                type="button"
                onClick={() => setShowInviteModal(false)}
                aria-label={t('chatCloseInvite')}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-stone-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-stone-300 mb-4">
              {t('chatInviteDescription')}
            </p>

            <div className="space-y-3 mb-5 text-xs">
              <div>
                <label htmlFor="date-invite-place" className="block text-stone-400 mb-1">{t('chatPlaceFormat')}</label>
                <select
                  id="date-invite-place"
                  value={selectedPlace}
                  onChange={e => setSelectedPlace(e.target.value)}
                  className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs"
                >
                  <option value="Уютная кофейня в центре">☕ {t('chatPlaceCafe')}</option>
                  <option value="Прогулка в городском парке">🌳 {t('chatPlacePark')}</option>
                  <option value="Ужин в видовом ресторане">🍷 {t('chatPlaceDinner')}</option>
                  <option value="Короткий 10-мин видео-чай">📹 {t('chatPlaceVideo')}</option>
                </select>
              </div>

              <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                <div>
                  <label htmlFor="date-invite-day" className="block text-stone-400 mb-1">{t('chatDay')}</label>
                  <select
                    id="date-invite-day"
                    value={selectedDay}
                    onChange={e => setSelectedDay(e.target.value)}
                    className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs"
                  >
                    <option value="Сегодня">{t('chatDayToday')}</option>
                    <option value="Завтра">{t('chatDayTomorrow')}</option>
                    <option value="В субботу">{t('chatDaySaturday')}</option>
                    <option value="В воскресенье">{t('chatDaySunday')}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="date-invite-time" className="block text-stone-400 mb-1">{t('chatTime')}</label>
                  <select
                    id="date-invite-time"
                    value={selectedTime}
                    onChange={e => setSelectedTime(e.target.value)}
                    className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs"
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
                className="flex-1 py-2.5 rounded-xl bg-stone-800 text-stone-300 font-semibold text-xs"
              >
                {t('cancel')}
              </button>
              <button type="button"
                onClick={handleCreateInvite}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs"
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
