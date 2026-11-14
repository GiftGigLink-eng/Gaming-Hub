/**
 * Gaming Hub — Stage 3.2 Real Client-to-Backend Integration Test
 *
 * Verifies live HTTP communication between the client-side AuthManager
 * and the backend Express server without mocked fetch handlers:
 * 1. Live HTTP authenticated endpoint access using client-attached Bearer token.
 * 2. Live HTTP token refresh via POST /api/auth/refresh over loopback socket.
 * 3. Live server-side atomic token rotation and Firestore/memory session persistence.
 * 4. Authenticated request execution with the newly rotated access token.
 * 5. Live HTTP logout via POST /api/auth/logout with server-side session revocation.
 * 6. Rejection of subsequent refresh operations using revoked tokens (HTTP 401).
 */

import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { app } from '../server.js';
import {
  AuthManager,
  InMemorySecureTokenStorage,
  AuthUser,
} from '../src/lib/authManager.js';
import { authRepo, AuthSession } from '../src/server/auth/authRepository.js';
import { authenticateDualAuth } from '../src/server/auth/authMiddleware.js';
import { AuthenticatedRequest } from '../src/server/firebaseAdmin.js';
import {
  generateAccessToken,
  generateRawRefreshToken,
  generateSessionId,
  generateFamilyId,
  hashRefreshToken,
} from '../src/server/auth/tokenService.js';
import { hashPassword } from '../src/server/auth/argon2Service.js';

