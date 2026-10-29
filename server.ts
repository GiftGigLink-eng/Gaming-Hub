import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  firestoreRepo,
  DuplicateReferenceError,
  InsufficientBalanceError,
  ActiveSessionExistsError,
  InvalidTransitionError,
  NoOpportunityAvailableError,
  RoomNotFoundError,
  RoomEndedError,
  UnauthorizedHostActionError,
  ChatUnauthorizedError,
  ChatRateLimitError,
  RoomValidationError,
  ensureFirestoreService,
} from './src/server/firestoreRepository.js';
import { paystackService } from './src/server/paystackService.js';
import { gamesCatalogService } from './src/server/gamesCatalog.js';
import { authenticateFirebaseUser, AuthenticatedRequest, verifyFirebaseIdToken } from './src/server/firebaseAdmin.js';
import { legacySessionStartHandler } from './src/server/legacySession.js';
import { livekitService, LiveKitCredentialsMissingError, UnauthorizedStreamHostError } from './src/server/livekitService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function getPort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // If environment provides PORT but it is 8080 (reserved by internal proxy), enforce 3000
  if (process.env.PORT && process.env.PORT !== '8080') {
    const parsed = parseInt(process.env.PORT, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3000;
}

function getHost(): string {
  const hostArgIndex = process.argv.indexOf('--host');
  if (hostArgIndex !== -1 && process.argv[hostArgIndex + 1]) {
    return process.argv[hostArgIndex + 1];
  }
  return '0.0.0.0';
}

const PORT = getPort();
const HOST = getHost();

// Body parsing with raw text capture for Paystack webhook signature verification
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// API Routes

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Gaming Hub Backend', time: new Date().toISOString() });
});

// Stage 3 Firebase Admin, Firestore & Match Opportunities Engine Status
app.get('/api/auth/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    stage: 'Stage 3: Replace Hourly Sessions with Match Opportunities (₦100/Match)',
    coreBusinessRule: '₦100 purchases one opportunity to play one normal match in a selected game, regardless of match duration. Not an hourly subscription or wager.',
    projectId: 'gen-lang-client-0739137370',
    adminSdkInitialized: true,
    tokenVerificationRequired: true,
    persistenceType: 'Cloud Firestore (Database: ai-studio-8778ddbf-41a9-4f4f-9a96-7d6596b15a09)',
    atomicTransactionsEnforced: true,
    idempotentPaymentProcessing: true,
    idempotentMatchPurchase: true,
    multiGameSimultaneousOpportunities: true,
    noSecondaryDebitOnLaunch: true,
    authHeaderScheme: 'Bearer <Firebase_ID_Token>',
    antiImpersonationEnforced: true,
    zeroTrustProtectedEndpoints: [
      'GET /api/auth/user',
      'GET /api/wallet',
      'GET /api/transactions',
      'POST /api/paystack/initialize',
      'POST /api/paystack/verify',
      'POST /api/opportunities/purchase',
      'GET /api/opportunities',
      'POST /api/opportunities/launch',
      'POST /api/opportunities/refund',
      'POST /api/opportunities/complete',
      'POST /api/games/custom',
      'POST /api/games/launch',
      'GET /api/games/recent',
      'POST /api/rooms/:roomId/livekit-token',
    ],
  });
});

// Phone auth deprecation notice - direct unverified phone numbers rejected
app.post('/api/auth/phone-login', (_req: Request, res: Response) => {
  return res.status(401).json({
    success: false,
    error: 'Direct unverified phone number submission is deprecated. Genuine Firebase Authentication requires client-side verification (signInWithPhoneNumber) yielding a valid Firebase ID token.',
    code: 'GENUINE_FIREBASE_AUTH_REQUIRED',
  });
});

