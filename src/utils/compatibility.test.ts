import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCompatibility,
  detectBotRisk,
  checkAntiChitChatDeadline,
  shouldShowAds,
  filterBinaryCandidates
} from './compatibility.ts';
import type { UserProfile, CrucialAnswers } from '../types/index.ts';

const mockAnswers: CrucialAnswers = {
  marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
  finances: 'Мужчина основной добытчик',
  free_time: 'Путешествия и активный отдых',
  conflict_resolution: 'Спокойно говорим через рот сразу'
};

const mockTargetProfile: UserProfile = {
  id: 'user_alex',
  name: 'Алексей',
  age: 31,
  city: 'Москва',
  gender: 'male',
  occupation: 'Архитектор',
  height: 184,
  photos: ['/photo1.jpg'],
  avatar: '/avatar1.jpg',
  bio: 'Ищу спутницу жизни для создания крепкой традиционной семьи.',
  intent: 'marriage_family',
  crucialAnswers: {
    marriage_and_kids: 'Хочу семью и детей в ближайшие 1-2 года',
    finances: 'Мужчина основной добытчик',
    free_time: 'Путешествия и активный отдых',
    conflict_resolution: 'Спокойно говорим через рот сразу'
  },
  verification: {
    isVerified: true,
    livenessConfidence: 99.4,
    verifiedAt: '2026-10-10',
    idCheckPassed: true,
    noBotScore: 99.1,
    botRiskLevel: 'low',
    reportCount: 0
  },
  interests: ['Архитектура', 'Спорт', 'Путешествия'],
  onlineStatus: 'online'
};

test('calculateCompatibility returns high score for identical family and values intent', () => {
  const result = calculateCompatibility(
    mockAnswers,
    'marriage_family',
    ['Спорт', 'Путешествия'],
    mockTargetProfile
  );

  assert.ok(result.overallScore >= 85, `Expected score >= 85, got ${result.overallScore}`);
  assert.ok(result.greenFlags.length > 0, 'Should have green flags for compatible goals');
  assert.equal(result.familyGoalsMatch >= 85, true);
});

test('calculateCompatibility catches intent mismatch and adds friction points', () => {
  const mismatchedProfile: UserProfile = {
    ...mockTargetProfile,
    intent: 'not_sure',
    crucialAnswers: {
      ...mockTargetProfile.crucialAnswers,
      marriage_and_kids: 'Пока не планирую детей'
    }
  };

  const result = calculateCompatibility(
    mockAnswers,
    'marriage_family',
    [],
    mismatchedProfile
  );

  assert.ok(result.overallScore < 75, `Expected lower score, got ${result.overallScore}`);
  assert.ok(result.frictionPoints.length > 0, 'Should report friction points on kids/intent mismatch');
});

test('detectBotRisk identifies suspicious spam links and low confidence profiles', () => {
  const botProfile = {
    bio: 'Привет красотка, пиши в тг t.me/crypto_investor легкий пассивный заработок!',
    isVerified: false,
    livenessConfidence: 45,
    reportCount: 3,
    noBotScore: 40
  };

  const report = detectBotRisk(botProfile);
  assert.equal(report.isSafe, false);
  assert.equal(report.riskLevel, 'high');
  assert.ok(report.safetyScore < 50);
});

test('detectBotRisk approves verified authentic profile', () => {
  const genuineProfile = {
    bio: 'Люблю горные походы, архитектуру и искренних людей. Без вредных привычек.',
    isVerified: true,
    livenessConfidence: 98,
    reportCount: 0,
    noBotScore: 99
  };

  const report = detectBotRisk(genuineProfile);
  assert.equal(report.isSafe, true);
  assert.equal(report.riskLevel, 'low');
  assert.ok(report.safetyScore >= 85);
});

test('checkAntiChitChatDeadline warns when messages accumulate without meeting', () => {
  const recentIso = new Date().toISOString();
  const warning = checkAntiChitChatDeadline(recentIso, 25);
  assert.equal(warning.status, 'stalled_texting');
  assert.ok(warning.recommendation.includes('переписка затянулась'));
});

test('shouldShowAds respects Lady Premium status', () => {
  const ladyVip = shouldShowAds(true, false);
  assert.equal(ladyVip.showBanners, false);
  assert.equal(ladyVip.canWatchRewardedForBoost, false);

  const maleUser = shouldShowAds(false, true);
  assert.equal(maleUser.showBanners, true);
  assert.ok(maleUser.freeExplanation.includes('Мужчинам сервис бесплатен'));

  const maleWithStalePremiumFlag = shouldShowAds(true, true);
  assert.equal(maleWithStalePremiumFlag.showBanners, true);
  assert.equal(maleWithStalePremiumFlag.canWatchRewardedForBoost, true);
});

test('filterBinaryCandidates strictly ensures women see men and men see women', () => {
  const sampleProfiles: UserProfile[] = [
    { ...mockTargetProfile, id: 'man_1', gender: 'male' },
    { ...mockTargetProfile, id: 'man_2', gender: 'male' },
    { ...mockTargetProfile, id: 'woman_1', gender: 'female' },
    { ...mockTargetProfile, id: 'ad_1', isSponsorAd: true, gender: 'male' }
  ];

  const forFemaleUser = filterBinaryCandidates(sampleProfiles, 'female');
  assert.equal(forFemaleUser.some(p => p.id === 'woman_1'), false, 'Female user must NOT see female candidates');
  assert.equal(forFemaleUser.some(p => p.id === 'man_1'), true, 'Female user must see male candidates');
  assert.equal(forFemaleUser.some(p => p.isSponsorAd), true, 'Sponsor ad should be visible');

  const forMaleUser = filterBinaryCandidates(sampleProfiles, 'male');
  assert.equal(forMaleUser.some(p => p.id === 'man_1'), false, 'Male user must NOT see male candidates');
  assert.equal(forMaleUser.some(p => p.id === 'woman_1'), true, 'Male user must see female candidates');
});



test('lifestyle mismatch is not rewarded and is explained as a friction point', () => {
  const matched = calculateCompatibility(
    mockAnswers,
    'marriage_family',
    ['Спорт', 'Путешествия'],
    mockTargetProfile
  );
  const mismatchedProfile: UserProfile = {
    ...mockTargetProfile,
    crucialAnswers: {
      ...mockTargetProfile.crucialAnswers,
      free_time: 'Уютный дом и спокойствие'
    }
  };
  const mismatched = calculateCompatibility(
    mockAnswers,
    'marriage_family',
    ['Спорт', 'Путешествия'],
    mismatchedProfile
  );

  assert.ok(matched.lifestyleMatch > mismatched.lifestyleMatch);
  assert.ok(mismatched.frictionPoints.some(point => point.includes('предпочтения по отдыху')));
  assert.ok(mismatched.overallScore >= 0 && mismatched.overallScore <= 100);
});


test('detectBotRisk preserves an explicit zero trust score', () => {
  const lowTrustProfile = {
    bio: 'Люблю прогулки, книги и уютные вечера.',
    isVerified: true,
    livenessConfidence: 98,
    reportCount: 0,
    noBotScore: 0
  };

  const report = detectBotRisk(lowTrustProfile);
  assert.equal(report.safetyScore, 10);
  assert.equal(report.riskLevel, 'high');
});
