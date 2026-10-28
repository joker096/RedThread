import type { UserProfile, CompatibilityBreakdown, CrucialAnswers } from '../types/index.ts';

/**
 * Calculates deep compatibility score and friction/green flag analysis between two profiles.
 */
export function calculateCompatibility(
  myAnswers: CrucialAnswers,
  myIntent: string,
  myInterests: string[],
  target: UserProfile
): CompatibilityBreakdown {
  let valuesScore = 70;
  let familyScore = 70;
  let lifestyleScore = 65;
  let temperamentScore = 70;
  let communicationScore = 75;

  const greenFlags: string[] = [];
  const frictionPoints: string[] = [];

  // 1. Intent match
  if (myIntent === target.intent) {
    familyScore += 20;
    valuesScore += 15;
    if (target.intent === 'marriage_family') {
      greenFlags.push('Общая цель: создание крепкой семьи и брак в ближайшее время');
    } else {
      greenFlags.push('Совпадение долгосрочных жизненных намерений');
    }
  } else if (
    (myIntent === 'marriage_family' && target.intent === 'not_sure') ||
    (myIntent === 'not_sure' && target.intent === 'marriage_family')
  ) {
    familyScore -= 30;
    frictionPoints.push('Разный темп: один готов к семье, другой пока не уверен');
  }

  // 2. Crucial answer: Marriage & Kids
  if (myAnswers.marriage_and_kids === target.crucialAnswers.marriage_and_kids) {
    familyScore += 15;
    greenFlags.push('Синхронность взглядов на детей и родительские роли');
  } else {
    frictionPoints.push('Возможные разногласия по срокам появления детей');
  }

  // 3. Finances
  if (myAnswers.finances === target.crucialAnswers.finances) {
    valuesScore += 15;
    greenFlags.push('Одинаковое понимание семейного бюджета и финансовой ответственности');
  } else {
    frictionPoints.push('Разные ожидания от распределения расходов и заработка в паре');
  }

  // 4. Free time & lifestyle
  if (myAnswers.free_time === target.crucialAnswers.free_time) {
    lifestyleScore += 20;
    greenFlags.push('Похожий формат отдыха и свободного времени');
  } else {
    frictionPoints.push('Разные предпочтения по отдыху и свободному времени');
  }

  // 5. Conflict resolution
  if (myAnswers.conflict_resolution === target.crucialAnswers.conflict_resolution) {
    communicationScore += 20;
    temperamentScore += 15;
    greenFlags.push('Зрелый стиль урегулирования конфликтов без манипуляций');
  } else {
    frictionPoints.push('Разные паттерны в стрессе: одному нужно обсудить сразу, другому остыть');
  }

  // 6. Common interests boost
  const commonInterests = myInterests.filter(i => target.interests.includes(i));
  if (commonInterests.length >= 2) {
    lifestyleScore += 10;
    greenFlags.push(`Общие увлечения: ${commonInterests.slice(0, 3).join(', ')}`);
  }

  // Clamp 0..100
  const clamp = (val: number) => Math.min(100, Math.max(0, Math.round(val)));
  
  const finalValues = clamp(valuesScore);
  const finalFamily = clamp(familyScore);
  const finalLifestyle = clamp(lifestyleScore);
  const finalTemperament = clamp(temperamentScore);
  const finalCommunication = clamp(communicationScore);

  const overall = Math.round(
    finalFamily * 0.35 +
    finalValues * 0.25 +
    finalCommunication * 0.15 +
    finalLifestyle * 0.15 +
    finalTemperament * 0.10
  );

  return {
    overallScore: Math.min(100, Math.max(0, overall)),
    valuesMatch: finalValues,
    familyGoalsMatch: finalFamily,
    lifestyleMatch: finalLifestyle,
    temperamentMatch: finalTemperament,
    communicationMatch: finalCommunication,
    greenFlags: greenFlags.slice(0, 4),
    frictionPoints: frictionPoints.slice(0, 3)
  };
}

/**
 * Evaluates bot / scam / rule-violator risk based on multiple automated heuristics
 */