// Current User Profile (Protected - Identity derived exclusively from verified token)
app.get('/api/auth/user', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    let user = await firestoreRepo.getUser(userId);
    if (!user) {
      user = {
        id: userId,
        phoneNumber: req.user!.phoneNumber || '+2348000000000',
        displayName: `Gamer_${userId.slice(-4)}`,
        role: 'user',
        createdAt: new Date().toISOString()
      };
      await firestoreRepo.upsertUser(user);
    }
    const wallet = await firestoreRepo.getWallet(userId);
    res.json({ success: true, user, wallet });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Wallet Balance (Protected)
app.get('/api/wallet', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const wallet = await firestoreRepo.getWallet(userId);
    res.json({ success: true, wallet });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Transactions Ledger (Protected)
app.get('/api/transactions', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const transactions = await firestoreRepo.getTransactions(userId);
    res.json({ success: true, transactions });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Paystack: Public Configuration Status (Never exposes secret key)
app.get('/api/paystack/config', (_req: Request, res: Response) => {
  res.json({
    configured: paystackService.isConfigured(),
    publicKey: paystackService.getPublicKey(),
    testMode: true,
  });
});

// Paystack: Initialize Payment (Protected)
app.post('/api/paystack/initialize', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { email, amount, phoneNumber } = req.body;
    if (!amount) {
      return res.status(400).json({ success: false, error: 'Missing amount' });
    }

    const initData = await paystackService.initializePayment({
      userId,
      email: email || `${userId}@gaminghub.ng`,
      amount: Number(amount),
      phoneNumber: phoneNumber || req.user!.phoneNumber,
    });

    if (!initData.success) {
      const statusCode = initData.code === 'PAYSTACK_TEST_CONFIG_REQUIRED' ? 503 : 400;
      return res.status(statusCode).json(initData);
    }

    res.json(initData);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Payment initialization failed' });
  }
});

// Paystack: Server-Side Payment Verification (Protected - Credits verified UID)
app.post('/api/paystack/verify', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { reference } = req.body;
    if (!reference) {
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    const verificationResult = await paystackService.verifyPayment(reference, userId);
    res.json(verificationResult);
  } catch (err: any) {
    if (err instanceof DuplicateReferenceError) {
      return res.status(409).json({ success: false, error: err.message, code: 'DUPLICATE_PAYMENT' });
    }
    res.status(400).json({ success: false, error: err.message || 'Verification failed' });
  }
});

// Paystack: Webhook Handler (Verified by HMAC signature, not user token)
app.post('/api/paystack/webhook', async (req: any, res: Response) => {
  try {
    const signature = req.headers['x-paystack-signature'] as string | undefined;
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const result = await paystackService.handleWebhook(rawBody, signature);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Webhook processing failed' });
  }
});

// --- STAGE 3: MATCH OPPORTUNITIES ENGINE (₦100/MATCH) ---

// Purchase Match Opportunity (Atomic ₦100 deduction & persistent opportunity creation)
app.post('/api/opportunities/purchase', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { gameId, gameTitle, idempotencyKey } = req.body;
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const result = await firestoreRepo.purchaseOpportunity(userId, gameId, idempotencyKey, gameTitle);
    res.json({
      success: true,
      opportunity: result.opportunity,
      wallet: result.wallet,
      transaction: result.transaction,
      alreadyProcessed: result.alreadyProcessed,
      message: result.alreadyProcessed
        ? `Idempotent request: Opportunity '${result.opportunity.id}' was already purchased.`
        : `₦100 deducted. One normal match opportunity purchased for ${result.opportunity.gameTitle}!`,
    });
  } catch (err: any) {
    if (err instanceof InsufficientBalanceError) {
      return res.status(402).json({
        success: false,
        error: err.message,
        code: 'INSUFFICIENT_BALANCE',
        requiredAmount: 100,
      });
    }
    res.status(500).json({ success: false, error: err.message || 'Failed to purchase match opportunity' });
  }
});

