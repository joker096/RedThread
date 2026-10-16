import React, { useState } from 'react';
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
  const [inputText, setInputText] = useState('');
  const [showInviteModal, setShowInviteModal] = useState(false);
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
        <h3 className="font-heading text-lg font-bold text-white mb-1">У вас пока нет активных диалогов</h3>
        <p className="text-xs text-stone-400 max-w-xs">
          Перейдите в радар, выберите подходящую вторую половинку и отправьте симпатию!
        </p>
      </div>
    );
  }

  const antiChitChat = checkAntiChitChatDeadline(activeThread.createdAt, activeThread.messages.length);

  return (
    <div className="w-full max-w-4xl mx-auto h-[75vh] min-h-[550px] flex rounded-3xl overflow-hidden bg-stone-900 border border-rose-950/40 shadow-2xl">
      {/* Threads sidebar (desktop / tablet) */}
      <div className={`w-full md:w-80 border-r border-white/5 flex flex-col bg-stone-950/60 ${activeThreadId ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-3.5 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-heading text-sm font-bold text-white">Диалоги</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-600/30 text-rose-300 font-bold border border-rose-500/20">
              {threads.length} пары
            </span>
          </div>
          <span className="text-[10px] text-stone-400">Правило 72 ч</span>
        </div>

        {/* Anti-chit-chat notice banner */}
        <div className="p-2.5 mx-3 my-2 rounded-xl bg-rose-950/30 border border-rose-800/30 text-[11px] text-rose-200 flex items-start gap-2">
          <Clock className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>
            <strong>Цель — живое свидание!</strong> Переписка ограничена 72 часами, чтобы избежать пустых разговоров.
          </span>
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-y-auto space-y-1 p-2">
          {threads.map(thread => {
            const isSelected = thread.id === activeThread.id;
            return (
              <div
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                className={`flex items-center gap-3 p-3 rounded-2xl cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-rose-950/50 border border-rose-800/40 text-white'
                    : 'hover:bg-stone-900 text-stone-300'
                }`}
              >
                <div className="relative">
                  <img
                    src={thread.partnerProfile.avatar}
                    alt={thread.partnerProfile.name}
                    className="w-12 h-12 rounded-xl object-cover"
                  />
                  <div className="absolute -bottom-1 -right-1 px-1.5 py-0.2 rounded-full text-[9px] font-bold bg-rose-600 text-white">
                    {thread.compatibilityScore}%
                  </div>
                </div>

                <div className="flex-1 min-w-0 text-left">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-white truncate">
                      {thread.partnerProfile.name}
                    </span>
                    <span className="text-[10px] text-stone-400">{thread.lastMessageTime}</span>
                  </div>
                  <p className="text-xs text-stone-400 truncate mt-0.5">{thread.lastMessage}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Active chat window */}
      <div className={`flex-1 flex flex-col bg-stone-900/90 ${!activeThreadId ? 'hidden md:flex' : 'flex'}`}>
        {/* Chat Header */}
        <div className="p-3 sm:p-4 border-b border-white/5 flex items-center justify-between bg-stone-950/40">
          <div className="flex items-center gap-3">
            <button
              onClick={onBackToList}
              className="md:hidden p-1.5 rounded-lg bg-stone-800 text-stone-300 hover:text-white"
              aria-label="Назад к списку"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div className="relative shrink-0">
              <img
                src={activeThread.partnerProfile.photos[0] || activeThread.partnerProfile.avatar}
                alt={activeThread.partnerProfile.name}
                className="w-11 h-11 rounded-xl object-cover ring-1 ring-rose-500/40 shrink-0"
              />
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-stone-900"></span>
            </div>

            <div className="text-left">
              <div className="flex items-center gap-1.5">
                <span className="font-heading font-bold text-white text-sm sm:text-base">
                  {activeThread.partnerProfile.name}, {activeThread.partnerProfile.age}
                </span>
                <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-500/20 font-semibold flex items-center gap-0.5">
                  <ShieldCheck className="w-3 h-3" />
                  Живой
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
              title="Юристы и свадебные услуги после этапа совместимости"
            >
              <HeartHandshake className="w-4 h-4" />
              <span className="hidden lg:inline">Для пары</span>
              <span className="lg:hidden">Услуги</span>
            </button>
            <button
              onClick={() => setShowInviteModal(true)
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 to-red-600 text-white font-semibold text-xs shadow-md shadow-rose-950 hover:from-rose-500 hover:to-red-500 transition-all"
            >
              <Coffee className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Назначить свидание</span>
              <span className="sm:hidden">Встреча</span>
            </button>

            {/* Direct contact unlock button */}
            <button
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
              title={isLadyPremium ? 'Прямой контакт открыт' : 'Обмен контактами (Lady VIP)'}
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
              Таймер до свидания: <strong className="text-white font-mono">{antiChitChat.hoursLeft} ч</strong>
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
                <strong>Контакты партнера:</strong> Telegram: @{activeThread.partnerProfile.id.replace('user_', '')}_direct • Тел: +7 (926) 841-**-**
              </span>
            </div>
            <span className="text-[10px] bg-amber-500/20 px-2 py-0.5 rounded font-bold">
              Lady VIP Преимущество
            </span>
          </div>
        )}

        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Compatibility recap chip */}
          <div className="flex justify-center mb-2">
            <div className="px-3 py-1 rounded-full bg-stone-950/80 border border-rose-900/30 text-[11px] text-stone-400 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-rose-400" />
              <span>Совместимость целей на семью: {activeThread.compatibilityScore}%</span>
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
                      <span>Приглашение на первое свидание</span>
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
                          <span>Свидание подтверждено! До встречи!</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => onAcceptDateInvite(activeThread.id, msg.id)}
                          className="w-full py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Check className="w-4 h-4" />
                          <span>Принять приглашение</span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed ${
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
        <form onSubmit={handleSend} className="p-3 border-t border-white/5 bg-stone-950/70 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="p-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-rose-400 transition-colors"
            title="Пригласить на встречу"
          >
            <Coffee className="w-4 h-4" />
          </button>

          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="Напишите сообщение без пустых формальностей..."
            className="flex-1 bg-stone-900 border border-white/10 rounded-xl px-4 py-2.5 text-xs sm:text-sm text-white placeholder-stone-500 focus:outline-none focus:border-rose-500/60"
          />

          <button
            type="submit"
            disabled={!inputText.trim()}
            className="p-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white transition-all shadow-md"
            aria-label="Отправить сообщение"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Date Invite Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/80 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-stone-900 border border-rose-900/50 p-5 shadow-2xl text-left">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Coffee className="w-5 h-5 text-rose-500" />
                <h4 className="font-heading text-base font-bold text-white">Пригласить на свидание</h4>
              </div>
              <button
                onClick={() => setShowInviteModal(false)}
                className="text-stone-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-stone-300 mb-4">
              Выберите формат живой встречи, чтобы не тратить недели на виртуальную переписку:
            </p>

            <div className="space-y-3 mb-5 text-xs">
              <div>
                <label className="block text-stone-400 mb-1">Место / Формат:</label>
                <select
                  value={selectedPlace}
                  onChange={e => setSelectedPlace(e.target.value)}
                  className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs"
                >
                  <option value="Уютная кофейня в центре">☕ Уютная кофейня (30-40 минут)</option>
                  <option value="Прогулка в городском парке">🌳 Прогулка в парке на свежем воздухе</option>
                  <option value="Ужин в видовом ресторане">🍷 Спокойный ужин в ресторане</option>
                  <option value="Короткий 10-мин видео-чай">📹 Быстрый видео-чай перед встречей</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-stone-400 mb-1">День:</label>
                  <select
                    value={selectedDay}
                    onChange={e => setSelectedDay(e.target.value)}
                    className="w-full bg-stone-950 border border-white/10 rounded-xl p-2.5 text-white text-xs"
                  >
                    <option value="Сегодня">Сегодня</option>
                    <option value="Завтра">Завтра</option>
                    <option value="В субботу">В субботу</option>
                    <option value="В воскресенье">В воскресенье</option>
                  </select>
                </div>
                <div>
                  <label className="block text-stone-400 mb-1">Время:</label>
                  <select
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
              <button
                onClick={() => setShowInviteModal(false)}
                className="flex-1 py-2.5 rounded-xl bg-stone-800 text-stone-300 font-semibold text-xs"
              >
                Отмена
              </button>
              <button
                onClick={handleCreateInvite}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs"
              >
                Отправить в чат
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