export function detectBotRisk(profile: {
  bio: string;
  isVerified: boolean;
  livenessConfidence: number;
  reportCount: number;
  noBotScore: number;
}): {
  isSafe: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
  safetyScore: number;
} {
  const reasons: string[] = [];
  let penalty = 0;

  const suspiciousPatterns = [
    /(t\.me\/|telegram|телеграм|пиши в тг|тг:|вайбер|вотсап\s*\+)/i,
    /(крипт|биткоин|доход|пассивный заработок|инвестиц)/i,
    /(спонсор|содержанка|интим|коммерческ)/i,
    /(казино|ставки|1xbet|сигналы)/i
  ];

  const bioLower = profile.bio.toLowerCase();

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(bioLower)) {
      penalty += 35;
      reasons.push('Подозрительные ключевые слова (внешние контакты / заработок / реклама)');
      break;
    }
  }

  if (profile.reportCount > 0) {
    penalty += profile.reportCount * 20;
    reasons.push(`Жалобы от других пользователей: ${profile.reportCount}`);
  }

  if (!profile.isVerified) {
    penalty += 15;
    reasons.push('Не пройдена верификация селфи живого человека');
  }

  if (profile.livenessConfidence < 70) {
    penalty += 25;
    reasons.push('Низкая уверенность нейросети в подлинности фото (возможен дипфейк/чужое фото)');
  }

  const baseTrust = profile.noBotScore ?? 90;
  const computedSafety = Math.max(10, Math.min(100, Math.round(baseTrust - penalty)));

  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  if (computedSafety < 50) {
    riskLevel = 'high';
  } else if (computedSafety < 75) {
    riskLevel = 'medium';
  }

  return {
    isSafe: riskLevel === 'low',
    riskLevel,
    reasons: reasons.length > 0 ? reasons : ['В тексте анкеты не найдено явных спам-маркеров', 'Нет зарегистрированных жалоб', 'Автоматическая оценка не подтверждает личность и не заменяет модерацию'],
    safetyScore: computedSafety
  };
}

/**
 * Calculates remaining hours before chat should transition to real life meeting
 */
export function checkAntiChitChatDeadline(
  createdAtIso: string,
  messageCount: number
): {
  hoursLeft: number;
  status: 'fresh' | 'approaching_deadline' | 'stalled_texting';
  recommendation: string;
} {
  const createdDate = new Date(createdAtIso);
  const now = new Date();
  const diffHours = Math.max(0, (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60));
  const maxAllowedHours = 72;
  const hoursLeft = Math.max(0, Math.round(maxAllowedHours - diffHours));

  if (hoursLeft <= 12 || messageCount >= 20) {
    return {
      hoursLeft,
      status: 'stalled_texting',
      recommendation: 'Внимание: переписка затянулась! Пора назначить кофе или видеозвонок.'
    };
  }

  if (hoursLeft <= 36 || messageCount >= 10) {
    return {
      hoursLeft,
      status: 'approaching_deadline',
      recommendation: 'Идеальный момент пригласить на свидание: симпатия подтверждена.'
    };
  }

  return {
    hoursLeft,
    status: 'fresh',
    recommendation: 'Начало диалога. Узнайте 1-2 важные детали и переходите к живому звонку.'
  };
}

/**
 * Determines whether user should see banner or video ads
 */
export function shouldShowAds(isLadyPremium: boolean, isMale: boolean): {
  showBanners: boolean;
  canWatchRewardedForBoost: boolean;
  freeExplanation: string;
} {
  // The male tier is always free and is never changed by the female Premium flag.
  if (isMale) {
    return {
      showBanners: true,
      canWatchRewardedForBoost: true,
      freeExplanation: 'Мужчинам сервис бесплатен. Поддерживается ненавязчивыми спонсорами.'
    };
  }

  if (isLadyPremium) {
    return {
      showBanners: false,
      canWatchRewardedForBoost: false,
      freeExplanation: 'Lady VIP активен: реклама полностью отключена, приоритетный показ'
    };
  }

  return {
    showBanners: true,
    canWatchRewardedForBoost: true,
    freeExplanation: 'Базовый тариф. Перейдите на Lady Premium, чтобы убрать рекламу и получить VIP-радар.'
  };
}

/**
 * Strict binary filter: Female users see ONLY male candidates; Male users see ONLY female candidates.
 * Sponsor cards remain visible for both.
 */
export function filterBinaryCandidates(
  profiles: UserProfile[],
  currentUserGender: 'female' | 'male'
): UserProfile[] {
  const targetGender = currentUserGender === 'female' ? 'male' : 'female';
  return profiles.filter(p => p.isSponsorAd || p.gender === targetGender);
}


/**
 * Keeps sponsored placements out of the dating discovery pool until a
 * separately approved, policy-compliant contextual ad surface is implemented.
 */
export function excludeSponsoredDiscoveryProfiles<T extends { isSponsorAd?: boolean }>(profiles: T[]): T[] {
  return profiles.filter(profile => profile.isSponsorAd !== true);
}