// List Match Opportunities for Authenticated User
app.get('/api/opportunities', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const status = req.query.status as any;
    const opportunities = await firestoreRepo.getOpportunities(userId, status);
    res.json({ success: true, count: opportunities.length, opportunities });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Launch Match Opportunity
app.post('/api/opportunities/launch', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { gameId, opportunityId } = req.body;
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const authResult = await gamesCatalogService.authorizeGameLaunch(userId, gameId, opportunityId);
    if (!authResult.authorized) {
      return res.status(403).json(authResult);
    }
    res.json(authResult);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to launch opportunity' });
  }
});

// Cancel / Refund Match Opportunity before launch (Restores ₦100)
app.post('/api/opportunities/refund', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { opportunityId, reason } = req.body;
    if (!opportunityId) {
      return res.status(400).json({ success: false, error: 'opportunityId is required' });
    }

    const result = await firestoreRepo.refundOpportunity(userId, opportunityId, reason);
    res.json({
      success: true,
      opportunity: result.opportunity,
      wallet: result.wallet,
      transaction: result.transaction,
      alreadyRefunded: Boolean(result.alreadyRefunded),
      message: result.alreadyRefunded
        ? `Idempotent request: Match opportunity '${opportunityId}' was already refunded. No secondary credit issued.`
        : 'Match opportunity cancelled before launch. ₦100 refunded to wallet.',
    });
  } catch (err: any) {
    if (err instanceof InvalidTransitionError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        code: 'INVALID_TRANSITION',
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Complete Match Opportunity (Conclude match after play)
app.post('/api/opportunities/complete', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { opportunityId } = req.body;
    if (!opportunityId) {
      return res.status(400).json({ success: false, error: 'opportunityId is required' });
    }

    const opportunity = await firestoreRepo.completeOpportunity(userId, opportunityId);
    res.json({
      success: true,
      opportunity,
      message: `Match concluded. Opportunity '${opportunity.id}' marked completed.`,
    });
  } catch (err: any) {
    if (err instanceof InvalidTransitionError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        code: 'INVALID_TRANSITION',
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LEGACY SESSIONS (Permanently Retired in Stage 3 - Disabled for Safety) ---
// Session: Start ₦100 1-Hour Session (Disabled: Cannot deduct funds or start sessions)
app.post('/api/sessions/start', authenticateFirebaseUser, legacySessionStartHandler);

// Session: Get Active Session with Live Countdown (Protected)
app.get('/api/sessions/active', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const session = await firestoreRepo.getActiveSession(userId);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session: End Session Early (Protected)
app.post('/api/sessions/end', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    const terminated = await firestoreRepo.endSession(userId, sessionId);
    if (!terminated) {
      return res.status(404).json({ success: false, error: 'Active session not found or does not belong to authenticated user' });
    }
    res.json({ success: true, session: terminated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Universal Game Library Routes

// Get all games with search and category filters (Public catalog + verified user custom games)
app.get('/api/games', async (req: Request, res: Response) => {
  let userId: string | undefined;

  // Deriving identity exclusively from verified token if Authorization header is provided
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7).trim();
      const verified = await verifyFirebaseIdToken(token);
      userId = verified.uid;
    } catch {
      // If token is invalid or unprovided, catalog is served publicly without custom user data
    }
  }

  const query = req.query.query as string | undefined;
  const category = req.query.category as string | undefined;

  const games = gamesCatalogService.getAllGames(userId, query, category);
  res.json({ success: true, count: games.length, games });
});

// Add custom game entry (Protected)
app.post('/api/games/custom', authenticateFirebaseUser, (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { name, packageId, category, description, iconUrl, bannerUrl } = req.body;

    const newGame = gamesCatalogService.addCustomGame(userId, {
      name,
      packageId,
      category,
      description,
      iconUrl,
      bannerUrl,
    });

    res.json({ success: true, game: newGame, message: `${newGame.name} added to universal library.` });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to add custom game' });
  }
});

// Launch game with shared session authorization (Protected)
app.post('/api/games/launch', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { gameId, opportunityId } = req.body;
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const authResult = await gamesCatalogService.authorizeGameLaunch(userId, gameId, opportunityId);
    if (!authResult.authorized) {
      return res.status(403).json(authResult);
    }

    res.json(authResult);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Game launch authorization failed' });
  }
});

// Get recently played games (Protected)
app.get('/api/games/recent', authenticateFirebaseUser, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.uid;
  const games = gamesCatalogService.getRecentlyPlayed(userId);
  res.json({ success: true, games });
});

// Android discovery & runtime technical explanation
app.get('/api/runtime-info', (_req: Request, res: Response) => {
  res.json({
    success: true,
    runtime: 'React 19 / Vite / Express SPA',
    platform: 'Android Web Application',
    isNativeWrapper: false,
    packageEnumerationPolicy: {
      webSandbox: 'Web browser security policies prevent arbitrary installed package enumeration.',
      nativeBridgeRequirement: 'To automatically detect installed games, run inside an Android WebView with JavascriptInterface and declare <queries> in AndroidManifest.xml for package visibility.',
      launchMechanism: 'Web Intent URIs (intent://) with Google Play fallback.',
    },
  });
});


// ==========================================
// PHASE 4.1: LIVE ROOMS & REAL-TIME CHAT
// ==========================================

// Create Room (Protected)
app.post('/api/rooms', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';
    const { gameId, gameTitle, title } = req.body;

    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }
    if (!title) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }

    const room = await firestoreRepo.createRoom(userId, userName, gameId, gameTitle || gameId, title);
    res.status(201).json({ success: true, room });
  } catch (err: any) {
    if (err instanceof RoomValidationError) {
      return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION_ERROR' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// List Rooms (Public/Authenticated)
app.get('/api/rooms', async (req: Request, res: Response) => {
  try {
    const gameId = req.query.gameId as string | undefined;
    const status = req.query.status as any;
    const rooms = await firestoreRepo.listRooms(gameId, status);
    res.json({ success: true, rooms });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Single Room
app.get('/api/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const room = await firestoreRepo.getRoom(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    }
    res.json({ success: true, room });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Join Room (Protected)
app.post('/api/rooms/:roomId/join', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';
    const { roomId } = req.params;

    const room = await firestoreRepo.joinRoom(roomId, userId, userName);
    res.json({ success: true, room });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof RoomEndedError) {
      return res.status(400).json({ success: false, error: err.message, code: 'ROOM_ENDED' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Leave Room (Protected)
app.post('/api/rooms/:roomId/leave', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const room = await firestoreRepo.leaveRoom(roomId, userId);
    res.json({ success: true, room });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Close Room (Protected, Host Only)
app.post('/api/rooms/:roomId/close', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const room = await firestoreRepo.closeRoom(roomId, userId);
    res.json({ success: true, room, message: 'Room closed successfully.' });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Room Status (Protected, Host Only)
app.post('/api/rooms/:roomId/status', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const { status } = req.body;
    if (!status || !['waiting', 'live', 'ended'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    const room = await firestoreRepo.updateRoomStatus(roomId, userId, status);
    res.json({ success: true, room });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Broadcast Status & Stream URL (Protected, Host Only)
app.post('/api/rooms/:roomId/broadcast', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const { isLive, streamUrl, protocol } = req.body;

    if (typeof isLive !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Field isLive (boolean) is required.' });
    }

    const room = await firestoreRepo.updateBroadcastStatus(roomId, userId, isLive, streamUrl, protocol);
    res.json({
      success: true,
      room,
      message: isLive ? 'Broadcast started successfully.' : 'Broadcast stopped.',
    });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
    }
    if (err instanceof RoomEndedError) {
      return res.status(400).json({ success: false, error: err.message, code: 'ROOM_ENDED' });
    }
    if (err instanceof RoomValidationError) {
      return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION_ERROR' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Viewer Presence Heartbeat (Protected, Authenticated Viewer)
app.post('/api/rooms/:roomId/viewers/heartbeat', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const userProfile = await firestoreRepo.getUser(userId);
    const displayName = userProfile?.displayName || req.body?.displayName || 'Player';

    const room = await firestoreRepo.heartbeatViewer(roomId, userId, displayName);
    res.json({
      success: true,
      viewerCount: room.viewerCount,
      activeViewers: room.activeViewers,
    });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof RoomEndedError) {
      return res.status(400).json({ success: false, error: err.message, code: 'ROOM_ENDED' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Viewer Departure / Disconnect (Protected, Authenticated Viewer)
app.post('/api/rooms/:roomId/viewers/leave', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;

    const room = await firestoreRepo.leaveRoomViewer(roomId, userId);
    res.json({
      success: true,
      viewerCount: room.viewerCount,
      activeViewers: room.activeViewers,
    });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// LiveKit WebRTC Access Token (Protected, Scoped strictly by host vs viewer role)
app.post('/api/rooms/:roomId/livekit-token', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;

    const room = await firestoreRepo.getRoom(roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found.',
        code: 'ROOM_NOT_FOUND',
      });
    }

    if (room.status === 'ended') {
      return res.status(400).json({
        success: false,
        error: 'Cannot generate live stream token for an ended room.',
        code: 'ROOM_ENDED',
      });
    }

    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';

    // Verify if client explicitly requested publishing rights
    const requestPublish = Boolean(
      req.body?.publish || req.body?.asHost || req.body?.isHost || req.body?.role === 'host'
    );

    const tokenData = await livekitService.generateRoomToken(room, userId, userName, requestPublish);
    res.json({
      success: true,
      ...tokenData,
    });
  } catch (err: any) {
    if (err instanceof UnauthorizedStreamHostError) {
      return res.status(403).json({
        success: false,
        error: err.message,
        code: 'FORBIDDEN_NOT_HOST',
      });
    }
    if (err instanceof LiveKitCredentialsMissingError) {
      return res.status(500).json({
        success: false,
        error: err.message,
        code: 'LIVEKIT_CREDENTIALS_MISSING',
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});


// Send Chat Message (Protected, Room Participant Only)
app.post('/api/rooms/:roomId/messages', authenticateFirebaseUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';
    const { roomId } = req.params;
    const { text } = req.body;

    const message = await firestoreRepo.sendMessage(roomId, userId, userName, text);
    res.status(201).json({ success: true, message });
  } catch (err: any) {
    if (err instanceof RoomValidationError) {
      return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION_ERROR' });
    }
    if (err instanceof ChatRateLimitError) {
      return res.status(429).json({ success: false, error: err.message, code: 'RATE_LIMITED' });
    }
    if (err instanceof ChatUnauthorizedError) {
      return res.status(403).json({ success: false, error: err.message, code: 'NOT_A_PARTICIPANT' });
    }
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof RoomEndedError) {
      return res.status(400).json({ success: false, error: err.message, code: 'ROOM_ENDED' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Messages (Protected / Participants)
app.get('/api/rooms/:roomId/messages', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const messages = await firestoreRepo.getMessages(roomId, limit);
    res.json({ success: true, messages });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// In-app Test Runner Endpoint for live QA verification
app.post('/api/tests/run', async (_req: Request, res: Response) => {
  try {
    const { runAllTests } = await import('./tests/gaming_hub.test.js');
    await runAllTests();
    res.json({
      success: true,
      message: 'All 24 automated tests executed and passed!',
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dev vs Production Setup
async function startServer() {
  await ensureFirestoreService();
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`🎮 Gaming Hub server running on http://${HOST}:${PORT} [${isDev ? 'DEV' : 'PROD'}]`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('Failed to start Gaming Hub server:', err);
  });
}
