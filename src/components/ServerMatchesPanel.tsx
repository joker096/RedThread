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

  const loadMatches = useCallback(async () => {
    try {
      const response = await fetch('/api/matches', { credentials: 'include' });
      if (response.status === 401) {
        setAuthenticated(false);
        messageRequestId.current += 1;
        setMatches([]);
        setSelected('');
        setMessages([]);
        setNotice(t('loginToSeeMatches'));
        return;
      }
      if (!response.ok) throw new Error(t('loadMatchesError'));
      const data = await response.json();
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
      setNotice(error instanceof Error ? error.message : t('loadMatchesError'));
    }
  }, [selected]);

  const loadMessages = useCallback(async (matchId: string) => {
    if (!matchId) return;
    const requestId = ++messageRequestId.current;
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages`, { credentials: 'include' });
      if (requestId !== messageRequestId.current) return;
      if (response.status === 401) {
        // Expired sessions invalidate every in-flight request for this conversation.
        messageRequestId.current += 1;
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
        // A session can expire while a message is being sent; discard the stale chat.
        messageRequestId.current += 1;
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
    <section className="mb-5 rounded-3xl border border-sky-500/20 bg-stone-900/80 p-4 sm:p-5">
      <div className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-sky-300">{t('serverChats')}</p>
        <h3 className="mt-1 text-lg font-bold text-white">{t('mutualMatches')}</h3>
        <p className="mt-1 text-xs text-stone-400">{t('realMatchesOnly')}</p>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
          <p className="text-sm text-stone-200">{t('loginToSeeMatches')}</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">{t('login')}</button>
        </div>
      ) : (
        <div className="space-y-3">
          {matches.map(match => (
            <button type="button" key={match.id} onClick={() => { messageRequestId.current += 1; setMessages([]); setNotice(''); setSelected(match.id); }} className={`vow-motion-button w-full rounded-2xl border p-3 text-left ${selected === match.id ? 'border-sky-400/60 bg-sky-950/30' : 'border-white/10 bg-stone-950/60'}`}>
              <span className="block text-sm font-semibold text-white">{match.displayName}, {match.age}</span>
              <span className="mt-1 block text-xs text-stone-400">{match.city}, {match.country}</span>
              <span className="mt-1 block truncate text-xs text-stone-500">{match.lastMessage || t('matchCreatedMessage')}</span>
            </button>
          ))}
          {notice && <p role="status" className="text-xs text-stone-300">{notice}</p>}
          {selected && (
            <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3">
              <div role="log" aria-live="polite" aria-label={t('serverChats')} className="mb-3 max-h-64 space-y-2 overflow-y-auto">
                {messages.map(message => (
                  <div key={message.id} className={`max-w-[90%] rounded-xl px-3 py-2 text-xs ${message.senderId === currentUserId ? 'ml-auto bg-rose-700 text-white' : 'mr-auto bg-stone-800 text-stone-100'}`}>
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    <time className="mt-1 block text-[9px] text-stone-500">{formatDate(message.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                  </div>
                ))}
                {!messages.length && <p className="text-xs text-stone-500">{t('noMessagesYet')}</p>}
              </div>
              <textarea aria-label={t('writeMessage')} value={draft} onChange={e => setDrafts(current => ({ ...current, [selected]: e.target.value }))} maxLength={4000} rows={2} placeholder={t('writeMessage')} className="w-full resize-y rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white" />
              <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="vow-motion-button mt-2 w-full rounded-xl bg-sky-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">{busy ? t('sendingMessage') : t('sendMessage')}</button>
              <button type="button" onClick={() => void loadMessages(selected)} className="vow-motion-button mt-2 w-full rounded-xl border border-white/10 px-4 py-2 text-xs text-stone-300">{t('refreshMessages')}</button>
            </div>
          )}
          <button type="button" onClick={() => void loadMatches()} className="vow-motion-button w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-300">{t('refreshMatches')}</button>
        </div>
      )}
    </section>
  );
};
