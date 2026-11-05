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
type ServerMessage = { id: string; senderId: string; text: string; createdAt: string; cursorCreatedAt?: string };
type Props = { onOpenAccount: () => void };
const MESSAGE_PAGE_SIZE = 100;

export const normalizeServerMatch = (value: unknown): ServerMatch | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const match = value as Partial<ServerMatch>;
  if (typeof match.id !== 'string' || !match.id.trim() || match.id.trim().length > 256 ||
      typeof match.partnerId !== 'string' || !match.partnerId.trim() || match.partnerId.trim().length > 256 ||
      typeof match.displayName !== 'string' || !match.displayName.trim() || match.displayName.trim().length > 100 ||
      typeof match.age !== 'number' || !Number.isFinite(match.age) || match.age < 18 || match.age > 120) {
    return null;
  }
  const lastMessage = typeof match.lastMessage === 'string'
    ? match.lastMessage.trim().slice(0, 1000)
    : '';
  return {
    id: match.id.trim(),
    partnerId: match.partnerId.trim(),
    displayName: match.displayName.trim(),
    age: Math.floor(match.age),
    country: typeof match.country === 'string' ? match.country.trim().slice(0, 100) : '',
    city: typeof match.city === 'string' ? match.city.trim().slice(0, 100) : '',
    lastMessage: lastMessage || null,
    lastMessageAt: typeof match.lastMessageAt === 'string' && match.lastMessageAt.length <= 100 &&
      Number.isFinite(Date.parse(match.lastMessageAt))
      ? match.lastMessageAt
      : null
  };
};

export const normalizeServerMessage = (value: unknown): ServerMessage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Partial<ServerMessage>;
  if (typeof message.id !== 'string' || !message.id.trim() || message.id.trim().length > 256 ||
      typeof message.senderId !== 'string' || !message.senderId.trim() || message.senderId.trim().length > 256 ||
      typeof message.text !== 'string' || !message.text.trim() || message.text.length > 10000 ||
      typeof message.createdAt !== 'string' || message.createdAt.length > 100 ||
      !Number.isFinite(Date.parse(message.createdAt))) {
    return null;
  }
  return {
    id: message.id.trim(),
    senderId: message.senderId.trim(),
    text: message.text,
    createdAt: message.createdAt,
    ...(typeof message.cursorCreatedAt === 'string' && message.cursorCreatedAt.length <= 100 &&
      Number.isFinite(Date.parse(message.cursorCreatedAt))
      ? { cursorCreatedAt: message.cursorCreatedAt }
      : {})
  };
};

export const normalizeUserId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= 256 ? id : null;
};

