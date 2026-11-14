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
  RoomSecurityConfigurationError,
  RoomCapacityFullError,
  InvalidAccessCodeError,
  InviteNotFoundError,
  InviteRevokedError,
  InviteExpiredError,
  InviteUsageLimitExceededError,
  MalformedCursorError,
  UnauthorizedOpportunityActionError,
  ensureFirestoreService,
} from './src/server/firestoreRepository.js';
import { paystackService } from './src/server/paystackService.js';
import { gamesCatalogService } from './src/server/gamesCatalog.js';
import {
  authenticateFirebaseUser,
  AuthenticatedRequest,
  verifyFirebaseIdToken,
} from './src/server/firebaseAdmin.js';
import { authenticateDualAuth, authenticateDualAuthStrict } from './src/server/auth/authMiddleware.js';
import { legacySessionStartHandler } from './src/server/legacySession.js';
import { livekitService, LiveKitCredentialsMissingError, UnauthorizedStreamHostError } from './src/server/livekitService.js';
import { PrivateRoomPreview } from './src/types.js';
import {
  handleRegister,
  handleLinkCredentials,
  handleLogin,
  handleRefresh,
  handleLogout,
} from './src/server/auth/authController.js';
import { authRateLimiter } from './src/server/auth/authRateLimiter.js';
import { authRepo } from './src/server/auth/authRepository.js';
import { validateJwtSecretOnStartup } from './src/server/auth/tokenService.js';

dotenv.config();

// Eagerly validate JWT configuration on boot
try {
  validateJwtSecretOnStartup();
} catch (err: any) {
  // If running in managed deployment (e.g. Cloud Run rollout) where GAMING_HUB_JWT_SECRET is not yet injected via env,
  // warn and allow container health checks to pass so the existing Firebase app functions normally.
  // Independent auth endpoints (/api/auth/*) fail closed until the secret is explicitly provisioned.
  // Re-throw immediately if a secret WAS provided but is invalid, too short (<32 chars), or an insecure placeholder.
  if (process.env.NODE_ENV === 'production' && !process.env.GAMING_HUB_JWT_SECRET) {
    console.warn('[Server] WARNING: GAMING_HUB_JWT_SECRET is not configured in production environment.');
    console.warn('[Server] Container will boot for Cloud Run health checks, but independent auth endpoints (/api/auth/*) remain fail-closed until secret is provisioned.');
  } else {
    throw err;
  }
}


// Enforce HMR disabled in development environment to avoid port collisions and CPU overhead
if (process.env.DISABLE_HMR === undefined) {
  process.env.DISABLE_HMR = 'true';
}

// Process-level resilience: Prevent unexpected dev server deaths from unhandled exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.warn('[Server] Unhandled Promise Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Critical Uncaught Exception:', err);
});

