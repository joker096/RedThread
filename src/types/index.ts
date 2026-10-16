export type Gender = 'female' | 'male';

export type RelationshipGoal = 
  | 'marriage_family' 
  | 'serious_relationship' 
  | 'cohabitation' 
  | 'not_sure';

export interface CrucialAnswers {
  marriage_and_kids: string; // "Хочу семью и детей в ближайшие 1-2 года"
  finances: string;          // "Мужчина основной добытчик" / "Партнерский общий бюджет"
  free_time: string;         // "Путешествия и активный отдых" / "Уютный дом и спокойствие"
  conflict_resolution: string;// "Спокойно говорим через рот сразу" / "Нужно время остыть"
}

export interface VerificationData {
  isVerified: boolean;
  livenessConfidence: number; // e.g. 99.2%
  verifiedAt: string;
  idCheckPassed: boolean;
  noBotScore: number;         // e.g. 98.7%
  botRiskLevel: 'low' | 'medium' | 'high';
  reportCount: number;
}

export interface CompatibilityBreakdown {
  overallScore: number; // 0 - 100
  valuesMatch: number;  // 0 - 100
  familyGoalsMatch: number;
  lifestyleMatch: number;
  temperamentMatch: number;
  communicationMatch: number;
  greenFlags: string[];
  frictionPoints: string[];
  zodiacHarmony?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  age: number;
  city: string;
  country?: string;
  gender: Gender;
  occupation: string;
  height: number;
  photos: string[];
  avatar: string;
  bio: string;
  voiceIntroSeconds?: number;
  intent: RelationshipGoal;
  crucialAnswers: CrucialAnswers;
  verification: VerificationData;
  interests: string[];
  mbti?: string;
  attachmentStyle?: string;
  loveLanguage?: string;
  psychCards?: Array<{ question: string; answer: string; matchBonus: number }>;
  onlineStatus: 'online' | 'recently' | 'offline';
  superLikedByMe?: boolean;
  likedByMe?: boolean;
  likedByCandidate?: boolean;
  isSponsorAd?: boolean;
  sponsorTitle?: string;
  sponsorDescription?: string;
  sponsorCta?: string;
  sponsorUrl?: string;
}

export interface Message {
  id: string;
  senderId: string;
  text: string;
  timestamp: string;
  isAudio?: boolean;
  audioDuration?: number;
  isDateInvite?: boolean;
  dateInviteDetails?: {
    place: string;
    day: string;
    time: string;
    status: 'pending' | 'accepted' | 'declined';
  };
}

export interface ChatThread {
  id: string;
  partnerProfile: UserProfile;
  compatibilityScore: number;
  createdAt: string; // timestamp
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  meetingDeadlineHoursLeft: number; // Anti-chit-chat 72h countdown
  messages: Message[];
}

export type DeviceFrame = 'responsive' | 'iphone' | 'android';

export interface AdStats {
  impressions: number;
  clicks: number;
  rewardedWatched: number;
  estimatedRevenueRub: number;
  averageEcpmRub: number;
}
