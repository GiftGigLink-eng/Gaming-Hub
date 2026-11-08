import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { authRepo, AuthSession } from '../src/server/auth/authRepository.js';
import {
  generateAccessToken,
  generateSessionId,
  generateFamilyId,
  hashRefreshToken,
  getJwtSecret,
} from '../src/server/auth/tokenService.js';
import {
  authenticateDualAuth,
  verifyDualToken,
} from '../src/server/auth/authMiddleware.js';
import {
  setCustomTokenVerifier,
  AuthenticatedRequest,
} from '../src/server/firebaseAdmin.js';
import { app } from '../server.js';
import { firestoreRepo } from '../src/server/firestoreRepository.js';

// Test runner helper
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message || err);
    throw err;
  }
}

// Helper to create mock Express req & res objects
function createMockReqRes(
  body: any = {},
  headers: Record<string, string> = {},
  query: any = {},
  params: any = {}
) {
  const req: any = {
    body,
    headers: { ...headers },
    query,
    params,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };

  const resData: {
    statusCode: number;
    jsonData: any;
  } = {
    statusCode: 200,
    jsonData: null,
  };

  const res: any = {
    status(code: number) {
      resData.statusCode = code;
      return res;
    },
    json(payload: any) {
      resData.jsonData = payload;
      return res;
    },
  };

  return { req, res, resData };
}