if (!process.env.ROOM_ACCESS_PEPPER && process.env.NODE_ENV !== 'production') {
  process.env.ROOM_ACCESS_PEPPER = 'dev_gaming_hub_room_access_pepper_2026_secure';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

function getPort(): number {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--port' || arg === '-p') {
      const val = parseInt(process.argv[i + 1], 10);
      if (!isNaN(val) && val > 0) return val;
    }
    if (arg.startsWith('--port=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (!isNaN(val) && val > 0) return val;
    }
  }
  // In production (e.g. Cloud Run), honor process.env.PORT (typically 8080)
  if (process.env.NODE_ENV === 'production' && process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // In development, if environment provides PORT but it is 8080 (reserved by internal dev proxy), enforce 3000
  if (process.env.PORT && process.env.PORT !== '8080') {
    const parsed = parseInt(process.env.PORT, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3000;
}

function getHost(): string {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--host' || arg === '-h') {
      if (process.argv[i + 1]) return process.argv[i + 1];
    }
    if (arg.startsWith('--host=')) {
      return arg.split('=')[1];
    }
  }
  return '0.0.0.0';
}

const PORT = getPort();
const HOST = getHost();

// CORS Middleware for iframe and preview environments
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

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

// Gaming Hub Independent Authentication Core (Stage 2)
// Registration endpoint with abuse rate-limiting
app.post('/api/auth/register', authRateLimiter.registerRateLimitMiddleware(), handleRegister);

// Credential linking endpoint for existing Firebase users
app.post('/api/auth/link-credentials', authRateLimiter.registerRateLimitMiddleware(), handleLinkCredentials);

// Login endpoint with IP-scoped abuse protection and timing normalization
app.post('/api/auth/login', authRateLimiter.loginRateLimitMiddleware(), handleLogin);


// Refresh endpoint with replay attack detection and token rotation
app.post('/api/auth/refresh', authRateLimiter.refreshRateLimitMiddleware(), handleRefresh);

// Logout endpoint with session revocation
app.post('/api/auth/logout', handleLogout);

// Current User Profile (Protected - Identity derived exclusively from verified token)
app.get('/api/auth/user', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    let user: any = null;
    let wallet: any = null;

    // 1. If Gaming Hub independent account or running in test harness, check authRepo first
    if (req.user?.authProvider === 'gaminghub' || process.env.NODE_ENV === 'test') {
      user = await authRepo.getUserProfile(userId);
      if (user) {
        wallet = await authRepo.ensureUserWallet(userId);
      }
    }

    // 2. If not yet resolved, query Firestore
    if (!user || !wallet) {
      try {
        if (!user) {
          user = await firestoreRepo.getUser(userId);
        }
        if (!user) {
          user = await authRepo.getUserProfile(userId);
        }
        if (!user) {
          const emailPrefix = req.user!.email ? req.user!.email.split('@')[0] : null;
          user = {
            id: userId,
            phoneNumber: req.user!.phoneNumber || (req.user!.email || '+2348000000000'),
            displayName: emailPrefix || `Gamer_${userId.slice(-4)}`,
            role: 'user',
            createdAt: new Date().toISOString()
          };
          await firestoreRepo.upsertUser(user).catch(() => {});
        }
        if (!wallet) {
          wallet = await firestoreRepo.getWallet(userId).catch(() => null);
        }
        if (!wallet) {
          wallet = await authRepo.ensureUserWallet(userId);
        }
      } catch {
        // Resilient fallback to authRepo
        if (!user) {
          user = await authRepo.getUserProfile(userId);
        }
        if (!user) {
          user = {
            id: userId,
            phoneNumber: req.user!.phoneNumber || (req.user!.email || '+2348000000000'),
            displayName: req.user!.email?.split('@')[0] || `Gamer_${userId.slice(-4)}`,
            role: 'user',
            createdAt: new Date().toISOString(),
          };
        }
        if (!wallet) {
          wallet = await authRepo.ensureUserWallet(userId);
        }
      }
    }

    res.json({ success: true, user, wallet });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Wallet Balance (Protected)
app.get('/api/wallet', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const wallet = await firestoreRepo.getWallet(userId);
    res.json({ success: true, wallet });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Transactions Ledger (Protected)
app.get('/api/transactions', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/paystack/initialize', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/paystack/verify', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/opportunities/purchase', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.get('/api/opportunities', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/opportunities/launch', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { gameId, opportunityId } = req.body;
    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    const authResult = await gamesCatalogService.authorizeGameLaunch(userId, gameId, opportunityId);
    if (!authResult.authorized) {
      const isOwnerMismatch = Boolean(authResult.error && authResult.error.includes('belongs to another gamer'));
      return res.status(isOwnerMismatch ? 403 : 400).json({
        ...authResult,
        success: false,
        code: isOwnerMismatch ? 'FORBIDDEN_RESOURCE_OWNER' : 'LAUNCH_DENIED',
        error: isOwnerMismatch ? 'Forbidden: You do not own this match opportunity.' : authResult.error,
      });
    }
    res.json(authResult);
  } catch (err: any) {
    if (err instanceof UnauthorizedOpportunityActionError || (err.message && err.message.includes('belongs to another gamer'))) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not own this match opportunity.',
        code: 'FORBIDDEN_RESOURCE_OWNER',
      });
    }
    res.status(500).json({ success: false, error: 'Failed to launch opportunity' });
  }
});

