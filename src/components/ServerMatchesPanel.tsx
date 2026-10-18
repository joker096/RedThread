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

const normalizeServerMatch = (value: unknown): ServerMatch | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const match = value as Partial<ServerMatch>;
  if (typeof match.id !== 'string' || !match.id.trim() || match.id.trim().length > 256 ||
      typeof match.partnerId !== 'string' || !match.partnerId.trim() || match.partnerId.trim().length > 256 ||
      typeof match.displayName !== 'string' || !match.displayName.trim() || match.displayName.trim().length > 100 ||
      typeof match.age !== 'number' || !Number.isFinite(match.age) || match.age < 18 || match.age > 120) {
    return null;
  }
  return {
    id: match.id.trim(),
    partnerId: match.partnerId.trim(),
    displayName: match.displayName.trim(),
    age: Math.floor(match.age),
    country: typeof match.country === 'string' ? match.country.trim().slice(0, 100) : '',
    city: typeof match.city === 'string' ? match.city.trim().slice(0, 100) : '',
    lastMessage: typeof match.lastMessage === 'string' && match.lastMessage.length <= 10000 && match.lastMessage.trim()
      ? match.lastMessage.trim().slice(0, 1000)
      : null,
    lastMessageAt: typeof match.lastMessageAt === 'string' && match.lastMessageAt.trim().length > 0 &&
      match.lastMessageAt.length <= 100 && Number.isFinite(Date.parse(match.lastMessageAt.trim()))
      ? match.lastMessageAt.trim()
      : null
  };
};

const normalizeServerMessage = (value: unknown): ServerMessage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Partial<ServerMessage>;
  if (typeof message.id !== 'string' || !message.id.trim() || message.id.trim().length > 256 ||
      typeof message.senderId !== 'string' || !message.senderId.trim() || message.senderId.trim().length > 256 ||
      typeof message.text !== 'string' || !message.text.trim() || message.text.length > 10000 ||
      typeof message.createdAt !== 'string' || message.createdAt.length > 100 ||
      !Number.isFinite(Date.parse(message.createdAt.trim()))) {
    return null;
  }
  return {
    id: message.id.trim(),
    senderId: message.senderId.trim(),
    text: message.text.trim(),
    createdAt: message.createdAt.trim()
  };
};

const normalizeUserId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= 256 ? id : null;
};

const deduplicateById = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique.reverse();
};

