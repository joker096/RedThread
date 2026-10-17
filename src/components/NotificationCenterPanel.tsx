import React, { useCallback, useEffect, useRef, useState } from 'react';
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
 const refreshRequestId=useRef(0);
 const busyRequestId=useRef(0);
 const sessionEpoch=useRef(0);
 const refresh=useCallback(async()=>{
  const requestId=++refreshRequestId.current;
  const actionEpoch=sessionEpoch.current;
  const busyId=++busyRequestId.current;
  setBusy(true);
  try{
   const response=await fetch('/api/notifications?limit=20',{credentials:'include'});
   if(requestId!==refreshRequestId.current||actionEpoch!==sessionEpoch.current)return;
   if(response.status===401){sessionEpoch.current+=1;refreshRequestId.current+=1;busyRequestId.current+=1;setBusy(false);setAllowed(false);setReady(true);setItems([]);setUnread(0);setNotice('');return;}
   const data=await response.json().catch(()=>null);
   if(requestId!==refreshRequestId.current||actionEpoch!==sessionEpoch.current)return;
   if(!response.ok)throw new Error(t('notificationsLoadError'));
   const notifications: NotificationItem[] = Array.isArray(data?.notifications)
    ? data.notifications.filter((item: unknown): item is NotificationItem => {
       if (!item || typeof item !== 'object') return false;
       const value = item as Partial<NotificationItem>;
       return typeof value.id === 'string' && value.id.trim().length > 0 &&
        (value.type === 'new_match' || value.type === 'new_message') &&
        value.metadata !== null && typeof value.metadata === 'object' && !Array.isArray(value.metadata) &&
        typeof value.createdAt === 'string' && value.createdAt.trim().length > 0 && Number.isFinite(Date.parse(value.createdAt)) &&
        (value.readAt === null || (typeof value.readAt === 'string' && value.readAt.trim().length > 0 && Number.isFinite(Date.parse(value.readAt))));
      })
    : [];
   const unreadCount = Number(data?.unreadCount);
   setItems(notifications);setUnread(Number.isFinite(unreadCount) ? Math.max(0, Math.floor(unreadCount)) : 0);setAllowed(true);setReady(true);setNotice('');
  }catch{if(requestId===refreshRequestId.current&&actionEpoch===sessionEpoch.current){setNotice(t('notificationsLoadError'));setReady(true);}}
  finally{if(busyId===busyRequestId.current&&actionEpoch===sessionEpoch.current)setBusy(false);}
 },[t]);
 useEffect(()=>{void refresh();const refreshOnFocus=()=>void refresh();const refreshOnSession=()=>{sessionEpoch.current+=1;refreshRequestId.current+=1;busyRequestId.current+=1;setAllowed(false);setReady(false);setItems([]);setUnread(0);setNotice('');void refresh();};window.addEventListener('focus',refreshOnFocus);window.addEventListener('vow:session-changed',refreshOnSession);return()=>{window.removeEventListener('focus',refreshOnFocus);window.removeEventListener('vow:session-changed',refreshOnSession);refreshRequestId.current+=1;busyRequestId.current+=1;sessionEpoch.current+=1;};},[refresh]);
 const markRead=async(id?:string)=>{
  if(busy)return;
  const actionEpoch=sessionEpoch.current;
  const busyId=++busyRequestId.current;
  setBusy(true);
  try{
   const response=await fetch(id?'/api/notifications/'+encodeURIComponent(id)+'/read':'/api/notifications/read-all',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'});
   if(actionEpoch!==sessionEpoch.current)return;
   if(response.status===401){sessionEpoch.current+=1;refreshRequestId.current+=1;busyRequestId.current+=1;setBusy(false);setAllowed(false);setReady(true);setItems([]);setUnread(0);setNotice('');return;}
   if(!response.ok)throw new Error(t('notificationsMarkReadError'));
   await refresh();
  }catch{if(actionEpoch===sessionEpoch.current){setNotice(t('notificationsMarkReadError'));if(busyId===busyRequestId.current)setBusy(false);}}
 };
 if(!ready||!allowed)return null;
 return <section role="region" aria-label={t('notificationCenter')} aria-busy={busy} className="vow-screen mb-5 rounded-3xl border border-sky-500/20 bg-stone-900/80 p-4 sm:p-5">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-sky-300">{t('notifications')}</p><h3 className="mt-1 text-lg font-bold text-white">{t('notificationCenter')} · {unread}</h3></div><div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void refresh()} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-200">{t('refreshNotifications')}</button><button type="button" disabled={busy||unread===0} onClick={()=>void markRead()} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-200 disabled:opacity-40">{t('markAllRead')}</button></div></div>
  {notice&&<p role="status" className="mt-3 text-xs text-amber-200">{notice}</p>}
  {!items.length?<p className="mt-3 text-xs text-stone-500">{t('noNotifications')}</p>:<div role="list" className="mt-3 space-y-2">{items.map(item=><div key={item.id} role="listitem" className={`rounded-xl border p-3 ${item.readAt?'border-white/5 bg-stone-950/40':'border-sky-500/20 bg-sky-950/20'}`}><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-xs font-semibold text-stone-100">{item.type==='new_match'?t('notificationNewMatch'):t('notificationNewMessage')}</p><p className="mt-1 text-[10px] text-stone-500">{formatDate(item.createdAt,{dateStyle:'medium',timeStyle:'short'})}</p></div>{!item.readAt&&<button type="button" disabled={busy} onClick={()=>void markRead(item.id)} aria-label={`${t('markRead')}: ${item.type==='new_match'?t('notificationNewMatch'):t('notificationNewMessage')}`} className="shrink-0 text-[10px] text-sky-300 underline">{t('markRead')}</button>}</div></div>)}</div>}
 </section>;
};
