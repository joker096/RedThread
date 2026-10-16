import React, { useCallback, useEffect, useState } from 'react';
type Screening={id:string;userId:string;scope:string;flags:string[];severity:string;reviewStatus:string;createdAt:string};
type Report={id:string;reporterId:string;reportedUserId:string;reportedDisplayName:string;category:string;details:string;status:string;createdAt:string};
type AuditEntry={id:string;moderatorId:string|null;action:string;targetType:string;targetId:string;reason:string|null;details:unknown;createdAt:string};

export const ModeratorConsolePanel:React.FC=()=>{
 const [allowed,setAllowed]=useState(false),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [screenings,setScreenings]=useState<Screening[]>([]),[reports,setReports]=useState<Report[]>([]),[audit,setAudit]=useState<AuditEntry[]>([]);
 const refresh=useCallback(async()=>{
  setBusy(true);
  try{
   const responses=await Promise.all([
    fetch('/api/admin/screenings',{credentials:'include'}),
    fetch('/api/admin/reports',{credentials:'include'}),
    fetch('/api/admin/audit-log?limit=30',{credentials:'include'})
   ]);
   if(responses.some(r=>r.status===401||r.status===403)){setAllowed(false);setReady(true);return;}
   const data=await Promise.all(responses.map(async r=>{const d=await r.json().catch(()=>null);if(!r.ok)throw new Error('Не удалось загрузить данные модерации.');return d||{};}));
   setScreenings(data[0].screenings||[]);setReports(data[1].reports||[]);setAudit(data[2].entries||[]);setAllowed(true);setReady(true);setNotice('');
  }catch(e){setNotice(e instanceof Error?e.message:'Ошибка загрузки панели.');setReady(true);}
  finally{setBusy(false);}
 },[]);
 useEffect(()=>{void refresh();const refreshOnSession=()=>void refresh();window.addEventListener('focus',refreshOnSession);window.addEventListener('vow:session-changed',refreshOnSession);return()=>{window.removeEventListener('focus',refreshOnSession);window.removeEventListener('vow:session-changed',refreshOnSession);};},[refresh]);
 const act=async(url:string,payload?:Record<string,unknown>)=>{
  setBusy(true);setNotice('');
  try{
   const response=await fetch(url,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})});
   const data=await response.json().catch(()=>null);if(!response.ok)throw new Error(data?.error||'Действие не выполнено.');
   setNotice('Действие сохранено в журнале модерации.');await refresh();
  }catch(e){setNotice(e instanceof Error?e.message:'Ошибка модерации.');}
  finally{setBusy(false);}
 };
 if(!ready||!allowed)return null;
 return <section className="mb-5 rounded-3xl border border-violet-500/30 bg-stone-900/90 p-4 sm:p-5">
  <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-violet-300">Только модераторы</p><h3 className="mt-1 text-lg font-bold text-white">Панель безопасности Vow</h3><p className="mt-1 text-xs text-stone-400">Очередь проверок, жалобы и журнал решений.</p></div><button type="button" onClick={()=>void refresh()} disabled={busy} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-200 disabled:opacity-50">Обновить</button></div>
  {notice&&<p role="status" className="mt-3 rounded-xl bg-stone-950 p-3 text-xs text-stone-300">{notice}</p>}
  <div className="mt-4 grid gap-4 lg:grid-cols-2">
   <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Проверки безопасности ({screenings.length})</h4>
    {!screenings.length?<p className="mt-2 text-xs text-stone-500">Ожидающих проверок нет.</p>:screenings.map(x=><div key={x.id} className="mt-2 rounded-xl border border-white/10 p-3"><p className="text-xs text-stone-200">{x.scope} · {x.severity}</p><p className="mt-1 break-words text-[10px] text-stone-400">{(x.flags||[]).join(', ')||'Без флагов'}</p><button type="button" disabled={busy} onClick={()=>void act('/api/admin/screenings/'+encodeURIComponent(x.id)+'/resolve')} className="mt-2 rounded-lg bg-emerald-800 px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50">Отметить проверенной</button></div>)}
   </div>
   <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Жалобы ({reports.length})</h4>
    {!reports.length?<p className="mt-2 text-xs text-stone-500">Открытых жалоб нет.</p>:reports.map(x=><div key={x.id} className="mt-2 rounded-xl border border-white/10 p-3"><p className="text-xs font-semibold text-stone-200">{x.category} · {x.reportedDisplayName}</p><p className="mt-1 whitespace-pre-wrap break-words text-[10px] text-stone-400">{x.details||'Описание не указано'}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void act('/api/admin/reports/'+encodeURIComponent(x.id)+'/action',{action:'resolve'})} className="rounded-lg bg-emerald-800 px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50">Решена</button><button type="button" disabled={busy} onClick={()=>void act('/api/admin/reports/'+encodeURIComponent(x.id)+'/action',{action:'dismiss'})} className="rounded-lg border border-white/10 px-3 py-1.5 text-[10px] text-stone-200 disabled:opacity-50">Отклонить</button><button type="button" disabled={busy} onClick={()=>{if(window.confirm('Подтверждаете приостановку аккаунта по этой жалобе?'))void act('/api/admin/reports/'+encodeURIComponent(x.id)+'/action',{action:'suspend_user',confirmed:true});}} className="rounded-lg border border-red-500/30 px-3 py-1.5 text-[10px] text-red-200 disabled:opacity-50">Приостановить аккаунт</button></div></div>)}
   </div>
  </div>
  <div className="mt-4 rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Журнал действий ({audit.length})</h4>
   {!audit.length?<p className="mt-2 text-xs text-stone-500">Записей пока нет.</p>:<div className="mt-2 space-y-2">{audit.map(x=><div key={x.id} className="rounded-xl border border-white/5 p-2"><p className="text-xs text-stone-200">{x.action} · {x.targetType}</p><p className="mt-1 break-all text-[10px] text-stone-500">{x.targetId} · {new Date(x.createdAt).toLocaleString()}</p>{x.reason&&<p className="mt-1 text-[10px] text-stone-400">{x.reason}</p>}</div>)}</div>}
  </div>
 </section>;
};
