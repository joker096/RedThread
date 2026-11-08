import React, { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/LocaleProvider.tsx';
type Screening={id:string;userId:string;scope:string;flags:string[];severity:string;reviewStatus:string;createdAt:string};
type Report={id:string;reporterId:string;reportedUserId:string;reportedDisplayName:string;category:string;details:string;status:string;createdAt:string};
type AuditEntry={id:string;moderatorId:string|null;action:string;targetType:string;targetId:string;reason:string|null;details:unknown;createdAt:string};
type PendingPhoto={id:string;userId:string;displayName:string;mimeType:string;width:number;height:number;createdAt:string};
type PendingL3={submissionId:string;applicantReference:string;uploadedAt:string;mimeType:'video/mp4'|'video/webm';sizeBytes:number;durationSeconds:number;processingAttempts:number};
type PartnerApplication={id:string;category:string;businessName:string;contactName:string;contactEmail:string;country:string;city:string;website:string;serviceDescription:string;priceFrom:number|string|null;priceCurrency:string;serviceLanguages:string[];availabilityNote:string;status:string;reviewNote:string;publishedAt:string|null};
type PartnerInquiry={id:string;businessName:string;providerEmail:string;deliveryStatus:string;deliveryAttempts:number;deliveryError:string;providerMessageId:string|null;contactConsentVersion:string|null;createdAt:string;updatedAt:string;deliveredAt:string|null};

export const ModeratorConsolePanel:React.FC=()=>{
 const {locale}=useLocale();const tr=(ru:string,en:string)=>locale==='ru'?ru:en;
 const [allowed,setAllowed]=useState(false),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [screenings,setScreenings]=useState<Screening[]>([]),[reports,setReports]=useState<Report[]>([]),[audit,setAudit]=useState<AuditEntry[]>([]),[photos,setPhotos]=useState<PendingPhoto[]>([]),[l3Submissions,setL3Submissions]=useState<PendingL3[]>([]),[l3Enabled,setL3Enabled]=useState(false),[partnerApplications,setPartnerApplications]=useState<PartnerApplication[]>([]),[partnerInquiries,setPartnerInquiries]=useState<PartnerInquiry[]>([]);
 const [partnerInquiryNotes,setPartnerInquiryNotes]=useState<Record<string,string>>({});
 const [partnerInquiryProviderIds,setPartnerInquiryProviderIds]=useState<Record<string,string>>({});
 const [partnerInquiryWorkerStopped,setPartnerInquiryWorkerStopped]=useState<Record<string,boolean>>({});
 const [partnerApplicationNotes,setPartnerApplicationNotes]=useState<Record<string,string>>({});
 const refreshRequestId=React.useRef(0);
 const sessionEpoch=React.useRef(0);
 const refresh=useCallback(async()=>{
  const requestId=++refreshRequestId.current;
  const actionEpoch=sessionEpoch.current;
  setBusy(true);
  try{
   const responses=await Promise.all([
    fetch('/api/admin/screenings',{credentials:'include'}),
    fetch('/api/admin/reports',{credentials:'include'}),
    fetch('/api/admin/audit-log?limit=30',{credentials:'include'}),
    fetch('/api/admin/photos',{credentials:'include'}),
    fetch('/api/moderation/identity-l3/submissions',{credentials:'include'}),
     fetch('/api/admin/partner-applications',{credentials:'include'}),
     fetch('/api/admin/partner-service-inquiries',{credentials:'include'})
   ]);
   if(requestId!==refreshRequestId.current||actionEpoch!==sessionEpoch.current)return;
   if(responses.some(r=>r.status===401||r.status===403)){setAllowed(false);setReady(true);return;}
   const data=await Promise.all(responses.map(async (r,index)=>{const d=await r.json().catch(()=>null);if(index===4&&r.status===503&&d?.error==='l3_feature_disabled')return {submissions:[],disabled:true};if(!r.ok)throw new Error('Не удалось загрузить данные модерации.');return d||{};}));
   if(requestId!==refreshRequestId.current||actionEpoch!==sessionEpoch.current)return;
   const safeArray=<T,>(value: unknown): T[] => Array.isArray(value) ? value : [];
   setScreenings(safeArray<Screening>(data[0]?.screenings));setReports(safeArray<Report>(data[1]?.reports));setAudit(safeArray<AuditEntry>(data[2]?.entries));setPhotos(safeArray<PendingPhoto>(data[3]?.photos));setL3Submissions(safeArray<PendingL3>(data[4]?.submissions));setL3Enabled(data[4]?.disabled!==true);setPartnerApplications(safeArray<PartnerApplication>(data[5]?.applications));setPartnerInquiries(safeArray<PartnerInquiry>(data[6]?.inquiries));setAllowed(true);setReady(true);setNotice('');
  }catch(e){if(requestId===refreshRequestId.current&&actionEpoch===sessionEpoch.current){setNotice(e instanceof Error?e.message:'Ошибка загрузки панели.');setReady(true);}}
  finally{if(requestId===refreshRequestId.current&&actionEpoch===sessionEpoch.current)setBusy(false);}
 },[]);
 useEffect(()=>{void refresh();const refreshOnFocus=()=>void refresh();const refreshOnSession=()=>{sessionEpoch.current+=1;refreshRequestId.current+=1;setAllowed(false);setReady(false);setNotice('');setBusy(false);void refresh();};window.addEventListener('focus',refreshOnFocus);window.addEventListener('vow:session-changed',refreshOnSession);return()=>{window.removeEventListener('focus',refreshOnFocus);window.removeEventListener('vow:session-changed',refreshOnSession);refreshRequestId.current+=1;sessionEpoch.current+=1;};},[refresh]);
 const act=async(url:string,payload?:Record<string,unknown>)=>{
  const actionEpoch=sessionEpoch.current;
  setBusy(true);setNotice('');
  try{
   const response=await fetch(url,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})});
   const data=await response.json().catch(()=>null);
   if(actionEpoch!==sessionEpoch.current)return;
   if(!response.ok)throw new Error(data?.error||'Действие не выполнено.');
   setNotice('Действие сохранено в журнале модерации.');await refresh();
  }catch(e){if(actionEpoch===sessionEpoch.current)setNotice(e instanceof Error?e.message:'Ошибка модерации.');}
  finally{if(actionEpoch===sessionEpoch.current)setBusy(false);}
 };
 if(!ready||!allowed)return null;
 return <section aria-busy={busy} className="vow-screen mb-5 rounded-3xl border border-violet-500/30 bg-stone-900/90 p-4 sm:p-5">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-violet-300">Только модераторы</p><h3 className="mt-1 text-lg font-bold text-white">Панель безопасности Vow</h3><p className="mt-1 text-xs text-stone-400">Очередь проверок, жалобы и журнал решений.</p></div><button type="button" onClick={()=>void refresh()} disabled={busy} className="min-h-11 rounded-xl border border-white/10 px-3 py-2 text-xs text-stone-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">Обновить</button></div>
  {notice&&<p role="status" aria-live="polite" aria-atomic="true" className="mt-3 rounded-xl bg-stone-950 p-3 text-xs text-stone-300">{notice}</p>}
  <div className="mt-4 rounded-2xl border border-violet-500/20 bg-stone-950/60 p-3">
   <div className="flex flex-wrap items-center justify-between gap-2">
    <h4 className="text-sm font-semibold text-white">Видео-проверки L3 ({l3Submissions.length})</h4>
    <span className="text-[10px] text-stone-500">{l3Enabled?'Live-модерация включена':'L3 отключена'}</span>
   </div>
   {!l3Enabled?<p className="mt-2 text-xs text-stone-500">Очередь L3 закрыта до включения полного защищённого процесса.</p>
    :!l3Submissions.length?<p className="mt-2 text-xs text-stone-500">Ожидающих видео-проверок нет.</p>
    :<div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">{l3Submissions.map(item=><article key={item.submissionId} className="min-w-0 rounded-xl border border-white/10 p-3">
      <p className="break-all text-[10px] text-stone-400">Заявка: {item.submissionId}</p>
      <p className="mt-1 break-all text-[10px] text-stone-500">Пользователь: {item.applicantReference}</p>
      <p className="mt-1 text-[10px] text-stone-400">{item.durationSeconds} сек. · {(item.sizeBytes/(1024*1024)).toFixed(1)} МБ · {item.mimeType} · попыток обработки: {item.processingAttempts}</p>
      <video controls playsInline preload="none"
       src={'/api/moderation/identity-l3/submissions/'+encodeURIComponent(item.submissionId)+'/media'}
       aria-label="Видео-заявление L3 на проверке"
       className="mt-3 max-h-72 w-full rounded-lg bg-black" />
      <div className="mt-3 flex flex-wrap gap-2">
       <button type="button" disabled={busy} onClick={()=>{if(window.confirm(tr('Одобрить L3 на шесть месяцев?', 'Approve L3 for six months?')))void act('/api/moderation/identity-l3/submissions/'+encodeURIComponent(item.submissionId)+'/decision',{decision:'approved',reasonCode:'video_matches_l2'});}}
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-800 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">{tr('Одобрить','Approve')} на 6 месяцев</button>
       <button type="button" disabled={busy} onClick={()=>{if(window.confirm(tr('Отклонить видео как не совпадающее с L2? Видео будет поставлено в очередь на удаление.', 'Reject this video because it does not match L2? The video will be queued for deletion.')))void act('/api/moderation/identity-l3/submissions/'+encodeURIComponent(item.submissionId)+'/decision',{decision:'rejected',reasonCode:'video_mismatch'});}}
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-red-500/30 px-3 py-2 text-[10px] text-red-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">{tr('Отклонить','Reject')}: несовпадение</button>
       <button type="button" disabled={busy} onClick={()=>{if(window.confirm(tr('Отклонить видео как неполное? Видео будет поставлено в очередь на удаление.', 'Reject this incomplete video? The video will be queued for deletion.')))void act('/api/moderation/identity-l3/submissions/'+encodeURIComponent(item.submissionId)+'/decision',{decision:'rejected',reasonCode:'statement_incomplete'});}}
        className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/10 px-3 py-2 text-[10px] text-stone-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">{tr('Отклонить','Reject')}: неполное видео</button>
      </div>
     </article>)}</div>}
   <p className="mt-3 text-[10px] text-stone-500">Просмотр видео журналируется. Одобренное видео хранится до истечения шести месяцев; отклонённое автоматически ставится в очередь на удаление.</p>
  </div>
  <div className="mt-4 rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Фотографии на проверке ({photos.length})</h4>
   {!photos.length?<p className="mt-2 text-xs text-stone-500">Ожидающих фотографий нет.</p>:<div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">{photos.map(photo=><div key={photo.id} className="min-w-0 rounded-xl border border-white/10 p-3"><img src={'/api/photos/'+encodeURIComponent(photo.id)} alt={'Фото анкеты '+photo.displayName} loading="lazy" referrerPolicy="no-referrer" className="mb-2 max-h-64 w-full rounded-lg object-contain bg-black" /><p className="text-xs text-stone-200">{photo.displayName}</p><p className="text-[10px] text-stone-500">{photo.width}×{photo.height} · {photo.mimeType}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void act('/api/admin/photos/'+encodeURIComponent(photo.id)+'/review',{decision:'approve'})} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-800 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">{tr('Одобрить','Approve')}</button><button type="button" disabled={busy} onClick={()=>void act('/api/admin/photos/'+encodeURIComponent(photo.id)+'/review',{decision:'reject'})} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-red-500/30 px-3 py-2 text-[10px] text-red-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">{tr('Отклонить','Reject')}</button></div></div>)}</div>}
  </div>
  <div className="mt-4 grid gap-4 lg:grid-cols-2">
   <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Проверки безопасности ({screenings.length})</h4>
    {!screenings.length?<p className="mt-2 text-xs text-stone-500">Ожидающих проверок нет.</p>:screenings.map(x=><div key={x.id} className="mt-2 rounded-xl border border-white/10 p-3"><p className="text-xs text-stone-200">{x.scope} · {x.severity}</p><p className="mt-1 break-words text-[10px] text-stone-400">{(x.flags||[]).join(', ')||'Без флагов'}</p><button type="button" disabled={busy} onClick={()=>void act('/api/admin/screenings/'+encodeURIComponent(x.id)+'/resolve')} className="mt-2 min-h-11 rounded-lg bg-emerald-800 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">Отметить проверенной</button></div>)}
   </div>
   <div className="rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Жалобы ({reports.length})</h4>
    {!reports.length?<p className="mt-2 text-xs text-stone-500">Открытых жалоб нет.</p>:reports.map(x=><div key={x.id} className="mt-2 rounded-xl border border-white/10 p-3"><p className="text-xs font-semibold text-stone-200">{x.category} · {x.reportedDisplayName}</p><p className="mt-1 whitespace-pre-wrap break-words text-[10px] text-stone-400">{x.details||'Описание не указано'}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void act('/api/admin/reports/'+encodeURIComponent(x.id)+'/action',{action:'resolve'})} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-800 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">Решена</button><button type="button" disabled={busy} onClick={()=>void act('/api/admin/reports/'+encodeURIComponent(x.id)+'/action',{action:'dismiss'})} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/10 px-3 py-2 text-[10px] text-stone-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">{tr('Отклонить','Reject')}</button><button type="button" disabled={busy} onClick={()=>{if(window.confirm('Подтверждаете приостановку аккаунта по этой жалобе?'))void act('/api/admin/reports/'+encodeURIComponent(x.id)+'/action',{action:'suspend_user',confirmed:true});}} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-red-500/30 px-3 py-2 text-[10px] text-red-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400">Приостановить аккаунт</button></div></div>)}
   </div>
  </div>

  <div className="mt-4 rounded-2xl border border-emerald-700/30 bg-stone-950/60 p-3">
   <h4 className="text-sm font-semibold text-white">{tr('Заявки партнёров','Partner applications')} ({partnerApplications.length})</h4>
   {!partnerApplications.length?<p className="mt-2 text-xs text-stone-500">{tr('Ожидающих и опубликованных заявок нет.','No pending or published applications.')}</p>:partnerApplications.map(item=><article key={item.id} className="mt-3 rounded-xl border border-white/10 p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-semibold text-white">{item.businessName}</p><p className="mt-1 text-[10px] text-stone-400">{item.category} · {item.city}, {item.country} · {item.status}{item.publishedAt?' · опубликовано':''}</p></div><span className="text-[10px] text-stone-500">{item.priceFrom!==null?'от '+item.priceFrom+' '+item.priceCurrency:'Цена не указана'}</span></div>
    <p className="mt-2 break-words text-xs text-stone-300">{item.serviceDescription}</p>
    <p className="mt-2 break-all text-[10px] text-stone-400">{item.contactName} · {item.contactEmail}{item.website?' · '+item.website:''}</p>
    {item.reviewNote&&<p className="mt-2 text-[10px] text-amber-200">{tr('Заметка:','Review note:')} {item.reviewNote}</p>}
    {(item.status==='pending'||item.status==='in_review')&&<label className="mt-3 block text-[10px] text-stone-300">{tr('Основание решения (для одобрения — проверка контакта и документов, не менее 20 символов)','Decision evidence (for approval, record contact and document checks; at least 20 characters)')}
     <textarea value={partnerApplicationNotes[item.id]||''} onChange={event=>setPartnerApplicationNotes(current=>({...current,[item.id]:event.target.value}))} maxLength={1000} rows={2} className="mt-1 w-full rounded-lg border border-white/10 bg-stone-900 p-2 text-xs text-white" />
    </label>}
    <div className="mt-3 flex flex-wrap gap-2">
     {item.status==='pending'&&<button type="button" disabled={busy} onClick={()=>void act('/api/admin/partner-applications/'+encodeURIComponent(item.id)+'/review',{decision:'in_review'})} className="min-h-11 rounded-lg border border-white/10 px-3 py-2 text-[10px] text-stone-200 disabled:opacity-50">{tr('Взять в работу','Start review')}</button>}
     {(item.status==='pending'||item.status==='in_review')&&<button type="button" onClick={()=>void act('/api/admin/partner-applications/'+encodeURIComponent(item.id)+'/review',{decision:'approved',reviewNote:partnerApplicationNotes[item.id]||''})} disabled={busy||(partnerApplicationNotes[item.id]||'').trim().length<20} className="min-h-11 rounded-lg bg-emerald-800 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50">{tr('Одобрить','Approve')}</button>}
     {(item.status==='pending'||item.status==='in_review')&&<button type="button" onClick={()=>void act('/api/admin/partner-applications/'+encodeURIComponent(item.id)+'/review',{decision:'rejected',reviewNote:partnerApplicationNotes[item.id]||''})} disabled={busy||(partnerApplicationNotes[item.id]||'').trim().length<20} className="min-h-11 rounded-lg border border-red-500/30 px-3 py-2 text-[10px] text-red-200 disabled:opacity-50">{tr('Отклонить','Reject')}</button>}
     {item.status==='approved'&&!item.publishedAt&&<button type="button" disabled={busy} onClick={()=>void act('/api/admin/partner-applications/'+encodeURIComponent(item.id)+'/publish')} className="min-h-11 rounded-lg bg-emerald-700 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50">{tr('Опубликовать','Publish')}</button>}
     {item.status==='approved'&&item.publishedAt&&<button type="button" disabled={busy} onClick={()=>void act('/api/admin/partner-applications/'+encodeURIComponent(item.id)+'/unpublish')} className="min-h-11 rounded-lg border border-amber-500/30 px-3 py-2 text-[10px] text-amber-200 disabled:opacity-50">{tr('Снять с публикации','Unpublish')}</button>}
    </div>
   </article>)}
  </div>

  <div className="mt-4 rounded-2xl border border-amber-700/30 bg-stone-950/60 p-3">
   <h4 className="text-sm font-semibold text-white">{tr('Доставка запросов партнёрам','Partner inquiry delivery')} ({partnerInquiries.length})</h4>
   {!partnerInquiries.length?<p className="mt-2 text-xs text-stone-500">{tr('Запросов пока нет.','No partner inquiries yet.')}</p>:partnerInquiries.map(item=><article key={item.id} className="mt-3 rounded-xl border border-white/10 p-3">
    <p className="break-all font-mono text-[10px] text-stone-300">{item.id}</p>
    <p className="mt-1 text-xs font-semibold text-white">{item.businessName}</p>
    <p className="mt-1 break-all text-[10px] text-stone-400">{tr('Адрес поставщика','Provider recipient')}: {item.providerEmail}</p>
    <p className="mt-1 text-[10px] text-stone-400">{tr('Статус','Status')}: {item.deliveryStatus==='cancelled'?tr('Отменён пользователем','Cancelled by requester'):item.deliveryStatus} · {tr('попыток','attempts')}: {item.deliveryAttempts}</p>
    {item.deliveryError&&<p className="mt-1 text-[10px] text-amber-200">{item.deliveryError}</p>}
    {item.providerMessageId&&<><p className="mt-1 break-all font-mono text-[10px] text-emerald-200">{tr('ID письма Resend','Resend message ID')}: {item.providerMessageId}</p><p className="mt-1 text-[10px] text-emerald-200">{tr('Resend вернул ID принятого письма: нельзя отметить его как не принятое.','Resend returned an accepted message ID; this cannot be marked as not accepted.')}</p></>}
    {item.contactConsentVersion&&<p className="mt-1 text-[10px] text-stone-500">{tr('Версия согласия','Consent version')}: {item.contactConsentVersion}</p>}
    <p className="mt-1 text-[10px] text-stone-500">{tr('Обновлено','Updated')}: {new Date(item.updatedAt).toLocaleString(locale)}</p>
    {item.deliveryStatus==='sending'&&<div className="mt-2 space-y-2 rounded-lg border border-amber-500/20 p-3">
     <p className="text-xs text-amber-200">{tr('Возраст записи не доказывает завершение отправки. Восстанавливайте её только после остановки всех экземпляров API/worker и проверки журнала Resend. Если вызов ещё активен, операция восстановления дождётся его блокировки и не изменит запись.','Record age does not prove the send has finished. Recover only after all API/worker instances are stopped and Resend logs are checked. If a call is still active, recovery waits for its row lock and will not change the record.')}</p>
     <label className="flex items-start gap-2 text-xs text-stone-300">
      <input type="checkbox" checked={Boolean(partnerInquiryWorkerStopped[item.id])} onChange={event=>setPartnerInquiryWorkerStopped(current=>({...current,[item.id]:event.target.checked}))} />
      <span>{tr('Подтверждаю, что все отправители остановлены и активного сетевого вызова больше нет','I confirm all senders are stopped and no network call is still active')}</span>
     </label>
     <label className="block text-xs text-stone-300">{tr('Доказательства остановки worker и проверки журнала провайдера (20–500 символов)','Evidence of worker shutdown and provider-log check (20–500 characters)')}
      <textarea value={partnerInquiryNotes[item.id]||''} onChange={event=>setPartnerInquiryNotes(current=>({...current,[item.id]:event.target.value}))} maxLength={500} minLength={20} rows={2} className="mt-1 w-full rounded-lg border border-white/10 bg-stone-900 p-2 text-xs text-white" />
     </label>
     <button type="button" disabled={busy||!partnerInquiryWorkerStopped[item.id]||(partnerInquiryNotes[item.id]||'').trim().length<20} onClick={()=>{if(window.confirm(tr('Подтвердить остановку всех отправителей и перевести запись на сверку? Активный provider call защищён блокировкой строки.','Confirm all senders are stopped and move this record to reconciliation? An active provider call is protected by a row lock.')))void act('/api/admin/partner-service-inquiries/'+encodeURIComponent(item.id)+'/recover',{workerTerminated:true,operatorNote:partnerInquiryNotes[item.id].trim()});}} className="min-h-11 rounded-lg border border-amber-500/30 px-3 py-2 text-[10px] text-amber-100 disabled:opacity-50">{tr('Восстановить после остановки worker','Recover after worker shutdown')}</button>
    </div>}
    {item.deliveryStatus==='reconciliation_required'&&<div className="mt-2 space-y-2">
     <label className="block text-xs text-stone-300">{tr('Основание сверки (запись провайдера и время проверки)','Reconciliation evidence (provider log entry and check time)')}
      <textarea value={partnerInquiryNotes[item.id]||''} onChange={event=>setPartnerInquiryNotes(current=>({...current,[item.id]:event.target.value}))} maxLength={500} minLength={10} rows={2} className="mt-1 w-full rounded-lg border border-white/10 bg-stone-900 p-2 text-xs text-white" />
     </label>
     <label className="block text-xs text-stone-300">{tr('ID письма провайдера (обязательно для подтверждения принятия)','Provider message ID (required to confirm acceptance)')}
      <input type="text" maxLength={255} value={partnerInquiryProviderIds[item.id]??item.providerMessageId??''} onChange={event=>setPartnerInquiryProviderIds(current=>({...current,[item.id]:event.target.value}))} className="mt-1 w-full rounded-lg border border-white/10 bg-stone-900 p-2 text-xs text-white" />
     </label>
     <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy||(partnerInquiryNotes[item.id]||'').trim().length<10||!(partnerInquiryProviderIds[item.id]??item.providerMessageId??'').trim()} onClick={()=>{if(window.confirm(tr('Сверка подтверждает принятие письма провайдером? Это не подтверждает доставку в почтовый ящик.','Do provider logs confirm acceptance? This does not confirm mailbox delivery.')))void act('/api/admin/partner-service-inquiries/'+encodeURIComponent(item.id)+'/reconcile',{decision:'sent',operatorNote:partnerInquiryNotes[item.id].trim(),providerMessageId:(partnerInquiryProviderIds[item.id]??item.providerMessageId??'').trim()});}} className="min-h-11 rounded-lg bg-emerald-800 px-3 py-2 text-[10px] font-semibold text-white disabled:opacity-50">{tr('Провайдер принял письмо','Provider accepted email')}</button>
      <button type="button" disabled={busy||Boolean(item.providerMessageId)||(partnerInquiryProviderIds[item.id]||'').trim().length>0||(partnerInquiryNotes[item.id]||'').trim().length<10} onClick={()=>{if(window.confirm(tr('Проверка подтверждает, что провайдер не принимал письмо?','Do logs confirm the provider did not accept the email?')))void act('/api/admin/partner-service-inquiries/'+encodeURIComponent(item.id)+'/reconcile',{decision:'failed',operatorNote:partnerInquiryNotes[item.id].trim()});}} className="min-h-11 rounded-lg border border-amber-500/30 px-3 py-2 text-[10px] text-amber-200 disabled:opacity-50">{tr('Провайдер не принимал письмо','Provider did not accept email')}</button>
     </div>
    </div>}
   </article>)}
  </div>
  <div className="mt-4 rounded-2xl border border-white/10 bg-stone-950/60 p-3"><h4 className="text-sm font-semibold text-white">Журнал действий ({audit.length})</h4>
   {!audit.length?<p className="mt-2 text-xs text-stone-500">Записей пока нет.</p>:<div className="mt-2 space-y-2">{audit.map(x=><div key={x.id} className="rounded-xl border border-white/5 p-2"><p className="text-xs text-stone-200">{x.action} · {x.targetType}</p><p className="mt-1 break-all text-[10px] text-stone-500">{x.targetId} · {new Date(x.createdAt).toLocaleString()}</p>{x.reason&&<p className="mt-1 text-[10px] text-stone-400">{x.reason}</p>}</div>)}</div>}
  </div>
 </section>;
};
