import React, { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
type NotificationItem={id:string;type:'new_match'|'new_message';metadata:Record<string,unknown>;createdAt:string;readAt:string|null};
export const NotificationCenterPanel:React.FC=()=>{
 const {t,formatDate}=useLocale();
 const [items,setItems]=useState<NotificationItem[]>([]);
 const [unread,setUnread]=useState(0);
 const [ready,setReady]=useState(false);
 const [busy,setBusy]=useState(false);
 const [allowed,setAllowed]=useState(false);
 const [notice,setNotice]=useState('');
 const refresh=useCallback(async()=>{
  setBusy(true);
  try{
   const response=await fetch('/api/notifications?limit=20',{credentials:'include'});
   if(response.status===401){setAllowed(false);setReady(true);return;}
   const data=await response.json().catch(()=>null);
   if(!response.ok)throw new Error('Не удалось загрузить уведомления.');
   setItems(data.notifications||[]);setUnread(Number(data.unreadCount)||0);setAllowed(true);setReady(true);setNotice('');
  }catch(error){setNotice(error instanceof Error?error.message:'Ошибка уведомлений.');setReady(true);}
  finally{setBusy(false);}
 },[]);
 useEffect(()=>{void refresh();},[refresh]);
 const markRead=async(id?:string)=>{
  setBusy(true);
  try{
   const response=await fetch(id?'/api/notifications/'+encodeURIComponent(id)+'/read':'/api/notifications/read-all',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:id?'{}':'{}'});
   if(!response.ok)throw new Error('Не удалось отметить уведомления прочитанными.');
   await refresh();
  }catch(error){setNotice(error instanceof Error?error.message:'Ошибка уведомлений.');}
  finally{setBusy(false);}
 };
 if(!ready||!allowed)return null;
 return <section className="mb-5 rounded-3xl border border-sky-500/20 bg-stone-900/80 p-4 sm:p-5">
  <div className="flex items-center justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-sky-300">{t('notifications')}</p><h3 className="mt-1 text-lg font-bold text-white">{t('notificationCenter')} · {unread}</h3></div><div className="flex gap-2"><button type="button" disabled={busy} onClick={()=>void refresh()} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-200">{t('refreshNotifications')}</button><button type="button" disabled={busy||unread===0} onClick={()=>void markRead()} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-200 disabled:opacity-40">{t('markAllRead')}</button></div></div>
  {notice&&<p role="status" className="mt-3 text-xs text-amber-200">{notice}</p>}
  {!items.length?<p className="mt-3 text-xs text-stone-500">{t('noNotifications')}</p>:<div className="mt-3 space-y-2">{items.map(item=><div key={item.id} className={`rounded-xl border p-3 ${item.readAt?'border-white/5 bg-stone-950/40':'border-sky-500/20 bg-sky-950/20'}`}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-stone-100">{item.type==='new_match'?t('notificationNewMatch'):t('notificationNewMessage')}</p><p className="mt-1 text-[10px] text-stone-500">{formatDate(item.createdAt,{dateStyle:'medium',timeStyle:'short'})}</p></div>{!item.readAt&&<button type="button" disabled={busy} onClick={()=>void markRead(item.id)} className="shrink-0 text-[10px] text-sky-300 underline">{t('markRead')}</button>}</div></div>)}</div>}
 </section>;
};
