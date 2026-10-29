export type UserRole = 'user' | 'admin';

export interface UserProfile {
  id: string;
  phoneNumber: string;
  displayName: string;
  avatarUrl?: string;
  role: UserRole;
  createdAt: string;
}

export interface Wallet {
  id: string;
  userId: string;
  balance: number; // in NGN (Naira)
  currency: 'NGN';
  updatedAt: string;
}

export type TransactionType = 'credit' | 'debit';
export type TransactionStatus = 'success' | 'pending' | 'failed';
export type PaymentChannel = 'paystack' | 'session' | 'match_opportunity' | 'admin';

export interface Transaction {
  id: string;
  userId: string;
  reference: string;
  amount: number; // in NGN
  type: TransactionType;
  channel: PaymentChannel;
  status: TransactionStatus;
  description: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type OpportunityStatus = 'available' | 'launched' | 'completed' | 'refunded';

export interface MatchOpportunity {
  id: string;
  userId: string;
  gameId: string;
  gameTitle: string;
  price: number; // exactly ₦100 per normal match
  status: OpportunityStatus;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  launchedAt?: string;
  completedAt?: string;
  refundedAt?: string;
}

export type SessionStatus = 'active' | 'expired' | 'terminated';

export interface GamingSession {
  id: string;
  userId: string;
  gameTitle: string; // 'Free Fire' | 'CODM' | 'Universal Hub Session' | etc.
  cost: number; // ₦100
  durationMinutes: number; // 60 minutes
  startTime: string; // ISO string
  endTime: string; // ISO string
  status: SessionStatus;
  createdAt: string;
  remainingSeconds?: number;
}

export interface PaystackInitResponse {
  success: boolean;
  authorizationUrl?: string;
  accessCode?: string;
  reference: string;
  amount: number;
  message?: string;
}

export interface PaystackVerifyResponse {
  success: boolean;
  reference: string;
  amount: number;
  newBalance: number;
  message: string;
  alreadyProcessed?: boolean;
}

// Universal Game Library Types
export type GameCategory =
  | 'All'
  | 'Battle Royale'
  | 'Shooter'
  | 'MOBA'
  | 'Sports & Racing'
  | 'Action & RPG'
  | 'Custom';

export type InstallationStatus =
  | 'installed'
  | 'not_installed'
  | 'unknown'
  | 'unsupported';

export type LaunchMethod =
  | 'android_intent'
  | 'package_direct'
  | 'url_scheme'
  | 'web_fallback'
  | 'unsupported';

export interface SupportedGame {
  id: string;
  name: string;
  packageId: string;
  category: GameCategory;
  iconUrl: string;
  bannerUrl: string;
  description: string;
  launchMethod: LaunchMethod;
  intentUri: string;
  playStoreUrl: string;
  installationStatus: InstallationStatus;
  isCustom?: boolean;
  addedBy?: string;
  activePlayersCount?: string;
  verifiedLaunch?: boolean;
}

export interface LaunchAuthorizationResponse {
  authorized: boolean;
  gameId?: string;
  gameName?: string;
  sessionId?: string;
  opportunityId?: string;
  opportunityStatus?: OpportunityStatus;
  remainingSeconds?: number;
  launchMethod?: LaunchMethod;
  launchUri?: string;
  fallbackUrl?: string;
  error?: string;
  message?: string;
}

// Live Rooms & Real-Time Chat Types
export type RoomStatus = 'waiting' | 'live' | 'ended';

export interface RoomParticipant {
  userId: string;
  displayName: string;
  joinedAt: string;
  isHost: boolean;
}

export interface RoomStreamState {
  isLive: boolean;
  streamUrl?: string | null;
  startedAt?: string | null;
  protocol?: 'hls' | 'webrtc' | 'custom';
}

export interface RoomViewer {
  uid: string;
  displayName: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface MatchRoom {
  id: string;
  hostId: string;
  hostName: string;
  gameId: string;
  gameTitle: string;
  title: string;
  status: RoomStatus;
  participantCount: number;
  participants: Record<string, RoomParticipant>;
  stream?: RoomStreamState;
  activeViewers?: Record<string, RoomViewer>;
  viewerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}