export const deduplicateById = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
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
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [olderMessagesFailed, setOlderMessagesFailed] = useState(false);
  const [matchesFailed, setMatchesFailed] = useState(false);
  const [messagesFailed, setMessagesFailed] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [matchFilter, setMatchFilter] = useState<'all' | 'withMessages' | 'withoutMessages'>('all');
  const messageRequestId = useRef(0);
  const matchesRequestId = useRef(0);
  const currentUserRequestId = useRef(0);
  const sessionEpoch = useRef(0);
  const sendInFlight = useRef(false);
  const messagesLogRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollMessagesRef = useRef(true);
  const pendingScrollAdjustmentRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const mobileBackButtonRef = useRef<HTMLButtonElement | null>(null);
  const matchButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedMatchIdRef = useRef('');

  // Drop every piece of account-scoped inbox state when the server rejects the session.
  // This also invalidates pending reads/sends so an old account cannot repopulate the UI.
  const clearSessionState = useCallback(() => {
    sessionEpoch.current += 1;
    sendInFlight.current = false;
    messageRequestId.current += 1;
    matchesRequestId.current += 1;
    currentUserRequestId.current += 1;
    setMatches([]);
    setSelected('');
    setMessages([]);
    setMessagesOffset(0);
    setMessagesHasMore(false);
    setOlderMessagesLoading(false);
    setOlderMessagesFailed(false);
    pendingScrollAdjustmentRef.current = null;
    setDrafts({});
    setSearchQuery('');
    setMatchFilter('all');
    setCurrentUserId(null);
    setAuthenticated(false);
    setNotice('');
    setMatchesLoading(false);
    setMessagesLoading(false);
    setMatchesFailed(false);
    setMessagesFailed(false);
    setBusy(false);
  }, []);

  const loadMatches = useCallback(async () => {
    const requestId = ++matchesRequestId.current;
    setMatchesLoading(true);
    setMatchesFailed(false);
    try {
      const response = await fetch('/api/matches', { credentials: 'include' });
      if (requestId !== matchesRequestId.current) return;
      if (response.status === 401) {
        clearSessionState();
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMatchesError'));
      const data = await response.json();
      if (requestId !== matchesRequestId.current) return;
      const nextMatches = deduplicateById<ServerMatch>(
        Array.isArray(data?.matches)
          ? data.matches.slice(-500).map((value: unknown) => normalizeServerMatch(value)).filter((match: ServerMatch | null): match is ServerMatch => match !== null)
          : []
      );
      setMatches(nextMatches);
      setAuthenticated(true);
      setMatchesFailed(false);
      setNotice(nextMatches.length ? '' : t('noMutualMatches'));
      if (selected && !nextMatches.some(match => match.id === selected)) {
        // Invalidate any in-flight message request for a match that is no longer available.
        messageRequestId.current += 1;
        setMessagesLoading(false);
        setMessagesFailed(false);
        setSelected('');
        setMessages([]);
        setMessagesOffset(0);
        setMessagesHasMore(false);
        setOlderMessagesLoading(false);
        setOlderMessagesFailed(false);
        pendingScrollAdjustmentRef.current = null;
      }
    } catch (error) {
      if (requestId === matchesRequestId.current) {
        setMatchesFailed(true);
        setNotice(error instanceof Error ? error.message : t('loadMatchesError'));
      }
    } finally {
      if (requestId === matchesRequestId.current) setMatchesLoading(false);
    }
  }, [selected, t, clearSessionState]);

  const loadMessages = useCallback(async (matchId: string) => {
    if (!matchId) return;
    const requestId = ++messageRequestId.current;
    // A latest-history refresh supersedes any older-page request and its scroll anchor.
    setOlderMessagesLoading(false);
    setOlderMessagesFailed(false);
    pendingScrollAdjustmentRef.current = null;
    setMessagesLoading(true);
    setMessagesFailed(false);
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages?limit=${MESSAGE_PAGE_SIZE}&latest=true`, { credentials: 'include' });
      if (requestId !== messageRequestId.current) return;
      if (response.status === 401) {
        clearSessionState();
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
        setMessagesOffset(0);
        setMessagesHasMore(false);
        setOlderMessagesLoading(false);
        setOlderMessagesFailed(false);
        pendingScrollAdjustmentRef.current = null;
        setNotice(t('loadMessagesError'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMessagesError'));
      const data = await response.json();
      if (requestId !== messageRequestId.current) return;
      const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
      const nextMessages = deduplicateById<ServerMessage>(
        rawMessages.map((value: unknown) => normalizeServerMessage(value)).filter((message: ServerMessage | null): message is ServerMessage => message !== null)
      );
      setMessages(nextMessages);
      setMessagesOffset(rawMessages.length);
      setMessagesHasMore(rawMessages.length === MESSAGE_PAGE_SIZE);
      setOlderMessagesFailed(false);
      setMessagesFailed(false);
    } catch (error) {
      if (requestId === messageRequestId.current) {
        setMessagesFailed(true);
        setNotice(error instanceof Error ? error.message : t('loadMessagesError'));
      }
    } finally {
      if (requestId === messageRequestId.current) setMessagesLoading(false);
    }
  }, [t, clearSessionState]);

  useEffect(() => { void loadMatches(); }, [loadMatches]);
  // Refresh the inbox when the user returns to the app so new mutual matches appear
  // without requiring a manual refresh or a full page reload.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void loadMatches();
      // Refresh an open conversation on return, but do not replace older history
      // while the reader is intentionally scrolled away from the newest messages.
      if (selected && shouldAutoScrollMessagesRef.current && !sendInFlight.current) void loadMessages(selected);
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadMatches, loadMessages, selected]);
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

  // A session may become valid again while this panel stays mounted (for example,
  // after a focus refresh). Re-read the account ID before classifying message authors.
  useEffect(() => {
    if (authenticated !== true || currentUserId !== null) return;
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
  }, [authenticated, currentUserId]);

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
      setMessagesOffset(0);
      setMessagesHasMore(false);
      setOlderMessagesLoading(false);
      setOlderMessagesFailed(false);
      pendingScrollAdjustmentRef.current = null;
      setDrafts({});
      setSearchQuery('');
      setMatchFilter('all');
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

  useEffect(() => {
    if (selected) {
      setMessagesOffset(0);
      setMessagesHasMore(false);
      setOlderMessagesLoading(false);
      setOlderMessagesFailed(false);
      pendingScrollAdjustmentRef.current = null;
      void loadMessages(selected);
    }
  }, [selected, loadMessages]);

  // Start each conversation at the latest message. Within a conversation,
  // preserve the reader's position when they have scrolled up through history.
  useEffect(() => {
    shouldAutoScrollMessagesRef.current = true;
  }, [selected]);

  // On mobile the list and conversation are mutually exclusive. Move focus into
  // the visible view when one replaces the other so keyboard users never remain
  // focused on a control hidden by display:none.
  useEffect(() => {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    if (selected) {
      lastSelectedMatchIdRef.current = selected;
      mobileBackButtonRef.current?.focus();
      return;
    }
    const previousMatchId = lastSelectedMatchIdRef.current;
    const previousMatchButton = previousMatchId ? matchButtonRefs.current.get(previousMatchId) : null;
    if (previousMatchButton?.isConnected && previousMatchButton.offsetParent !== null) previousMatchButton.focus();
    else document.getElementById('vow-match-search')?.focus();
  }, [selected]);

  // Keep the newest message visible without moving the whole page.
  // Respect the user's reduced-motion preference when scrolling.
  useEffect(() => {
    if (!selected || messagesLoading) return;
    const log = messagesLogRef.current;
    if (!log) return;
    const pendingAdjustment = pendingScrollAdjustmentRef.current;
    if (pendingAdjustment) {
      log.scrollTop = pendingAdjustment.scrollTop + (log.scrollHeight - pendingAdjustment.scrollHeight);
      pendingScrollAdjustmentRef.current = null;
      shouldAutoScrollMessagesRef.current = false;
      return;
    }
    if (!shouldAutoScrollMessagesRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [selected, messages, messagesLoading]);

  const send = async () => {
    // Keep the request-side limit aligned with the composer maxLength.
    const text = draft.trim().slice(0, 4000);
    const matchId = selected;
    const actionEpoch = sessionEpoch.current;
    // Lock synchronously so Enter + click (or two rapid key events) cannot
    // start duplicate POST requests before React re-renders with busy=true.
    if (!text || !matchId || busy || sendInFlight.current) return;
    sendInFlight.current = true;
    // A send response is authoritative for the just-created message. Invalidate
    // any older history/prepend request so it cannot overwrite that response.
    messageRequestId.current += 1;
    setMessagesLoading(false);
    setOlderMessagesLoading(false);
    setOlderMessagesFailed(false);
    pendingScrollAdjustmentRef.current = null;
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
      if (actionEpoch !== sessionEpoch.current) return;
      if (response.status === 401) {
        clearSessionState();
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
        if (selected === matchId) {
          setSelected('');
          setMessages([]);
          setMessagesOffset(0);
          setMessagesHasMore(false);
          setOlderMessagesLoading(false);
          setOlderMessagesFailed(false);
          pendingScrollAdjustmentRef.current = null;
        }
        setNotice(t('sendMessageError'));
        return;
      }
      if (!response.ok) throw new Error(data?.error === 'too_many_messages' ? t('messageRateLimit') : t('sendMessageError'));
      const sentMessage = normalizeServerMessage(data?.message);
      if (!sentMessage) throw new Error(t('sendMessageError'));
      if (selected === matchId) {
        shouldAutoScrollMessagesRef.current = true;
        pendingScrollAdjustmentRef.current = null;
        setMessages(current => deduplicateById([...current, sentMessage]));
      }
      setDrafts(current => ({ ...current, [matchId]: '' }));
      void loadMatches();
    } catch (error) {
      if (actionEpoch === sessionEpoch.current) {
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

  const loadOlderMessages = async () => {
    const matchId = selected;
    const requestId = messageRequestId.current;
    const offset = messagesOffset;
    if (!matchId || !messagesHasMore || olderMessagesLoading || busy) return;
    setOlderMessagesLoading(true);
    setOlderMessagesFailed(false);
    try {
      const oldestLoadedMessage = messages[0];
      if (!oldestLoadedMessage) return;
      const cursor = `beforeCreatedAt=${encodeURIComponent(oldestLoadedMessage.cursorCreatedAt || oldestLoadedMessage.createdAt)}&beforeId=${encodeURIComponent(oldestLoadedMessage.id)}`;
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages?limit=${MESSAGE_PAGE_SIZE}&latest=true&${cursor}`, { credentials: 'include' });
      if (requestId !== messageRequestId.current) return;
      if (response.status === 401) {
        clearSessionState();
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (response.status === 404) {
        messageRequestId.current += 1;
        matchesRequestId.current += 1;
        setMatches(current => current.filter(match => match.id !== matchId));
        setSelected('');
        setMessages([]);
        setMessagesOffset(0);
        setMessagesHasMore(false);
        setOlderMessagesLoading(false);
        setOlderMessagesFailed(false);
        pendingScrollAdjustmentRef.current = null;
        setNotice(t('loadMessagesError'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMessagesError'));
      const data = await response.json();
      if (requestId !== messageRequestId.current) return;
      const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
      const olderMessages = deduplicateById<ServerMessage>(
        rawMessages.map((value: unknown) => normalizeServerMessage(value)).filter((message: ServerMessage | null): message is ServerMessage => message !== null)
      );
      // Capture the reader's actual position after the network wait, immediately
      // before React prepends the page, so scrolling during the request is respected.
      const currentLog = messagesLogRef.current;
      pendingScrollAdjustmentRef.current = currentLog
        ? { scrollHeight: currentLog.scrollHeight, scrollTop: currentLog.scrollTop }
        : null;
      setMessages(current => deduplicateById([...olderMessages, ...current]));
      setMessagesOffset(offset + rawMessages.length);
      setMessagesHasMore(rawMessages.length === MESSAGE_PAGE_SIZE);
      setNotice('');
    } catch (error) {
      if (requestId === messageRequestId.current) {
        pendingScrollAdjustmentRef.current = null;
        setOlderMessagesFailed(true);
        setNotice('');
      }
    } finally {
      if (requestId === messageRequestId.current) setOlderMessagesLoading(false);
    }
  };

  const filteredMatches = matches.filter(match => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const searchable = [match.displayName, match.city, match.country, match.lastMessage || ''].join(' ').toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (matchFilter === 'withMessages' && !match.lastMessage) return false;
    if (matchFilter === 'withoutMessages' && match.lastMessage) return false;
    return true;
  });
  const selectedMatch = matches.find(match => match.id === selected) || null;
  const initials = (name: string) => name.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0] || '').join('').toLocaleUpperCase();

  return (
    <section data-testid="server-matches-panel" aria-busy={matchesLoading || messagesLoading || olderMessagesLoading || busy} className={`vow-screen vow-inbox-shell mb-5 overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#0b0b0e] shadow-2xl shadow-black/25 ${selected ? 'has-selection' : ''}`}>
      <div className="vow-inbox-heading">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-rose-300">{t('serverChats')}</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-white">{t('mutualMatches')}</h2>
          <p className="mt-1 text-xs text-stone-400">{t('realMatchesOnly')}</p>
        </div>
        <span className="vow-inbox-total">{matches.length}</span>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-5">
          <p data-testid="server-match-login-required" className="text-sm text-stone-200">{t('loginToSeeMatches')}</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 min-h-11 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">{t('login')}</button>
        </div>
      ) : (
        <>
          {matchesLoading && <p role="status" aria-live="polite" aria-atomic="true" className="mb-3 rounded-xl border border-white/10 bg-stone-950/50 px-3 py-3 text-center text-xs text-stone-300">{t('loading')}</p>}
          {!matchesLoading && matchesFailed && <div className="mb-3 rounded-xl border border-rose-500/20 bg-rose-950/20 p-3" role="alert"><p className="text-xs text-stone-200">{notice || t('loadMatchesError')}</p><button type="button" onClick={() => void loadMatches()} className="mt-2 min-h-11 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white">{t('retry')}</button></div>}
          {!matchesLoading && !matchesFailed && matches.length === 0 ? (
            <div data-testid="server-match-empty" role="status" aria-live="polite" aria-atomic="true" className="rounded-2xl border border-white/10 bg-stone-950/50 p-6 text-center">
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full border border-rose-400/20 bg-rose-500/10 text-2xl text-rose-300">♡</div>
              <p className="text-sm font-semibold text-stone-100">{t('noMutualMatches')}</p>
            </div>
          ) : matches.length > 0 && (
            <div className="vow-inbox-layout">
              <aside className="vow-inbox-sidebar" aria-label={t('chatThreads')}>
                <div className="vow-inbox-search">
                  <label className="sr-only" htmlFor="vow-match-search">{t('search')}</label>
                  <span aria-hidden="true">⌕</span>
                  <input id="vow-match-search" data-testid="server-match-search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder={t('search')} autoComplete="off" />
                  {searchQuery && <button type="button" aria-label={t('clearSearch')} onClick={() => setSearchQuery('')}>×</button>}
                </div>

                <div className="vow-inbox-quickstrip" role="group" aria-label={t('yourMatches')}>
                  {matches.slice(0, 8).map(match => (
                    <button key={match.id} type="button" data-testid="server-match-quick-card" disabled={busy} aria-pressed={selected === match.id} onClick={() => { messageRequestId.current += 1; setMessages([]); setMessagesOffset(0); setMessagesHasMore(false); setOlderMessagesLoading(false); setOlderMessagesFailed(false); pendingScrollAdjustmentRef.current = null; setNotice(''); setSelected(match.id); }} className="vow-inbox-quickcard">
                      <span className="vow-inbox-avatar vow-inbox-avatar--quick">{initials(match.displayName)}</span>
                      <span>{match.displayName}</span>
                    </button>
                  ))}
                </div>

                <div className="vow-inbox-filters" role="group" aria-label={t('conversationFilters')}>
                  <button type="button" data-testid="server-match-filter-all" aria-pressed={matchFilter === 'all'} onClick={() => setMatchFilter('all')} className={matchFilter === 'all' ? 'is-active' : ''}>{t('filterAll')}</button>
                  <button type="button" data-testid="server-match-filter-messaged" aria-pressed={matchFilter === 'withMessages'} onClick={() => setMatchFilter('withMessages')} className={matchFilter === 'withMessages' ? 'is-active' : ''}>{t('filterWithMessages')}</button>
                  <button type="button" data-testid="server-match-filter-new" aria-pressed={matchFilter === 'withoutMessages'} onClick={() => setMatchFilter('withoutMessages')} className={matchFilter === 'withoutMessages' ? 'is-active' : ''}>{t('filterWithoutMessages')}</button>
                </div>

                <div className="vow-inbox-list" role="group" aria-label={t('chatThreads')}>
                  {filteredMatches.map(match => (
                    <button data-testid="server-match-item" type="button" key={match.id} ref={node => { if (node) matchButtonRefs.current.set(match.id, node); else matchButtonRefs.current.delete(match.id); }} aria-pressed={selected === match.id} disabled={busy} onClick={() => { messageRequestId.current += 1; setMessages([]); setMessagesOffset(0); setMessagesHasMore(false); setOlderMessagesLoading(false); setOlderMessagesFailed(false); pendingScrollAdjustmentRef.current = null; setNotice(''); setSelected(match.id); }} className={`vow-inbox-row ${selected === match.id ? 'is-selected' : ''}`}>
                      <span className="vow-inbox-avatar">{initials(match.displayName)}</span>
                      <span className="vow-inbox-row-copy">
                        <span className="vow-inbox-row-title">{match.displayName}, {match.age}</span>
                        <span className="vow-inbox-row-preview">{match.lastMessage || t('matchCreatedMessage')}</span>
                        {(match.city || match.country) && <span className="vow-inbox-row-location">{[match.city, match.country].filter(Boolean).join(', ')}</span>}
                      </span>
                      <span className="vow-inbox-row-time">{match.lastMessageAt ? formatDate(match.lastMessageAt, { dateStyle: 'short', timeStyle: 'short' }) : ''}</span>
                    </button>
                  ))}
                  {!filteredMatches.length && <p data-testid="server-match-filter-empty" role="status" className="p-5 text-center text-xs text-stone-400">{t('noConversationsFound')}</p>}
                </div>
                <button type="button" onClick={() => void loadMatches()} disabled={matchesLoading || busy} aria-busy={matchesLoading} className="vow-inbox-refresh">{t('refreshMatches')}</button>
              </aside>

              <div data-testid="real-match-chat" className="vow-inbox-conversation">
                {selectedMatch ? (
                  <>
                    <header className="vow-inbox-chat-header">
                      <button type="button" data-testid="server-match-back" ref={mobileBackButtonRef} disabled={busy} onClick={() => { messageRequestId.current += 1; setSelected(''); setMessages([]); setMessagesOffset(0); setMessagesHasMore(false); setOlderMessagesLoading(false); setOlderMessagesFailed(false); pendingScrollAdjustmentRef.current = null; setNotice(''); }} className="vow-inbox-back" aria-label={t('chatBackToList')}>←</button>
                      <span className="vow-inbox-avatar vow-inbox-avatar--header">{initials(selectedMatch.displayName)}</span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm text-white">{selectedMatch.displayName}, {selectedMatch.age}</strong>
                        <span className="block truncate text-xs text-stone-400">{[selectedMatch.city, selectedMatch.country].filter(Boolean).join(', ') || t('mutualMatches')}</span>
                      </span>
                      <span className="vow-inbox-match-label">{t('matched')}</span>
                    </header>
                    {notice && !messagesFailed && <p role="status" aria-live="polite" className="px-4 pt-2 text-xs text-stone-300">{notice}</p>}
                    <div className="vow-inbox-message-area">
                      {messagesLoading && <p role="status" aria-live="polite" aria-atomic="true" className="py-3 text-xs text-stone-400">{t('loading')}</p>}
                      {messagesFailed && <div role="alert" className="mb-2 rounded-xl border border-rose-500/20 bg-rose-950/20 p-3"><p className="text-xs text-stone-200">{notice || t('loadMessagesError')}</p><button type="button" onClick={() => void loadMessages(selected)} className="mt-2 min-h-11 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white">{t('retry')}</button></div>}
                      {messagesHasMore && <button type="button" data-testid="server-match-load-older" onClick={() => void loadOlderMessages()} disabled={olderMessagesLoading || busy} className="vow-inbox-load-older">{olderMessagesLoading ? t('loading') : olderMessagesFailed ? t('retryEarlierMessages') : t('loadEarlierMessages')}</button>}
                      {olderMessagesFailed && <p role="alert" className="px-2 text-center text-xs text-rose-300">{notice || t('loadMessagesError')}</p>}
                      <div ref={messagesLogRef} onScroll={event => {
                        const log = event.currentTarget;
                        shouldAutoScrollMessagesRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
                      }} data-testid="server-match-messages" role="log" aria-live="polite" aria-relevant="additions text" aria-atomic="false" aria-label={t('chatMessages')} aria-busy={messagesLoading || olderMessagesLoading} className="vow-inbox-message-log">
                        {messages.map(message => (
                          <div key={message.id} className={`vow-inbox-bubble ${message.senderId === currentUserId ? 'is-mine' : 'is-theirs'}`}>
                            <p dir="auto" className="whitespace-pre-wrap break-words">{message.text}</p>
                            <time dateTime={message.createdAt}>{formatDate(message.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                          </div>
                        ))}
                      </div>
                      {!messagesLoading && !messagesFailed && !messages.length && <p role="status" className="py-4 text-center text-xs text-stone-500">{t('noMessagesYet')}</p>}
                    </div>
                    <form className="vow-inbox-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
                      <textarea dir="auto" aria-label={t('writeMessage')} value={draft} onChange={event => setDrafts(current => ({ ...current, [selected]: event.target.value }))} onKeyDown={event => { if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || busy || !draft.trim()) return; event.preventDefault(); void send(); }} disabled={busy} maxLength={4000} rows={2} placeholder={t('writeMessage')} />
                      <button data-testid="server-match-send" type="submit" disabled={busy || !draft.trim()}>{busy ? t('sendingMessage') : t('sendMessage')}</button>
                      <button type="button" data-testid="server-match-refresh-messages" onClick={() => { shouldAutoScrollMessagesRef.current = true; void loadMessages(selected); }} disabled={busy || messagesLoading}>{t('refreshMessages')}</button>
                    </form>
                  </>
                ) : (
                  <div className="vow-inbox-welcome">
                    <span className="vow-inbox-welcome-icon">♡</span>
                    <h3>{t('inboxWelcomeTitle')}</h3>
                    <p>{t('inboxWelcomeDescription')}</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};