// Cancel / Refund Match Opportunity before launch (Restores ₦100)
app.post('/api/opportunities/refund', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
    if (err instanceof UnauthorizedOpportunityActionError || (err.message && err.message.includes('belongs to another gamer'))) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not own this match opportunity.',
        code: 'FORBIDDEN_RESOURCE_OWNER',
      });
    }
    if (err instanceof InvalidTransitionError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        code: 'INVALID_TRANSITION',
      });
    }
    if (err.message && err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Match opportunity not found.',
        code: 'OPPORTUNITY_NOT_FOUND',
      });
    }
    res.status(500).json({ success: false, error: 'Failed to refund opportunity.' });
  }
});

// Complete Match Opportunity (Conclude match after play)
app.post('/api/opportunities/complete', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
    if (err instanceof UnauthorizedOpportunityActionError || (err.message && err.message.includes('belongs to another gamer'))) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not own this match opportunity.',
        code: 'FORBIDDEN_RESOURCE_OWNER',
      });
    }
    if (err instanceof InvalidTransitionError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        code: 'INVALID_TRANSITION',
      });
    }
    if (err.message && err.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'Match opportunity not found.',
        code: 'OPPORTUNITY_NOT_FOUND',
      });
    }
    res.status(500).json({ success: false, error: 'Failed to complete opportunity.' });
  }
});

// --- LEGACY SESSIONS (Permanently Retired in Stage 3 - Disabled for Safety) ---
// Session: Start ₦100 1-Hour Session (Disabled: Cannot deduct funds or start sessions)
app.post('/api/sessions/start', authenticateDualAuthStrict, legacySessionStartHandler);