async function runAllDualAuthTests() {
  console.log('🛡️ Starting Gaming Hub Stage 3.1 Dual-Auth Backend Middleware Test Suite...\n');

  // Enforce test environment and detach repository from Firestore
  process.env.NODE_ENV = 'test';
  process.env.GAMING_HUB_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  authRepo.setTestFirestoreInstance(null);
  authRepo.resetInMemory();

  const testSecret = getJwtSecret();

  // Test session helper
  async function createTestSession(
    userId: string,
    options: { revoked?: boolean; expired?: boolean } = {}
  ): Promise<{ sessionId: string; token: string }> {
    const sessionId = generateSessionId();
    const familyId = generateFamilyId();
    const rawRefresh = crypto.randomBytes(32).toString('hex');
    const refreshHash = hashRefreshToken(rawRefresh);

    const now = Date.now();
    const session: AuthSession = {
      sessionId,
      userId,
      familyId,
      refreshTokenHash: refreshHash,
      isRevoked: options.revoked ?? false,
      revokedReason: options.revoked ? 'logout' : null,
      expiresAt: options.expired ? now - 1000 : now + 7 * 24 * 60 * 60 * 1000,
      createdAt: new Date().toISOString(),
      lastRotatedAt: new Date().toISOString(),
    };

    await authRepo.createSession(session);

    const token = generateAccessToken({
      sub: userId,
      uid: userId,
      email: `${userId}@gaminghub.ng`,
      sessionId,
      role: 'user',
    });

    return { sessionId, token };
  }

  // -------------------------------------------------------------
  // Test 1: Valid Firebase token accepted
  // -------------------------------------------------------------
  await runTest('1. Valid Firebase Token: Accepted and populates req.user correctly', async () => {
    const fbUid = 'fb_user_alice_101';
    const fbEmail = 'alice@example.com';

    setCustomTokenVerifier(async (token: string) => {
      if (token === 'valid_firebase_rs256_mock') {
        return {
          uid: fbUid,
          email: fbEmail,
          emailVerified: true,
          phoneNumber: '+2348011111111',
          role: 'user',
        };
      }
      throw new Error('Invalid Firebase token');
    });

    try {
      const { req, res, resData } = createMockReqRes(
        {},
        { authorization: 'Bearer valid_firebase_rs256_mock' }
      );

      let nextCalled = false;
      await authenticateDualAuth(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true, 'Middleware must call next() for valid Firebase token');
      assert.strictEqual(req.user?.uid, fbUid);
      assert.strictEqual(req.user?.email, fbEmail);
      assert.strictEqual(req.user?.authProvider, 'firebase');
      assert.strictEqual(resData.jsonData, null);
    } finally {
      setCustomTokenVerifier(null);
    }
  });

  // -------------------------------------------------------------
  // Test 2: Valid Gaming Hub token accepted
  // -------------------------------------------------------------
  await runTest('2. Valid Gaming Hub Token: Accepted, checks session, and populates req.user', async () => {
    const ghUid = 'gh_user_bob_202';
    const { sessionId, token } = await createTestSession(ghUid);

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${token}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, true, 'Middleware must call next() for valid Gaming Hub token');
    assert.strictEqual(req.user?.uid, ghUid);
    assert.strictEqual(req.user?.authProvider, 'gaminghub');
    assert.strictEqual(req.user?.sessionId, sessionId);
    assert.strictEqual(req.user?.emailVerified, true);
    assert.strictEqual(resData.jsonData, null);
  });

  // -------------------------------------------------------------
  // Test 3: Invalid Gaming Hub signature rejected (401)
  // -------------------------------------------------------------
  await runTest('3. Invalid Signature: Gaming Hub token with wrong signature rejected (HTTP 401)', async () => {
    const wrongSecret = crypto.randomBytes(32).toString('hex');
    const forgedToken = jwt.sign(
      {
        sub: 'gh_attacker_303',
        uid: 'gh_attacker_303',
        email: 'attacker@example.com',
        sessionId: 'sess_fake',
        role: 'user',
        type: 'access',
      },
      wrongSecret,
      { algorithm: 'HS256', expiresIn: 900 }
    );

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${forgedToken}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'AUTH_TOKEN_INVALID');
  });

  // -------------------------------------------------------------
  // Test 4: Expired Gaming Hub token rejected (401)
  // -------------------------------------------------------------
  await runTest('4. Expired Token: Expired Gaming Hub access token rejected with AUTH_TOKEN_EXPIRED', async () => {
    const { sessionId } = await createTestSession('gh_expired_user');
    const expiredToken = jwt.sign(
      {
        sub: 'gh_expired_user',
        uid: 'gh_expired_user',
        email: 'expired@gaminghub.ng',
        sessionId,
        role: 'user',
        type: 'access',
      },
      testSecret,
      { algorithm: 'HS256', expiresIn: -10 } // Already expired
    );

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${expiredToken}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'AUTH_TOKEN_EXPIRED');
  });

  // -------------------------------------------------------------
  // Test 5: Revoked Gaming Hub session rejected (401)
  // -------------------------------------------------------------
  await runTest('5. Revoked Session: Token with revoked session rejected with SESSION_REVOKED', async () => {
    const { token } = await createTestSession('gh_revoked_user', { revoked: true });

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${token}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'SESSION_REVOKED');
  });

  // -------------------------------------------------------------
  // Test 6: Missing session in database rejected (401)
  // -------------------------------------------------------------
  await runTest('6. Missing Session: Valid token with non-existent session rejected with SESSION_NOT_FOUND', async () => {
    const nonExistentSessionId = 'sess_ghost_' + crypto.randomUUID();
    const token = generateAccessToken({
      sub: 'gh_ghost_user',
      uid: 'gh_ghost_user',
      email: 'ghost@gaminghub.ng',
      sessionId: nonExistentSessionId,
      role: 'user',
    });

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${token}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'SESSION_NOT_FOUND');
  });

  // -------------------------------------------------------------
  // Test 7: Forged UID in token rejected
  // -------------------------------------------------------------
  await runTest('7. Tampered Payload (UID): Tampering with UID without re-signing fails signature check', async () => {
    const { token } = await createTestSession('gh_legit_user');
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.uid = 'gh_tampered_admin';
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${tamperedToken}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'AUTH_TOKEN_INVALID');
  });

  // -------------------------------------------------------------
  // Test 8: Forged role in token rejected
  // -------------------------------------------------------------
  await runTest('8. Tampered Payload (Role): Tampering with role without re-signing fails signature check', async () => {
    const { token } = await createTestSession('gh_standard_user');
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.role = 'admin';
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;

    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: `Bearer ${tamperedToken}` }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'AUTH_TOKEN_INVALID');
  });

  // -------------------------------------------------------------
  // Test 9: Malformed token rejected
  // -------------------------------------------------------------
  await runTest('9. Malformed Token: Non-JWT strings rejected with HTTP 401 AUTH_TOKEN_MALFORMED', async () => {
    const { req, res, resData } = createMockReqRes(
      {},
      { authorization: 'Bearer completely_garbage_token_value_not_jwt' }
    );

    let nextCalled = false;
    await authenticateDualAuth(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'AUTH_TOKEN_MALFORMED');
  });

  // -------------------------------------------------------------
  // Test 10: Existing Firebase authorization behavior preserved
  // -------------------------------------------------------------
  await runTest('10. Backward Compatibility: Firebase token verification works seamlessly', async () => {
    const fbUid = 'firebase_user_legacy_99';
    setCustomTokenVerifier(async (token: string) => {
      if (token === 'legacy_firebase_token') {
        return {
          uid: fbUid,
          email: 'legacy@example.com',
          emailVerified: true,
          phoneNumber: '+2348099999999',
        };
      }
      throw new Error('Invalid token');
    });

    try {
      const { req, res, resData } = createMockReqRes(
        {},
        { authorization: 'Bearer legacy_firebase_token' }
      );

      let nextCalled = false;
      await authenticateDualAuth(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.user?.uid, fbUid);
      assert.strictEqual(req.user?.phoneNumber, '+2348099999999');
      assert.strictEqual(req.user?.authProvider, 'firebase');
      assert.strictEqual(resData.jsonData, null);
    } finally {
      setCustomTokenVerifier(null);
    }
  });

  // -------------------------------------------------------------
  // Test 11: Cross-user wallet and resource access protected (403)
  // -------------------------------------------------------------
  await runTest('11. Anti-Impersonation: Mismatched userId in query or body blocked with HTTP 403', async () => {
    const { token } = await createTestSession('gh_user_alice');

    // 1. Mismatched userId in query parameter
    const { req: qReq, res: qRes, resData: qResData } = createMockReqRes(
      {},
      { authorization: `Bearer ${token}` },
      { userId: 'gh_victim_bob' }
    );

    let qNextCalled = false;
    await authenticateDualAuth(qReq, qRes, () => {
      qNextCalled = true;
    });

    assert.strictEqual(qNextCalled, false);
    assert.strictEqual(qResData.statusCode, 403);
    assert.strictEqual(qResData.jsonData.code, 'FORBIDDEN_USER_MISMATCH');

    // 2. Mismatched userId in request body
    const { req: bReq, res: bRes, resData: bResData } = createMockReqRes(
      { userId: 'gh_victim_bob' },
      { authorization: `Bearer ${token}` }
    );

    let bNextCalled = false;
    await authenticateDualAuth(bReq, bRes, () => {
      bNextCalled = true;
    });

    assert.strictEqual(bNextCalled, false);
    assert.strictEqual(bResData.statusCode, 403);
    assert.strictEqual(bResData.jsonData.code, 'FORBIDDEN_USER_MISMATCH');
  });

  // -------------------------------------------------------------
  // Test 12: Isolation & Fallback Prevention
  // -------------------------------------------------------------
  await runTest('12. Isolation Guarantees: Authentication failures NEVER fall back to another verifier', async () => {
    let firebaseVerifierInvoked = false;
    setCustomTokenVerifier(async () => {
      firebaseVerifierInvoked = true;
      return { uid: 'should_never_reach_here' };
    });

    try {
      // 1. An invalid HS256 token must NOT call the Firebase verifier
      const invalidHs256Token = jwt.sign(
        { uid: 'attacker', sessionId: 'fake_sess', type: 'access' },
        'wrong_secret_12345678901234567890123456789012',
        { algorithm: 'HS256' }
      );

      const { req: hsReq, res: hsRes, resData: hsResData } = createMockReqRes(
        {},
        { authorization: `Bearer ${invalidHs256Token}` }
      );

      await authenticateDualAuth(hsReq, hsRes, () => {});
      assert.strictEqual(hsResData.statusCode, 401);
      assert.strictEqual(
        firebaseVerifierInvoked,
        false,
        'Firebase verifier must NEVER be invoked when verifying an HS256 token'
      );

      // 2. Unsupported algorithms (e.g., none, HS384) are rejected immediately
      const unsignedNoneToken = jwt.sign(
        { uid: 'attacker', role: 'admin' },
        '',
        { algorithm: 'none' as any }
      );

      const { req: noneReq, res: noneRes, resData: noneResData } = createMockReqRes(
        {},
        { authorization: `Bearer ${unsignedNoneToken}` }
      );

      await authenticateDualAuth(noneReq, noneRes, () => {});
      assert.strictEqual(noneResData.statusCode, 401);
      assert.strictEqual(noneResData.jsonData.code, 'AUTH_TOKEN_ALGORITHM_UNSUPPORTED');
    } finally {
      setCustomTokenVerifier(null);
    }
  });

  // -------------------------------------------------------------
  // Test 13: End-to-End HTTP Route Invocation (app.listen)
  // -------------------------------------------------------------
  await runTest('13. HTTP Route Verification: Protected endpoints accept both Firebase and Gaming Hub tokens', async () => {
    // Start an HTTP server using the exported app on an ephemeral port
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Set up a valid Gaming Hub user & session
      const ghUser = 'gh_test_player_404';
      const { token: ghToken } = await createTestSession(ghUser);

      // Seed in Firestore in-memory store so endpoints return valid profiles
      await firestoreRepo.upsertUser({
        id: ghUser,
        displayName: 'GhPlayer',
        phoneNumber: '+2348011223344',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      await firestoreRepo.getWallet(ghUser); // Initializes default wallet

      // Set up a valid Firebase user mock
      const fbUser = 'firebase_test_player_505';
      await firestoreRepo.upsertUser({
        id: fbUser,
        displayName: 'FbPlayer',
        phoneNumber: '+2348055667788',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      await firestoreRepo.getWallet(fbUser);

      setCustomTokenVerifier(async (token: string) => {
        if (token === 'fb_valid_test_token') {
          return {
            uid: fbUser,
            email: 'fbplayer@gaminghub.ng',
            emailVerified: true,
            phoneNumber: '+2348055667788',
            role: 'user',
          };
        }
        throw new Error('Invalid Firebase token');
      });

      // 1. GET /api/auth/user with Gaming Hub token -> 200 OK
      const ghUserRes = await fetch(`${baseUrl}/api/auth/user`, {
        headers: { Authorization: `Bearer ${ghToken}` },
      });
      assert.strictEqual(ghUserRes.status, 200, 'GET /api/auth/user with Gaming Hub token must return 200');
      const ghUserData = await ghUserRes.json();
      assert.strictEqual(ghUserData.success, true);
      assert.strictEqual(ghUserData.user.id, ghUser);

      // 2. GET /api/auth/user with Firebase token -> 200 OK
      const fbUserRes = await fetch(`${baseUrl}/api/auth/user`, {
        headers: { Authorization: 'Bearer fb_valid_test_token' },
      });
      assert.strictEqual(fbUserRes.status, 200, 'GET /api/auth/user with Firebase token must return 200');
      const fbUserData = await fbUserRes.json();
      assert.strictEqual(fbUserData.success, true);
      assert.strictEqual(fbUserData.user.id, fbUser);

      // 3. GET /api/wallet with Gaming Hub token -> 200 OK
      const ghWalletRes = await fetch(`${baseUrl}/api/wallet`, {
        headers: { Authorization: `Bearer ${ghToken}` },
      });
      assert.strictEqual(ghWalletRes.status, 200, 'GET /api/wallet with Gaming Hub token must return 200');
      const ghWalletData = await ghWalletRes.json();
      assert.strictEqual(ghWalletData.success, true);
      assert.strictEqual(ghWalletData.wallet.userId, ghUser);

      // 4. GET /api/wallet with Firebase token -> 200 OK
      const fbWalletRes = await fetch(`${baseUrl}/api/wallet`, {
        headers: { Authorization: 'Bearer fb_valid_test_token' },
      });
      assert.strictEqual(fbWalletRes.status, 200, 'GET /api/wallet with Firebase token must return 200');
      const fbWalletData = await fbWalletRes.json();
      assert.strictEqual(fbWalletData.success, true);
      assert.strictEqual(fbWalletData.wallet.userId, fbUser);

      // 5. GET /api/opportunities with Gaming Hub token -> 200 OK
      const ghOppRes = await fetch(`${baseUrl}/api/opportunities`, {
        headers: { Authorization: `Bearer ${ghToken}` },
      });
      assert.strictEqual(ghOppRes.status, 200, 'GET /api/opportunities with Gaming Hub token must return 200');
      const ghOppData = await ghOppRes.json();
      assert.strictEqual(ghOppData.success, true);

      // 6. Missing token on protected endpoint -> 401 AUTH_HEADER_MISSING
      const unauthRes = await fetch(`${baseUrl}/api/auth/user`);
      assert.strictEqual(unauthRes.status, 401);
      const unauthData = await unauthRes.json();
      assert.strictEqual(unauthData.code, 'AUTH_HEADER_MISSING');

      // 7. Cross-User Wallet Isolation (HTTP GET /api/wallet)
      // Alice calls /api/wallet: receives ONLY her wallet, never Bob's
      const aliceWalletRes = await fetch(`${baseUrl}/api/wallet`, {
        headers: { Authorization: `Bearer ${ghToken}` },
      });
      assert.strictEqual(aliceWalletRes.status, 200);
      const aliceWalletData = await aliceWalletRes.json();
      assert.strictEqual(aliceWalletData.wallet.userId, ghUser);
    } finally {
      setCustomTokenVerifier(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------
  // Test 14: Cross-User Opportunity Access (No "userId" passed)
  // -------------------------------------------------------------
  await runTest('14. Cross-User Opportunity Protection: Cannot launch or refund another gamer opportunity by ID', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Bob creates an opportunity
      const bobUid = 'gh_bob_opp_owner';
      await firestoreRepo.upsertUser({
        id: bobUid,
        displayName: 'BobGamer',
        phoneNumber: '+2348011112222',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      // Credit Bob's wallet with ₦1000 so purchase succeeds
      await firestoreRepo.creditWallet(bobUid, 1000, `tx_seed_bob_${crypto.randomUUID()}`);
      const oppResult = await firestoreRepo.purchaseOpportunity(bobUid, 'game_free_fire', 'Free Fire', `key_bob_opp_${crypto.randomUUID()}`);
      const bobOpportunityId = oppResult.opportunity.id;

      // 2. Alice authenticates with valid Gaming Hub token
      const aliceUid = 'gh_alice_opp_attacker';
      const { token: aliceToken } = await createTestSession(aliceUid);
      await firestoreRepo.upsertUser({
        id: aliceUid,
        displayName: 'AliceAttacker',
        phoneNumber: '+2348033334444',
        role: 'user',
        createdAt: new Date().toISOString(),
      });

      // 3. Alice attempts to launch Bob's opportunity WITHOUT passing userId
      const launchRes = await fetch(`${baseUrl}/api/opportunities/launch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          gameId: 'game_free_fire',
          opportunityId: bobOpportunityId,
        }),
      });
      const launchData = await launchRes.json();
      assert.strictEqual(launchRes.status, 403, 'Must return HTTP 403 Forbidden for cross-user launch');
      assert.strictEqual(launchData.authorized, false, 'Alice must not be authorized to launch Bob opportunity');
      assert.match(
        launchData.reason || launchData.error,
        /belongs to another gamer/i,
        'Server must reject cross-user opportunity launch'
      );

      // 4. Alice attempts to refund Bob's opportunity WITHOUT passing userId
      const refundRes = await fetch(`${baseUrl}/api/opportunities/refund`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          opportunityId: bobOpportunityId,
          reason: 'Malicious refund attempt',
        }),
      });
      const refundData = await refundRes.json();
      assert.strictEqual(refundRes.status, 500);
      assert.strictEqual(refundData.success, false, 'Alice must not be able to refund Bob opportunity');
      assert.match(
        refundData.error,
        /belongs to another gamer/i,
        'Server must reject cross-user opportunity refund'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------
  // Test 15: Unauthorized Room Administration by Non-Host
  // -------------------------------------------------------------
  await runTest('15. Unauthorized Room Admin: Non-host cannot reset PIN, close, status, or invite', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Host creates a room
      const hostUid = 'gh_room_host_charlie';
      await firestoreRepo.upsertUser({
        id: hostUid,
        displayName: 'HostCharlie',
        phoneNumber: '+2348055556666',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      const room = await firestoreRepo.createRoom(
        hostUid,
        'HostCharlie',
        'game_codm',
        'CODM',
        'Charlie Tournament',
        'private',
        '1234'
      );

      // 2. Non-host player authenticates
      const intruderUid = 'gh_intruder_dave';
      const { token: intruderToken } = await createTestSession(intruderUid);
      await firestoreRepo.upsertUser({
        id: intruderUid,
        displayName: 'IntruderDave',
        phoneNumber: '+2348077778888',
        role: 'user',
        createdAt: new Date().toISOString(),
      });

      // A. Intruder tries to reset room PIN
      const pinRes = await fetch(`${baseUrl}/api/rooms/${room.id}/pin/reset`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${intruderToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pin: '9999' }),
      });
      assert.strictEqual(pinRes.status, 403);
      const pinData = await pinRes.json();
      assert.strictEqual(pinData.code, 'FORBIDDEN_NOT_HOST');

      // B. Intruder tries to close host's room
      const closeRes = await fetch(`${baseUrl}/api/rooms/${room.id}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${intruderToken}` },
      });
      assert.strictEqual(closeRes.status, 403);
      const closeData = await closeRes.json();
      assert.strictEqual(closeData.code, 'FORBIDDEN_NOT_HOST');

      // C. Intruder tries to create room invitation
      const inviteRes = await fetch(`${baseUrl}/api/rooms/${room.id}/invitations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${intruderToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'Hacked VIP' }),
      });
      assert.strictEqual(inviteRes.status, 403);
      const inviteData = await inviteRes.json();
      assert.strictEqual(inviteData.code, 'FORBIDDEN_NOT_HOST');

      // D. Intruder tries to change room broadcast status
      const bcastRes = await fetch(`${baseUrl}/api/rooms/${room.id}/broadcast`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${intruderToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isLive: true, streamUrl: 'https://stream.gaminghub.ng/live/test' }),
      });
      assert.strictEqual(bcastRes.status, 403);
      const bcastData = await bcastRes.json();
      assert.strictEqual(bcastData.code, 'FORBIDDEN_NOT_HOST');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------
  // Test 16: Forged or Stale Admin Role Claims Cannot Bypass Host Checks
  // -------------------------------------------------------------
  await runTest('16. Role Permissions: Token role admin claim cannot bypass room host ownership', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Create a legitimate room with Host Eve
      const hostEveUid = 'gh_host_eve_999';
      await firestoreRepo.upsertUser({
        id: hostEveUid,
        displayName: 'HostEve',
        phoneNumber: '+2348099990000',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      const room = await firestoreRepo.createRoom(
        hostEveUid,
        'HostEve',
        'game_free_fire',
        'Free Fire',
        'Eve Championship',
        'public'
      );

      // 2. User with role: 'admin' in token, but NOT the host of Eve's room
      const adminClaimUid = 'gh_user_with_admin_role_claim';
      const sessionId = generateSessionId();
      const rawRefresh = crypto.randomBytes(32).toString('hex');
      await authRepo.createSession({
        sessionId,
        userId: adminClaimUid,
        familyId: generateFamilyId(),
        refreshTokenHash: hashRefreshToken(rawRefresh),
        isRevoked: false,
        expiresAt: Date.now() + 3600000,
        createdAt: new Date().toISOString(),
        lastRotatedAt: new Date().toISOString(),
      });
      const adminRoleToken = generateAccessToken({
        sub: adminClaimUid,
        uid: adminClaimUid,
        email: 'admin_claim@gaminghub.ng',
        sessionId,
        role: 'admin', // Token explicitly claims 'admin' role
      });

      // 3. Attempt to close Eve's room using the admin-role token
      const closeRes = await fetch(`${baseUrl}/api/rooms/${room.id}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminRoleToken}` },
      });
      assert.strictEqual(closeRes.status, 403, 'Admin role token must NOT bypass room host ownership check');
      const closeData = await closeRes.json();
      assert.strictEqual(closeData.code, 'FORBIDDEN_NOT_HOST');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------
  // Test 17: Production Safety Guard on Test-Only Verifier
  // -------------------------------------------------------------
  await runTest('17. Production Safety: setCustomTokenVerifier strictly prohibited when NODE_ENV=production', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => {
        setCustomTokenVerifier(async () => ({ uid: 'fake_prod_uid' }));
      }, /strictly forbidden in production/i);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // -------------------------------------------------------------
  // Test 18: Firebase Token Revocation Check Support
  // -------------------------------------------------------------
  await runTest('18. Firebase Revocation Checking: verifyDualToken with checkRevocation rejects revoked tokens', async () => {
    setCustomTokenVerifier(async (token: string, checkRevocation = false) => {
      if (token === 'firebase_revoked_token' && checkRevocation) {
        throw new Error('Firebase ID token has been revoked');
      }
      return { uid: 'fb_active_user' };
    });

    try {
      // With checkRevocation=true, revoked token throws AUTH_TOKEN_VERIFICATION_FAILED
      await assert.rejects(
        async () => {
          await verifyDualToken('firebase_revoked_token', true);
        },
        (err: any) => {
          assert.strictEqual(err.code, 'AUTH_TOKEN_VERIFICATION_FAILED');
          assert.match(err.details, /revoked/i);
          return true;
        }
      );

      // Active unrevoked token passes
      const user = await verifyDualToken('firebase_active_token', true);
      assert.strictEqual(user.uid, 'fb_active_user');
      assert.strictEqual(user.authProvider, 'firebase');
    } finally {
      setCustomTokenVerifier(null);
    }
  });

  console.log('\n🎉 All Stage 3.1 Dual-Auth Backend Middleware tests PASSED successfully!\n');
}

runAllDualAuthTests().catch((err) => {
  console.error('\n💥 Test run failed with error:', err);
  process.exit(1);
});
