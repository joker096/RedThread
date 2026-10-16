import React, { useCallback, useEffect, useState } from 'react';

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
  const [matches, setMatches] = useState<ServerMatch[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');

  const loadMatches = useCallback(async () => {
    try {
      const response = await fetch('/api/matches', { credentials: 'include' });
      if (response.status === 401) {
        setAuthenticated(false);
        setMatches([]);
        return;
      }
      if (!response.ok) throw new Error('Не удалось загрузить совпадения.');
      const data = await response.json();
      setMatches(data.matches || []);
      setAuthenticated(true);
      setNotice(data.matches?.length ? '' : 'Взаимных совпадений пока нет. Они появляются только после лайка с обеих сторон.');
      if (selected && !(data.matches || []).some((match: ServerMatch) => match.id === selected)) {
        setSelected('');
        setMessages([]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка загрузки совпадений.');
    }
  }, [selected]);

  const loadMessages = useCallback(async (matchId: string) => {
    if (!matchId) return;
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/messages`, { credentials: 'include' });
      if (!response.ok) throw new Error('Не удалось загрузить сообщения.');
      const data = await response.json();
      setMessages(data.messages || []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка загрузки сообщений.');
    }
  }, []);

  useEffect(() => { void loadMatches(); }, [loadMatches]);
  useEffect(() => { if (selected) void loadMessages(selected); }, [selected, loadMessages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !selected || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(selected)}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error === 'too_many_messages' ? 'Слишком много сообщений за короткое время. Попробуйте позже.' : 'Не удалось отправить сообщение.');
      setMessages(current => [...current, data.message]);
      setDraft('');
      void loadMatches();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Ошибка отправки сообщения.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-5 rounded-3xl border border-sky-500/20 bg-stone-900/80 p-4 sm:p-5">
      <div className="mb-3">
        <p className="text-[10px] uppercase tracking-[0.2em] text-sky-300">Серверные чаты</p>
        <h3 className="mt-1 text-lg font-bold text-white">Взаимные совпадения</h3>
        <p className="mt-1 text-xs text-stone-400">Здесь отображаются только реальные совпадения аккаунтов. Демо-чаты ниже отделены от серверных.</p>
      </div>
      {authenticated === false ? (
        <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-4">
          <p className="text-sm text-stone-200">Войдите, чтобы увидеть свои совпадения и сообщения.</p>
          <button type="button" onClick={onOpenAccount} className="mt-3 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-bold text-white">Вход и регистрация</button>
        </div>
      ) : (
        <div className="space-y-3">
          {matches.map(match => (
            <button type="button" key={match.id} onClick={() => setSelected(match.id)} className={`w-full rounded-2xl border p-3 text-left ${selected === match.id ? 'border-sky-400/60 bg-sky-950/30' : 'border-white/10 bg-stone-950/60'}`}>
              <span className="block text-sm font-semibold text-white">{match.displayName}, {match.age}</span>
              <span className="mt-1 block text-xs text-stone-400">{match.city}, {match.country}</span>
              <span className="mt-1 block truncate text-xs text-stone-500">{match.lastMessage || 'Совпадение создано — напишите первым(-ой)'}</span>
            </button>
          ))}
          {notice && <p role="status" className="text-xs text-stone-300">{notice}</p>}
          {selected && (
            <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3">
              <div className="mb-3 max-h-64 space-y-2 overflow-y-auto">
                {messages.map(message => (
                  <div key={message.id} className={`max-w-[90%] rounded-xl px-3 py-2 text-xs ${message.senderId ? 'bg-stone-800 text-stone-100' : 'bg-stone-800 text-stone-100'}`}>
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    <time className="mt-1 block text-[9px] text-stone-500">{new Date(message.createdAt).toLocaleString()}</time>
                  </div>
                ))}
                {!messages.length && <p className="text-xs text-stone-500">Сообщений пока нет. Начните разговор уважительно и без спешки.</p>}
              </div>
              <textarea value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} rows={2} placeholder="Напишите сообщение…" className="w-full resize-y rounded-xl border border-white/10 bg-stone-900 p-3 text-sm text-white" />
              <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className="mt-2 w-full rounded-xl bg-sky-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">{busy ? 'Отправляем…' : 'Отправить сообщение'}</button>
              <button type="button" onClick={() => void loadMessages(selected)} className="mt-2 w-full rounded-xl border border-white/10 px-4 py-2 text-xs text-stone-300">Обновить сообщения</button>
            </div>
          )}
          <button type="button" onClick={() => void loadMatches()} className="w-full rounded-xl border border-white/10 px-4 py-2.5 text-xs font-semibold text-stone-300">Обновить совпадения</button>
        </div>
      )}
    </section>
  );
};
