import React, { useEffect, useRef, useState } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  AlertTriangle, 
  UserCheck, 
  ScanFace, 
  FileCheck2, 
  X, 
  CheckCircle2, 
  Flame, 
  Activity,
  Lock,
  Flag
} from 'lucide-react';
import type { UserProfile } from '../types/index.ts';
import { detectBotRisk } from '../utils/compatibility.ts';

interface BotSafetyScannerProps {
  targetProfile: UserProfile | null;
  isOpen: boolean;
  onClose: () => void;
  onReportProfile: (profileId: string, reason: string) => void;
}

export const BotSafetyScanner: React.FC<BotSafetyScannerProps> = ({
  targetProfile,
  isOpen,
  onClose,
  onReportProfile
}) => {
  const [isScanning, setIsScanning] = useState(false);
  const [reportReason, setReportReason] = useState<string>('');
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const [scanStep, setScanStep] = useState(3);
  const timeoutIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    timeoutIdsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
    timeoutIdsRef.current = [];
    setIsScanning(false);
    setScanStep(3);
    setReportSubmitted(false);

    return () => {
      timeoutIdsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
      timeoutIdsRef.current = [];
    };
  }, [isOpen, targetProfile]);

  if (!isOpen || !targetProfile) return null;

  const riskReport = detectBotRisk({
    bio: targetProfile.bio,
    isVerified: targetProfile.verification.isVerified,
    livenessConfidence: targetProfile.verification.livenessConfidence,
    reportCount: targetProfile.verification.reportCount,
    noBotScore: targetProfile.verification.noBotScore
  });

  const handleRunFreshScan = () => {
    setIsScanning(true);
    setScanStep(1);
    timeoutIdsRef.current.push(setTimeout(() => setScanStep(2), 700));
    timeoutIdsRef.current.push(setTimeout(() => {
      setScanStep(3);
      setIsScanning(false);
      timeoutIdsRef.current = [];
    }, 1400));
  };

  const handleSendReport = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportReason) return;
    onReportProfile(targetProfile.id, reportReason);
    setReportSubmitted(true);
    timeoutIdsRef.current.push(setTimeout(() => {
      setReportSubmitted(false);
      onClose();
      timeoutIdsRef.current = [];
    }, 1500));
  };

  return (
    <div className="vow-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-stone-950/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div role="dialog" aria-modal="true" aria-labelledby="bot-safety-title" aria-describedby="bot-safety-description" className="relative w-full max-w-lg rounded-3xl bg-stone-900 border border-emerald-950/50 shadow-2xl p-5 sm:p-6 text-left my-auto">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-full bg-stone-800 text-stone-400 hover:text-white transition-colors"
          aria-label="Закрыть"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-5 pr-8">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-lg shadow-emerald-950/40">
            <ScanFace className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id="bot-safety-title" className="text-xl font-heading font-black text-white">Нейро-сканер безопасности</h2>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                riskReport.isSafe
                  ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30'
                  : 'bg-rose-950/80 text-rose-300 border border-rose-500/30'
              }`}>
                {riskReport.isSafe ? 'Низкий риск (демо)' : 'Есть признаки риска'}
              </span>
            </div>
            <p id="bot-safety-description" className="text-xs text-stone-400">
              Демо-оценка текста анкеты {targetProfile.name}; биометрическая проверка не подключена
            </p>
          </div>
        </div>

        {/* Scanner Radar Status Box */}
        <div aria-busy={isScanning} className="p-4 rounded-2xl bg-stone-950 border border-white/5 mb-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                {isScanning ? 'Проверяем текстовые признаки...' : 'Эвристическая оценка риска (демо)'}
              </span>
            </div>
            <span className={`text-base font-heading font-black ${
              riskReport.safetyScore >= 80 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {riskReport.safetyScore} / 100
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-2 rounded-full bg-stone-800 overflow-hidden mb-3">
            <div
              className={`h-full rounded-full transition-all duration-700 ${
                riskReport.safetyScore >= 80 ? 'bg-emerald-500' : 'bg-rose-600'
              }`}
              style={{ width: `${riskReport.safetyScore}%` }}
            ></div>
          </div>

          <p className="text-[11px] text-stone-300 leading-relaxed">
            {riskReport.isSafe
              ? 'Оценка учитывает текст анкеты и тестовые поля. Она не подтверждает личность и не гарантирует отсутствие мошенничества.'
              : 'Обнаружены текстовые признаки риска. Это предварительный сигнал, а не окончательный вывод о пользователе.'}
          </p>
        </div>

        {/* 4 Pillars of Automated Verification */}
        <div className="space-y-2.5 mb-5 text-xs">
          {/* 1. Liveness check */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ScanFace className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Проверка личности (не подключена)</span>
                <p className="text-[10px] text-stone-400">Реальная проверка селфи и документов ещё не реализована</p>
              </div>
            </div>
            <span className="text-xs font-bold text-emerald-400 font-mono">
              Не подключено
            </span>
          </div>

          {/* 2. Neural Anti-Spam */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Фильтр спама и внешних ссылок</span>
                <p className="text-[10px] text-stone-400">Проверка текста на сторонние Telegram-боты и крипту</p>
              </div>
            </div>
            <span className={`text-xs font-bold font-mono ${
              riskReport.isSafe ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {riskReport.isSafe ? 'Чисто' : 'Подозрение'}
            </span>
          </div>

          {/* 3. Real Behavioral Patterns */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <UserCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Поведенческие сигналы (не подключены)</span>
                <p className="text-[10px] text-stone-400">Серверная телеметрия действий пока не подключена</p>
              </div>
            </div>
            <span className="text-xs font-bold text-emerald-400 font-mono">
              Нет данных
            </span>
          </div>

          {/* 4. Rule Violations History */}
          <div className="p-2.5 rounded-xl bg-stone-950/60 border border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <FileCheck2 className="w-4 h-4 text-emerald-400" />
              <div>
                <span className="text-white font-medium">Жалобы сообщества</span>
                <p className="text-[10px] text-stone-400">История нарушений правил честных знакомств</p>
              </div>
            </div>
            <span className={`text-xs font-bold font-mono ${
              targetProfile.verification.reportCount === 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {targetProfile.verification.reportCount} жалоб
            </span>
          </div>
        </div>

        {/* Report form for safety */}
        <div className="p-3.5 rounded-2xl bg-rose-950/20 border border-rose-900/30 mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-rose-300 flex items-center gap-1.5">
              <Flag className="w-3.5 h-3.5 text-rose-500" />
              <span>Пожаловаться на профиль модерации</span>
            </span>
          </div>

          {reportSubmitted ? (
            <div className="p-2.5 rounded-xl bg-emerald-950/80 border border-emerald-500/30 text-emerald-300 text-xs text-center font-bold">
              ✓ Жалоба отмечена в демо-интерфейсе. Серверная модерация не подключена.
            </div>
          ) : (
            <form onSubmit={handleSendReport} className="flex gap-2">
              <select
                value={reportReason}
                onChange={e => setReportReason(e.target.value)}
                className="flex-1 bg-stone-900 border border-white/10 rounded-xl p-2 text-xs text-stone-200"
              >
                <option value="">Выберите причину жалобы...</option>
                <option value="bot_fake">Подозрение на бота или фейк фото</option>
                <option value="crypto_spam">Реклама криптовалюты или внешних тг-каналов</option>
                <option value="commercial">Коммерческие услуги / содержанка</option>
                <option value="disrespect">Неуважительное общение / обман</option>
              </select>
              <button
                type="submit"
                disabled={!reportReason}
                className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white font-bold text-xs transition-colors"
              >
                Отправить
              </button>
            </form>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRunFreshScan}
            disabled={isScanning}
            className="flex-1 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold text-xs transition-colors flex items-center justify-center gap-1.5"
          >
            <ScanFace className="w-4 h-4 text-emerald-400" />
            <span>{isScanning ? 'Сканирование...' : 'Повторить экспресс-скан'}</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs transition-colors"
          >
            Понятно, закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