async function runRealIntegrationSuite() {
  console.log('🌐 Starting Gaming Hub Stage 3.2 Real Client-to-Backend Integration Test Suite...\n');

  process.env.NODE_ENV = 'test';
  if (!process.env.GAMING_HUB_JWT_SECRET) {
    process.env.GAMING_HUB_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  }

  // Detach Google Cloud Firestore to use repository's test memory storage
  authRepo.setTestFirestoreInstance(null);
  authRepo.resetInMemory();

  // Mount dedicated test endpoint to verify dual-auth token validation on live server
  app.get('/api/test/real-client-protected', authenticateDualAuth, (req: AuthenticatedRequest, res: any) => {
    res.json({
      success: true,
      uid: req.user!.uid,
      authProvider: req.user!.authProvider,
    });
  });

  // 1. Bind Express app to an ephemeral loopback port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const port = address.port;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  console.log(`  🚀 Live Express dev server listening on ${apiBaseUrl}`);

  try {
    // 2. Provision test user in server database
    const testUserId = `gh_integ_player_${Date.now()}`;
    const testEmail = `integ_${Date.now()}@gaminghub.ng`;
    const nowIso = new Date().toISOString();

    await authRepo.createCredential({
      userId: testUserId,
      email: testEmail,
      passwordHash: await hashPassword('IntegrationSecurePass!123'),
      failedLoginAttempts: 0,
      lockUntil: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await authRepo.ensureUserProfile({
      id: testUserId,
      email: testEmail,
      displayName: 'IntegPlayer',
      phoneNumber: '+2348011223344',
      role: 'user',
      createdAt: nowIso,
    });

    // 3. Provision initial active session on server
    const sessionId = generateSessionId();
    const familyId = generateFamilyId();
    const rawRefreshToken1 = generateRawRefreshToken();
    const refreshTokenHash1 = hashRefreshToken(rawRefreshToken1);

    const initialSession: AuthSession = {
      sessionId,
      userId: testUserId,
      familyId,
      refreshTokenHash: refreshTokenHash1,
      previousRefreshTokenHash: null,
      consumedTokenHashes: [],
      isRevoked: false,
      revokedReason: null,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: nowIso,
      lastRotatedAt: nowIso,
      userAgent: 'RealIntegrationClient/1.0',
      ip: '127.0.0.1',
    };

    await authRepo.createSession(initialSession);

    const initialAccessToken = generateAccessToken({
      sub: testUserId,
      uid: testUserId,
      email: testEmail,
      sessionId,
      role: 'user',
    });

    const mockUser: AuthUser = {
      id: testUserId,
      email: testEmail,
      displayName: 'IntegPlayer',
      role: 'user',
      createdAt: nowIso,
    };

    // 4. Initialize AuthManager targeting real server with REAL fetch (no mocks)
    const storage = new InMemorySecureTokenStorage();
    const manager = new AuthManager({
      storage,
      apiBaseUrl,
      // customFetch omitted: uses standard runtime globalThis.fetch
    });

    await manager.setSession({
      user: mockUser,
      tokens: {
        accessToken: initialAccessToken,
        refreshToken: rawRefreshToken1,
        expiresIn: 900,
        tokenType: 'Bearer',
      },
    });

    assert.strictEqual(manager.isAuthenticated(), true);
    assert.strictEqual(manager.getAccessToken(), initialAccessToken);

    // -------------------------------------------------------------------------
    // Test Case 1: Real HTTP Authenticated Request
    // -------------------------------------------------------------------------
    console.log('  Testing Step 1: Real HTTP request with client-managed access token...');
    const protectedRes = await manager.fetch(`${apiBaseUrl}/api/test/real-client-protected`);
    assert.strictEqual(protectedRes.status, 200, 'Authenticated request to live backend must return 200 OK');
    const protectedData = await protectedRes.json();
    assert.strictEqual(protectedData.success, true);
    assert.strictEqual(protectedData.uid, testUserId);
    assert.strictEqual(protectedData.authProvider, 'gaminghub');
    console.log('    ✅ [PASS] Step 1: Live HTTP request verified');

    // -------------------------------------------------------------------------
    // Test Case 2: Real HTTP Token Refresh & Server-Side Atomic Rotation
    // -------------------------------------------------------------------------
    console.log('  Testing Step 2: Real HTTP refresh request and server-side token rotation...');
    // Allow JWT second-resolution timestamp (iat) to advance
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const rotatedAccessToken = await manager.refreshSession();

    assert.ok(rotatedAccessToken, 'Refresh session must return a new access token');
    assert.notStrictEqual(rotatedAccessToken, initialAccessToken, 'Rotated access token must differ from initial token');
    assert.strictEqual(manager.getAccessToken(), rotatedAccessToken, 'AuthManager must update in-memory access token');

    const rotatedRefreshToken = await storage.getRefreshToken();
    assert.ok(rotatedRefreshToken, 'Secure storage must contain the rotated refresh token');
    assert.notStrictEqual(rotatedRefreshToken, rawRefreshToken1, 'Rotated refresh token must differ from initial token');

    // Verify on server database that rotation was atomically persisted
    const rotatedHash = hashRefreshToken(rotatedRefreshToken!);
    const sessionInDb = await authRepo.findSessionByTokenHash(rotatedHash);
    assert.ok(sessionInDb, 'Server must locate session by new refresh token hash');
    assert.strictEqual(sessionInDb.session.sessionId, sessionId);
    assert.strictEqual(sessionInDb.isCurrent, true, 'New token must be the current active token');
    assert.strictEqual(sessionInDb.session.isRevoked, false, 'Active session must not be revoked');

    // Verify old token was added to consumedTokenHashes with timestamp
    const oldHash = hashRefreshToken(rawRefreshToken1);
    const consumedRecord = sessionInDb.session.consumedTokenHashes.find((r) => r.hash === oldHash);
    assert.ok(consumedRecord, 'Previous token hash must be recorded in consumedTokenHashes');
    console.log('    ✅ [PASS] Step 2: Live token rotation and database persistence verified');

    // -------------------------------------------------------------------------
    // Test Case 3: Real HTTP Request with Rotated Access Token
    // -------------------------------------------------------------------------
    console.log('  Testing Step 3: Real HTTP request using newly rotated access token...');
    const postRefreshRes = await manager.fetch(`${apiBaseUrl}/api/test/real-client-protected`);
    assert.strictEqual(postRefreshRes.status, 200, 'Live backend must accept rotated access token');
    const postRefreshData = await postRefreshRes.json();
    assert.strictEqual(postRefreshData.success, true);
    assert.strictEqual(postRefreshData.uid, testUserId);
    console.log('    ✅ [PASS] Step 3: Rotated access token validated by backend');

    // -------------------------------------------------------------------------
    // Test Case 4: Real HTTP Logout & Server-Side Session Revocation
    // -------------------------------------------------------------------------
    console.log('  Testing Step 4: Real HTTP logout and server-side session revocation...');
    await manager.logout();

    // Verify client state wiped
    assert.strictEqual(manager.isAuthenticated(), false, 'Manager must be unauthenticated after logout');
    assert.strictEqual(manager.getUser(), null, 'User profile must be cleared');
    assert.strictEqual(manager.getAccessToken(), null, 'Access token must be cleared');
    assert.strictEqual(await storage.getRefreshToken(), null, 'Refresh token must be wiped from secure storage');

    // Verify server database state: session marked as revoked
    const serverSessionAfterLogout = await authRepo.getSessionById(sessionId);
    assert.ok(serverSessionAfterLogout, 'Session record must exist on server');
    assert.strictEqual(serverSessionAfterLogout.isRevoked, true, 'Server session must be marked isRevoked=true');
    assert.strictEqual(serverSessionAfterLogout.revokedReason, 'logout', 'Revocation reason must be "logout"');
    console.log('    ✅ [PASS] Step 4: Live logout and session revocation verified in database');

    // -------------------------------------------------------------------------
    // Test Case 5: Revoked Token Rejection
    // -------------------------------------------------------------------------
    console.log('  Testing Step 5: Verify live server rejects revoked refresh token with HTTP 401...');
    const revokedRefreshRes = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotatedRefreshToken }),
    });

    assert.strictEqual(revokedRefreshRes.status, 401, 'Revoked token must receive HTTP 401');
    const revokedData = await revokedRefreshRes.json();
    assert.strictEqual(revokedData.code, 'AUTH_TOKEN_INVALID');
    console.log('    ✅ [PASS] Step 5: Live server strictly rejects revoked token');

    manager.destroy();
    console.log('\n🎉 Real Client-to-Backend Integration Test PASSED successfully!\n');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  } catch (err: any) {
    console.error('\n💥 Real integration test step failed with error:', err.message || err);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(1);
  }
}

runRealIntegrationSuite().catch((err) => {
  console.error('\n💥 Real integration test failed with error:', err);
  process.exit(1);
});