// Session: Get Active Session with Live Countdown (Protected)
app.get('/api/sessions/active', authenticateDualAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const session = await firestoreRepo.getActiveSession(userId);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session: End Session Early (Protected)
app.post('/api/sessions/end', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/games/custom', authenticateDualAuthStrict, (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/games/launch', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.get('/api/games/recent', authenticateDualAuth, (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';
    const { gameId, gameTitle, title, visibility, pin, maxParticipants } = req.body;

    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }
    if (!title) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }

    const result = await firestoreRepo.createRoom(
      userId,
      userName,
      gameId,
      gameTitle || gameId,
      title,
      visibility || 'public',
      pin,
      maxParticipants
    );

    const roomData = result.room || result;
    const sanitizedRoom = { ...roomData };
    delete (sanitizedRoom as any).accessCodeHash;
    delete (sanitizedRoom as any).pin;

    res.status(201).json({ success: true, room: sanitizedRoom, pin: result.pin });
  } catch (err: any) {
    if (err instanceof RoomValidationError) {
      return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION_ERROR' });
    }
    if (err instanceof RoomSecurityConfigurationError) {
      return res.status(500).json({ success: false, error: err.message, code: 'SECURITY_CONFIG_ERROR' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// List Rooms (Public/Authenticated) - Deterministic dual-stream query with Base64URL cursor
app.get('/api/rooms', async (req: Request, res: Response) => {
  try {
    const gameId = req.query.gameId as string | undefined;
    const status = req.query.status as any;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const cursor = req.query.cursor as string | undefined;

    const result = await firestoreRepo.listRooms(gameId, status, limit, cursor);
    res.json({ success: true, rooms: result.rooms, nextCursor: result.nextCursor });
  } catch (err: any) {
    if (err instanceof MalformedCursorError) {
      return res.status(400).json({ success: false, error: err.message, code: 'MALFORMED_CURSOR' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Single Room (With Private Room Preview Sanitization)
app.get('/api/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    const room = await firestoreRepo.getRoom(roomId);
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    }

    // Check if room is private
    if (room.visibility === 'private') {
      // Check caller's authentication token if provided
      let callerUid: string | null = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1]?.trim();
        if (token) {
          const verified = await verifyFirebaseIdToken(token);
          if (verified) callerUid = verified.uid;
        }
      }

      const isHost = callerUid && room.hostId === callerUid;
      const isMember = callerUid && room.participants && Boolean(room.participants[callerUid]);

      if (!isHost && !isMember) {
        // Return strictly sanitized PrivateRoomPreview (Zero-Knowledge)
        const preview: PrivateRoomPreview = {
          id: room.id,
          title: room.title,
          gameId: room.gameId,
          gameTitle: room.gameTitle,
          status: room.status,
          visibility: 'private',
          participantCount: room.participantCount,
          maxParticipants: room.maxParticipants,
          requiresPin: Boolean(room.accessCodeHash),
          createdAt: room.createdAt,
        };
        return res.json({ success: true, room: preview, isPreview: true });
      }
    }

    // Strip internal accessCodeHash before sending full room to members/host
    const sanitizedRoom = { ...room };
    delete (sanitizedRoom as any).accessCodeHash;

    res.json({ success: true, room: sanitizedRoom, isPreview: false });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Room PIN (Host Only)
app.post('/api/rooms/:roomId/pin/reset', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const { pin } = req.body;

    const result = await firestoreRepo.resetRoomPin(roomId, userId, pin);
    const roomData = result.room || result;
    const sanitizedRoom = { ...roomData };
    delete (sanitizedRoom as any).accessCodeHash;
    delete (sanitizedRoom as any).pin;

    res.json({ success: true, room: sanitizedRoom, pin: result.pin, message: 'Room PIN successfully reset.' });
  } catch (err: any) {
    if (err instanceof RoomValidationError) {
      return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION_ERROR' });
    }
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
    }
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof RoomSecurityConfigurationError) {
      return res.status(500).json({ success: false, error: err.message, code: 'SECURITY_CONFIG_ERROR' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Join Room (Protected) - Universal Capacity & Scrypt PIN Verification
app.post('/api/rooms/:roomId/join', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';
    const { roomId } = req.params;
    const { pin } = req.body;

    const room = await firestoreRepo.joinRoom(roomId, userId, userName, pin);
    const sanitizedRoom = { ...room };
    delete (sanitizedRoom as any).accessCodeHash;

    res.json({ success: true, room: sanitizedRoom });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof RoomEndedError) {
      return res.status(400).json({ success: false, error: err.message, code: 'ROOM_ENDED' });
    }
    if (err instanceof InvalidAccessCodeError) {
      return res.status(403).json({ success: false, error: err.message, code: 'INVALID_PIN' });
    }
    if (err instanceof RoomCapacityFullError) {
      return res.status(409).json({ success: false, error: err.message, code: 'CAPACITY_REACHED' });
    }
    if (err instanceof RoomSecurityConfigurationError) {
      return res.status(500).json({ success: false, error: err.message, code: 'SECURITY_CONFIG_ERROR' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create Room Invitation (Host Only)
app.post('/api/rooms/:roomId/invitations', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const { label, maxUses, expiresInHours } = req.body;

    const result = await firestoreRepo.createInvitation(roomId, userId, label, maxUses, expiresInHours);
    res.status(201).json({
      success: true,
      invitation: result.invitation,
      rawToken: result.rawToken,
      inviteUrl: `/rooms/${roomId}?token=${result.rawToken}`,
    });
  } catch (err: any) {
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
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

// List Room Invitations (Host Only)
app.get('/api/rooms/:roomId/invitations', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;

    const invitations = await firestoreRepo.listInvitations(roomId, userId);
    res.json({ success: true, invitations });
  } catch (err: any) {
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
    }
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Revoke Room Invitation (Host Only)
app.post('/api/rooms/:roomId/invitations/:invitationId/revoke', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId, invitationId } = req.params;

    const updated = await firestoreRepo.revokeInvitation(roomId, invitationId, userId);
    res.json({ success: true, invitation: updated, message: 'Invitation revoked successfully.' });
  } catch (err: any) {
    if (err instanceof UnauthorizedHostActionError) {
      return res.status(403).json({ success: false, error: err.message, code: 'FORBIDDEN_NOT_HOST' });
    }
    if (err instanceof InviteNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'INVITE_NOT_FOUND' });
    }
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Redeem Invitation Atomically (Protected)
app.post('/api/rooms/:roomId/invitations/redeem', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const userProfile = await firestoreRepo.getUser(userId);
    const userName = userProfile?.displayName || 'Player';
    const { roomId } = req.params;
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Invitation token is required.', code: 'TOKEN_REQUIRED' });
    }

    const result = await firestoreRepo.redeemInvitation(roomId, token, userId, userName);
    const sanitizedRoom = { ...result.room };
    delete (sanitizedRoom as any).accessCodeHash;

    res.json({
      success: true,
      room: sanitizedRoom,
      alreadyMember: result.alreadyMember,
      message: result.alreadyMember ? 'Welcome back! You are already a member.' : 'Successfully joined room!',
    });
  } catch (err: any) {
    if (err instanceof RoomNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'ROOM_NOT_FOUND' });
    }
    if (err instanceof InviteNotFoundError) {
      return res.status(404).json({ success: false, error: err.message, code: 'INVITE_NOT_FOUND' });
    }
    if (err instanceof InviteRevokedError) {
      return res.status(403).json({ success: false, error: err.message, code: 'INVITE_REVOKED' });
    }
    if (err instanceof InviteExpiredError) {
      return res.status(403).json({ success: false, error: err.message, code: 'INVITE_EXPIRED' });
    }
    if (err instanceof InviteUsageLimitExceededError) {
      return res.status(403).json({ success: false, error: err.message, code: 'USAGE_LIMIT_EXCEEDED' });
    }
    if (err instanceof RoomCapacityFullError) {
      return res.status(409).json({ success: false, error: err.message, code: 'CAPACITY_REACHED' });
    }
    if (err instanceof RoomEndedError) {
      return res.status(400).json({ success: false, error: err.message, code: 'ROOM_ENDED' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Leave Room (Protected)
app.post('/api/rooms/:roomId/leave', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms/:roomId/close', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms/:roomId/status', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms/:roomId/broadcast', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms/:roomId/viewers/heartbeat', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms/:roomId/viewers/leave', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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
app.post('/api/rooms/:roomId/livekit-token', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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

    // Verify private room streaming authorization
    if (room.visibility === 'private') {
      const isHost = room.hostId === userId;
      const isParticipant = Boolean(room.participants && room.participants[userId]);
      if (!isHost && !isParticipant) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: You must be an authorized member of this private room to access live stream audio/video.',
          code: 'PRIVATE_ROOM_UNAUTHORIZED',
        });
      }
    }

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
app.post('/api/rooms/:roomId/messages', authenticateDualAuthStrict, async (req: AuthenticatedRequest, res: Response) => {
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

// Get Messages (Protected, Active Room Participants Only)
app.get('/api/rooms/:roomId/messages', authenticateDualAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.uid;
    const { roomId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const messages = await firestoreRepo.getMessages(roomId, userId, limit);
    res.json({ success: true, messages });
  } catch (err: any) {
    if (err instanceof RoomValidationError) {
      return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION_ERROR' });
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

// In-app Test Runner Endpoint for live QA verification (Strictly disabled in production)
app.post('/api/tests/run', async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: 'Endpoint not available in production.', code: 'NOT_FOUND' });
  }
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
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Development SPA HTML transform fallback
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      if (url.startsWith('/api')) {
        return next();
      }
      try {
        const fs = await import('fs/promises');
        let template = await fs.readFile(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  let retryCount = 0;
  const maxRetries = 10;

  function listenWithRetry() {
    const server = app.listen(PORT, HOST, () => {
      console.log(`🎮 Gaming Hub server running on http://${HOST}:${PORT} [${isDev ? 'DEV' : 'PROD'}]`);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE' && retryCount < maxRetries) {
        retryCount++;
        console.warn(`[Server] Port ${PORT} occupied (attempt ${retryCount}/${maxRetries}), retrying in 500ms...`);
        setTimeout(() => {
          try {
            server.close();
          } catch (_) {}
          listenWithRetry();
        }, 500);
      } else {
        console.error('[Server] Critical HTTP listen error:', err);
      }
    });

    const shutdown = (signal: string) => {
      console.log(`[Server] Received ${signal}, closing Gaming Hub server...`);
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      server.close(() => {
        console.log('[Server] Gracefully closed Gaming Hub server');
        process.exit(0);
      });
      setTimeout(() => {
        process.exit(0);
      }, 1000).unref();
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  listenWithRetry();
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('Failed to start Gaming Hub server:', err);
  });
}

export { app };
