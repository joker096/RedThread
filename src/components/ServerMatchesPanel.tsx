import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';

type ServerMatch = {
  id: string;
  partnerId: string;
  displayName: string;
  age: number;
  country: string;
  city: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
};
type ServerMessage = { id: string; senderId: string; text: string; createdAt: string };
type Props = { onOpenAccount: () => void };

export const ServerMatchesPanel: React.FC<Props> = ({ onOpenAccount }) => {
  const { t, formatDate } = useLocale();
  const [matches, setMatches] = useState<ServerMatch[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = selected ? (drafts[selected] || '') : '';
  const [busy, setBusy] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const messageRequestId = useRef(0);
  const matchesRequestId = useRef(0);

  const loadMatches = useCallback(async () => {
    const requestId = ++matchesRequestId.current;
    try {
      const response = await fetch('/api/matches', { credentials: 'include' });
      if (requestId !== matchesRequestId.current) return;
      if (response.status === 401) {
        // Prevent older match-list requests from restoring an authenticated state.
        matchesRequestId.current += 1;
        messageRequestId.current += 1;
        setAuthenticated(false);
        setMatches([]);
        setSelected('');
        setMessages([]);
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMatchesError'));
      const data = await response.json();
      if (requestId !== matchesRequestId.current) return;
      setMatches(data.matches || []);
      setAuthenticated(true);
      setNotice(data.matches?.length ? '' : t('noMutualMatches'));
      if (selected && !(data.matches || []).some((match: ServerMatch) => match.id === selected)) {
        // Invalidate any in-flight message request for a match that is no longer available.
        messageRequestId.current += 1;
        setSelected('');
        setMessages([]);
      }
    } catch (error) {
      if (requestId === matchesRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('loadMatchesError'));
      }
    }
  }, [selected]);

  const loadMessages = useCallback(async (matchId: string) => {
    if (!matchId) return;
    const requestId = ++messageRequestId.current;
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages`, { credentials: 'include' });
      if (requestId !== messageRequestId.current) return;
      if (response.status === 401) {
        // Invalidate in-flight reads/sends before clearing a session-expired chat.
        messageRequestId.current += 1;
        matchesRequestId.current += 1;
        setAuthenticated(false);
        setMatches([]);
        setSelected('');
        setMessages([]);
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (response.status === 404) {
        // The match may have been blocked or closed while this chat was open.
        messageRequestId.current += 1;
        matchesRequestId.current += 1;
        setMatches(current => current.filter(match => match.id !== matchId));
        setSelected('');
        setMessages([]);
        setNotice(t('loadMessagesError'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMessagesError'));
      const data = await response.json();
      if (requestId !== messageRequestId.current) return;
      setMessages(data.messages || []);
    } catch (error) {
      if (requestId === messageRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('loadMessagesError'));
      }
    }
  }, [t]);

  useEffect(() => { void loadMatches(); }, [loadMatches]);
  // Refresh the inbox when the user returns to the app so new mutual matches appear
  // without requiring a manual refresh or a full page reload.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadMatches();
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadMatches]);
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/me', { credentials: 'include' })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!cancelled) setCurrentUserId(data?.user?.id ?? null); })
      .catch(() => { if (!cancelled) setCurrentUserId(null); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (selected) void loadMessages(selected); }, [selected, loadMessages]);

  const send = async () => {
    const text = draft.trim();
    const matchId = selected;
    const requestId = messageRequestId.current;
    if (!text || !matchId || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await response.json().catch(() => null);
      if (requestId !== messageRequestId.current) return;
      if (response.status === 401) {
        // The session expired while sending; discard the conversation and stale requests.
        messageRequestId.current += 1;
        matchesRequestId.current += 1;
        setAuthenticated(false);
        setMatches([]);
        setSelected('');
        setMessages([]);
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (response.status === 404) {
        // A block or closed match invalidates this conversation even if it was already open.
        messageRequestId.current += 1;
        matchesRequestId.current += 1;
        setMatches(current => current.filter(match => match.id !== matchId));
        setSelected('');
        setMessages([]);
        setNotice(t('sendMessageError'));
        return;
      }
      if (!response.ok) throw new Error(data?.error === 'too_many_messages' ? t('messageRateLimit') : t('sendMessageError'));
      setMessages(current => [...current, data.message]);
      setDrafts(current => ({ ...current, [matchId]: '' }));
      void loadMatches();
    } catch (error) {
      if (requestId === messageRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('sendMessageError'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="server-matches-panel" className="mb-5 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-stone-900 via-stone-900 to-sky-950/40 p-4 shadow-xl shadow-black/10 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-sky-300">{t('serverChats')}</p>
        <h3 className="mt-1 text-xl font-bold tracking-tight text-white">{t('mutualMatches')}</h3>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-stone-400">{t('realMatchesOnly')}</p>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/50 p-4 shadow-inner">
          <p className="text-sm text-stone-200">{t('loginToSeeMatches')}</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">{t('login')}</button>
        </div>
      ) : (
        <div className="space-y-3">
          {matches.map(match => (
            <button data-testid="server-match-item" type="button" key={match.id} onClick={() => { messageRequestId.current += 1; setMessages([]); setNotice(''); setSelected(match.id); }} className={`vow-motion-button w-full rounded-2xl border p-3.5 text-left transition-colors ${selected === match.id ? 'border-sky-400/60 bg-sky-950/40 shadow-md shadow-sky-950/30' : 'border-white/10 bg-stone-950/45 hover:border-white/20 hover:bg-stone-950/70'}`}>
              <span className="block text-sm font-semibold text-white">{match.displayName}, {match.age}</span>
              <span className="mt-1 block text-xs text-stone-400">{match.city}, {match.country}</span>
              <span className="mt-1 block truncate text-xs text-stone-500">{match.lastMessage || t('matchCreatedMessage')}</span>
            </button>
          ))}
          {notice && <p role="status" className="text-xs text-stone-300">{notice}</p>}
          {selected && (
            <div data-testid="real-match-chat" className="rounded-2xl border border-white/10 bg-stone-950/55 p-3.5 shadow-inner sm:p-4">
              <div data-testid="server-match-messages" role="log" aria-live="polite" aria-label={t('serverChats')} className="mb-4 max-h-72 space-y-2.5 overflow-y-auto overscroll-contain rounded-xl bg-black/10 p-1">
                {messages.map(message => (
                  <div key={message.id} className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed shadow-sm ${message.senderId === currentUserId ? 'ml-auto rounded-br-md bg-gradient-to-br from-rose-600 to-rose-700 text-white' : 'mr-auto rounded-bl-md border border-white/5 bg-stone-800 text-stone-100'}`}>
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    <time className={`mt-1 block text-[9px] ${message.senderId === currentUserId ? 'text-rose-100/70' : 'text-stone-500'}`}>{formatDate(message.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                  </div>
                ))}
                {!messages.length && <p className="text-xs text-stone-500">{t('noMessagesYet')}</p>}
              </div>
              <textarea aria-label={t('writeMessage')} value={draft} onChange={e => setDrafts(current => ({ ...current, [selected]: e.target.value }))} maxLength={4000} rows={2} placeholder={t('writeMessage')} className="w-full resize-y rounded-xl border border-white/10 bg-stone-900/90 p-3.5 text-sm text-white outline-none transition placeholder:text-stone-500 focus:border-rose-400/60 focus:ring-2 focus:ring-rose-400/15" />
              <button data-testid="server-match-send" type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="vow-motion-button mt-2 min-h-12 w-full rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-rose-950/25 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">{busy ? t('sendingMessage') : t('sendMessage')}</button>
              <button type="button" onClick={() => void loadMessages(selected)} className="vow-motion-button mt-2 min-h-11 w-full rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-stone-300 transition hover:border-white/20 hover:bg-white/5">{t('refreshMessages')}</button>
            </div>
          )}
          <button type="button" onClick={() => void loadMatches()} className="vow-motion-button min-h-11 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-300 transition hover:border-white/20 hover:bg-white/5">{t('refreshMatches')}</button>
        </div>
      )}
    </section>
  );
};