export const ServerMatchesPanel: React.FC<Props> = ({ onOpenAccount }) => {
  const { t, formatDate } = useLocale();
  const [matches, setMatches] = useState<ServerMatch[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = selected ? (drafts[selected] || '') : '';
  const [busy, setBusy] = useState(false);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [matchesFailed, setMatchesFailed] = useState(false);
  const [messagesFailed, setMessagesFailed] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const messageRequestId = useRef(0);
  const matchesRequestId = useRef(0);
  const currentUserRequestId = useRef(0);
  const sessionEpoch = useRef(0);
  const sendInFlight = useRef(false);
  const messagesLogRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollMessagesRef = useRef(true);

  const loadMatches = useCallback(async () => {
    const requestId = ++matchesRequestId.current;
    setMatchesLoading(true);
    setMatchesFailed(false);
    try {
      const response = await fetch('/api/matches', { credentials: 'include' });
      if (requestId !== matchesRequestId.current) return;
      if (response.status === 401) {
        // Prevent older match-list requests from restoring an authenticated state.
        matchesRequestId.current += 1;
        messageRequestId.current += 1;
        currentUserRequestId.current += 1;
        sessionEpoch.current += 1;
        sendInFlight.current = false;
        setBusy(false);
        setMatchesLoading(false);
        setMessagesLoading(false);
        setAuthenticated(false);
        setMatches([]);
        setSelected('');
        setMessages([]);
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMatchesError'));
      const data = await response.json().catch(() => null);
      if (requestId !== matchesRequestId.current) return;
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.matches)) {
        throw new Error(t('loadMatchesError'));
      }
      const rawMatches: unknown[] = data.matches;
      const nextMatches = deduplicateById(
        rawMatches.slice(-500).map(normalizeServerMatch).filter((match): match is ServerMatch => match !== null)
      );
      setMatches(nextMatches);
      setAuthenticated(true);
      setMatchesFailed(false);
      setNotice(nextMatches.length ? '' : t('noMutualMatches'));
      if (selected && !nextMatches.some(match => match.id === selected)) {
        // Invalidate any in-flight message request for a match that is no longer available.
        messageRequestId.current += 1;
        setMessagesLoading(false);
        setSelected('');
        setMessages([]);
      }
    } catch (error) {
      if (requestId === matchesRequestId.current) {
        setMatchesFailed(true);
        setNotice(error instanceof Error ? error.message : t('loadMatchesError'));
      }
    } finally {
      if (requestId === matchesRequestId.current) setMatchesLoading(false);
    }
  }, [selected, t]);

  const loadMessages = useCallback(async (matchId: string) => {
    if (!matchId) return;
    const requestId = ++messageRequestId.current;
    setMessagesLoading(true);
    setMessagesFailed(false);
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages`, { credentials: 'include' });
      if (requestId !== messageRequestId.current) return;
      if (response.status === 401) {
        // Invalidate in-flight reads/sends before clearing a session-expired chat.
        messageRequestId.current += 1;
        matchesRequestId.current += 1;
        currentUserRequestId.current += 1;
        sessionEpoch.current += 1;
        sendInFlight.current = false;
        setBusy(false);
        setMessagesLoading(false);
        setMatchesLoading(false);
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
        setMessagesLoading(false);
        setMatchesLoading(false);
        setMatches(current => current.filter(match => match.id !== matchId));
        setSelected('');
        setMessages([]);
        setNotice(t('loadMessagesError'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMessagesError'));
      const data = await response.json().catch(() => null);
      if (requestId !== messageRequestId.current) return;
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.messages)) {
        throw new Error(t('loadMessagesError'));
      }
      const rawMessages: unknown[] = data.messages;
      const nextMessages = deduplicateById(
        rawMessages.slice(-1000).map(normalizeServerMessage).filter((message): message is ServerMessage => message !== null)
      ).slice(-500);
      setMessages(nextMessages);
      setMessagesFailed(false);
    } catch (error) {
      if (requestId === messageRequestId.current) {
        setMessagesFailed(true);
        setNotice(error instanceof Error ? error.message : t('loadMessagesError'));
      }
    } finally {
      if (requestId === messageRequestId.current) setMessagesLoading(false);
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
    const requestId = ++currentUserRequestId.current;
    void fetch('/api/auth/me', { credentials: 'include' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!cancelled && requestId === currentUserRequestId.current) {
          setCurrentUserId(normalizeUserId(data?.user?.id));
        }
      })
      .catch(() => {
        if (!cancelled && requestId === currentUserRequestId.current) setCurrentUserId(null);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const refreshOnSessionChange = () => {
      // Invalidate actions from the previous account, including their finally handlers.
      sessionEpoch.current += 1;
      sendInFlight.current = false;
      messageRequestId.current += 1;
      matchesRequestId.current += 1;
      currentUserRequestId.current += 1;
      setMatches([]);
      setSelected('');
      setMessages([]);
      setDrafts({});
      setNotice('');
      setAuthenticated(null);
      setCurrentUserId(null);
      setMatchesLoading(true);
      setMessagesLoading(false);
      setMatchesFailed(false);
      setMessagesFailed(false);
      setBusy(false);

      const userRequestId = currentUserRequestId.current;
      void fetch('/api/auth/me', { credentials: 'include' })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          if (userRequestId === currentUserRequestId.current) {
            setCurrentUserId(normalizeUserId(data?.user?.id));
          }
        })
        .catch(() => {
          if (userRequestId === currentUserRequestId.current) setCurrentUserId(null);
        });
      void loadMatches();
    };
    window.addEventListener('vow:session-changed', refreshOnSessionChange);
    return () => window.removeEventListener('vow:session-changed', refreshOnSessionChange);
  }, [loadMatches]);

  useEffect(() => { if (selected) void loadMessages(selected); }, [selected, loadMessages]);

  // Start each conversation at the latest message. Within a conversation,
  // preserve the reader's position when they have scrolled up through history.
  useEffect(() => {
    shouldAutoScrollMessagesRef.current = true;
  }, [selected]);

  // Keep the newest message visible without moving the whole page.
  // Respect the user's reduced-motion preference when scrolling.
  useEffect(() => {
    if (!selected || messagesLoading || !shouldAutoScrollMessagesRef.current) return;
    const log = messagesLogRef.current;
    if (!log) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [selected, messages, messagesLoading]);

  const send = async () => {
    const text = draft.trim();
    const matchId = selected;
    const requestId = messageRequestId.current;
    const actionEpoch = sessionEpoch.current;
    // Lock synchronously so Enter + click (or two rapid key events) cannot
    // start duplicate POST requests before React re-renders with busy=true.
    if (!text || !matchId || busy || sendInFlight.current) return;
    sendInFlight.current = true;
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
        currentUserRequestId.current += 1;
        sessionEpoch.current += 1;
        sendInFlight.current = false;
        setBusy(false);
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
        setMessagesLoading(false);
        setMatchesLoading(false);
        setMatches(current => current.filter(match => match.id !== matchId));
        setSelected('');
        setMessages([]);
        setNotice(t('sendMessageError'));
        return;
      }
      if (!response.ok) throw new Error(data?.error === 'too_many_messages' ? t('messageRateLimit') : t('sendMessageError'));
      const sentMessage = normalizeServerMessage(data?.message);
      if (!sentMessage) throw new Error(t('sendMessageError'));
      setMessages(current => deduplicateById([...current, sentMessage]).slice(-500));
      setDrafts(current => ({ ...current, [matchId]: '' }));
      void loadMatches();
    } catch (error) {
      if (requestId === messageRequestId.current) {
        setNotice(error instanceof Error ? error.message : t('sendMessageError'));
      }
    } finally {
      // An older request must not unlock a send started in a newer session.
      if (actionEpoch === sessionEpoch.current) {
        sendInFlight.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <section data-testid="server-matches-panel" aria-busy={matchesLoading || messagesLoading || busy} className="vow-screen mb-5 overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-stone-900 via-stone-900 to-sky-950/40 p-4 shadow-xl shadow-black/10 sm:p-5">
      <div className="mb-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-sky-300">{t('serverChats')}</p>
        <h3 className="mt-1 text-xl font-bold tracking-tight text-white">{t('mutualMatches')}</h3>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-stone-400">{t('realMatchesOnly')}</p>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/50 p-4 shadow-inner">
          <p className="text-sm text-stone-200">{t('loginToSeeMatches')}</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 min-h-11 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">{t('login')}</button>
        </div>
      ) : (
        <div className="space-y-3">
          {matchesLoading && <p role="status" aria-live="polite" className="rounded-xl border border-white/10 bg-stone-950/40 px-3 py-3 text-center text-xs text-stone-300">{t('loading')}</p>}
          {!matchesLoading && matchesFailed && <div className="rounded-xl border border-rose-500/20 bg-rose-950/20 p-3" role="alert"><p className="text-xs text-stone-200">{notice || t('loadMatchesError')}</p><button type="button" onClick={() => void loadMatches()} className="mt-2 min-h-11 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">{t('retry')}</button></div>}
          {!matchesLoading && !matchesFailed && matches.length === 0 && <div className="rounded-xl border border-white/10 bg-stone-950/40 p-4 text-center"><p className="text-sm text-stone-200">{t('noMutualMatches')}</p></div>}
          {matches.map(match => (
            <button data-testid="server-match-item" type="button" key={match.id} aria-pressed={selected === match.id} disabled={busy} onClick={() => { messageRequestId.current += 1; setMessages([]); setNotice(''); setSelected(match.id); }} className={`vow-motion-button w-full rounded-2xl border p-3.5 text-start transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:opacity-60 ${selected === match.id ? 'border-sky-400/60 bg-sky-950/40 shadow-md shadow-sky-950/30' : 'border-white/10 bg-stone-950/45 hover:border-white/20 hover:bg-stone-950/70'}`}>
              <span className="block text-sm font-semibold text-white">{match.displayName}, {match.age}</span>
              {(match.city || match.country) && (
                <span className="mt-1 block text-xs text-stone-400">
                  {[match.city, match.country].filter(Boolean).join(', ')}
                </span>
              )}
              <span className="mt-1 block truncate text-xs text-stone-500">{match.lastMessage || t('matchCreatedMessage')}</span>
            </button>
          ))}
          {notice && !matchesFailed && (matches.length > 0 || selected) && <p role="status" aria-live="polite" aria-atomic="true" className="text-xs text-stone-300">{notice}</p>}
          {selected && (
            <div data-testid="real-match-chat" className="rounded-2xl border border-white/10 bg-stone-950/55 p-3.5 shadow-inner sm:p-4">
              <div className="mb-4">
                {messagesLoading && <p role="status" className="px-2 py-3 text-xs text-stone-400">{t('loading')}</p>}
                {messagesFailed && <div role="alert" className="mb-2 rounded-xl border border-rose-500/20 bg-rose-950/20 p-3"><p className="text-xs text-stone-200">{notice || t('loadMessagesError')}</p><button type="button" onClick={() => void loadMessages(selected)} className="mt-2 min-h-10 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">{t('retry')}</button></div>}
                <div ref={messagesLogRef} onScroll={event => {
                  const log = event.currentTarget;
                  shouldAutoScrollMessagesRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
                }} data-testid="server-match-messages" role="log" aria-live="polite" aria-relevant="additions text" aria-atomic="false" aria-label={`${t('serverChats')}: ${matches.find(match => match.id === selected)?.displayName ?? ''}`} aria-busy={messagesLoading} className="max-h-60 space-y-2.5 overflow-y-auto overscroll-contain rounded-xl bg-black/10 p-1 sm:max-h-80">
                  {messages.map(message => (
                    <div key={message.id} className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed shadow-sm ${message.senderId === currentUserId ? 'ms-auto rounded-br-md bg-gradient-to-br from-rose-600 to-rose-700 text-white' : 'me-auto rounded-bl-md border border-white/5 bg-stone-800 text-stone-100'}`}>
                      <p dir="auto" className="whitespace-pre-wrap break-words">{message.text}</p>
                      <time dateTime={message.createdAt} className={`mt-1 block text-[10px] leading-4 ${message.senderId === currentUserId ? 'text-rose-100/85' : 'text-stone-400'}`}>{formatDate(message.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                    </div>
                  ))}
                </div>
                {!messagesLoading && !messagesFailed && !messages.length && <p role="status" className="px-2 py-3 text-xs text-stone-500">{t('noMessagesYet')}</p>}
              </div>
              <textarea dir="auto" aria-label={t('writeMessage')} value={draft} onChange={e => setDrafts(current => ({ ...current, [selected]: e.target.value.slice(0, 4000) }))} onKeyDown={e => { if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || busy || !draft.trim()) return; e.preventDefault(); void send(); }} disabled={busy} maxLength={4000} rows={2} placeholder={t('writeMessage')} className="w-full resize-y rounded-xl border border-white/10 bg-stone-900/90 p-3.5 text-sm text-white outline-none transition placeholder:text-stone-500 focus:border-rose-400/60 focus:ring-2 focus:ring-rose-400/15 disabled:cursor-not-allowed disabled:opacity-60" />
              <button data-testid="server-match-send" type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="vow-motion-button mt-2 min-h-12 w-full rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-rose-950/25 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:opacity-40">{busy ? t('sendingMessage') : t('sendMessage')}</button>
              <button type="button" onClick={() => void loadMessages(selected)} disabled={busy || messagesLoading} className="vow-motion-button mt-2 min-h-11 w-full rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-stone-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:opacity-50">{t('refreshMessages')}</button>
            </div>
          )}
          <button type="button" onClick={() => void loadMatches()} disabled={matchesLoading || busy} aria-busy={matchesLoading} className="vow-motion-button min-h-11 w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:cursor-not-allowed disabled:opacity-50">{t('refreshMatches')}</button>
        </div>
      )}
    </section>
  );
};
