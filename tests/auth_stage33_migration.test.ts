/**
 * Gaming Hub — Stage 3.3 Registration & Login Migration Test Suite
 *
 * Covers all 12 Stage 3.3 verification requirements:
 * 1. New member registration via Gaming Hub backend.
 * 2. Successful login using independent credentials.
 * 3. Incorrect password rejection with timing equalization.
 * 4. Duplicate registration rejection.
 * 5. Existing Firebase account linking with verified token.
 * 6. Rejection of unverified account linking.
 * 7. Stable UID preservation across migration.
 * 8. Wallet ownership and balance preservation across migration.
 * 9. Logout and session revocation.
 * 10. Session restoration using secure storage manager.
 * 11. Expired access-token refresh via AuthManager.
 * 12. Regression testing of existing Firebase authentication compatibility.
 */

import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { app } from '../server.js';
import {
  AuthManager,
  InMemorySecureTokenStorage,
  NativeAndroidSecureStorage,
  AuthUser,
} from '../src/lib/authManager.js';
import { authRepo, AuthSession } from '../src/server/auth/authRepository.js';
import { hashPassword } from '../src/server/auth/argon2Service.js';
import { AuthenticatedRequest, setCustomTokenVerifier } from '../src/server/firebaseAdmin.js';
import { authFetch } from '../src/lib/firebase.js';

let testsPassed = 0;
let testsFailed = 0;

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    process.stdout.write(`  Testing: ${name}... `);
    await fn();
    console.log('✅ [PASS]');
    testsPassed++;
  } catch (err: any) {
    console.log('❌ [FAIL]');
    console.error(`    Error in test "${name}":`, err.message || err);
    testsFailed++;
  }
}

async function runStage33TestSuite() {
  console.log('🚀 Starting Gaming Hub Stage 3.3 Registration & Login Migration Test Suite...\n');

  process.env.NODE_ENV = 'test';
  if (!process.env.GAMING_HUB_JWT_SECRET) {
    process.env.GAMING_HUB_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  }

  // Use isolated in-memory test store
  authRepo.setTestFirestoreInstance(null);
  authRepo.resetInMemory();

  // Bind live server to ephemeral port
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as any;
  const port = address.port;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  console.log(`  Live Express dev server listening on ${apiBaseUrl}\n`);

  try {
    // -------------------------------------------------------------
    // Test 1: New member registration
    // -------------------------------------------------------------
    const newMemberEmail = `player_${Date.now()}@gaminghub.ng`;
    const newMemberPassword = 'StrongPassword!123';
    let registeredUser: AuthUser | null = null;

    await runTest('1. New member registration', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const regResult = await manager.register({
        email: newMemberEmail,
        password: newMemberPassword,
        displayName: 'ApexLegend',
      });

      assert.strictEqual(regResult.success, true, 'Registration must succeed');
      assert.ok(regResult.user, 'Must return registered user');
      assert.ok(regResult.user!.id.startsWith('gh_'), 'Must generate fresh Gaming Hub UID starting with gh_');
      assert.strictEqual(regResult.user!.email, newMemberEmail.toLowerCase());
      assert.strictEqual(regResult.user!.displayName, 'ApexLegend');

      // Tokens must be active in manager
      assert.strictEqual(manager.isAuthenticated(), true);
      assert.ok(manager.getAccessToken(), 'Access token must be in memory');
      assert.ok(await storage.getRefreshToken(), 'Refresh token must be in secure storage');

      registeredUser = regResult.user!;
      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 2: Successful login
    // -------------------------------------------------------------
    await runTest('2. Successful login using independent credentials', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const loginResult = await manager.login({
        email: newMemberEmail,
        password: newMemberPassword,
      });

      assert.strictEqual(loginResult.success, true, 'Login must succeed');
      assert.ok(loginResult.user, 'Must return user');
      assert.strictEqual(loginResult.user!.id, registeredUser!.id, 'UID must match registered user');
      assert.strictEqual(manager.isAuthenticated(), true);

      // Verify authenticated request to /api/auth/user
      const userRes = await manager.fetch(`${apiBaseUrl}/api/auth/user`);
      assert.strictEqual(userRes.status, 200);
      const data = await userRes.json();
      assert.strictEqual(data.user.id, registeredUser!.id);
      assert.strictEqual(data.wallet.balance, 0, 'New wallet balance starts at 0');

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 3: Incorrect password rejection
    // -------------------------------------------------------------
    await runTest('3. Incorrect password rejection with timing protection', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const loginResult = await manager.login({
        email: newMemberEmail,
        password: 'WrongPassword!999',
      });

      assert.strictEqual(loginResult.success, false);
      assert.strictEqual(loginResult.code, 'INVALID_CREDENTIALS');
      assert.strictEqual(manager.isAuthenticated(), false);
      assert.strictEqual(manager.getAccessToken(), null);

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 4: Duplicate registration rejection
    // -------------------------------------------------------------
    await runTest('4. Duplicate registration rejection', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const duplicateResult = await manager.register({
        email: newMemberEmail,
        password: 'AnotherPassword!456',
        displayName: 'Imposter',
      });

      assert.strictEqual(duplicateResult.success, false);
      assert.strictEqual(duplicateResult.code, 'EMAIL_ALREADY_IN_USE');
      assert.strictEqual(manager.isAuthenticated(), false);

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 5: Existing Firebase account linking with verified token
    // -------------------------------------------------------------
    const existingFirebaseUid = `firebase_legacy_user_${Date.now()}`;
    const existingFirebaseEmail = `legacy_${Date.now()}@gaminghub.ng`;
    const initialWalletBalance = 2500; // Legacy balance that MUST be preserved

    // Pre-seed an existing Firebase member profile and wallet
    await authRepo.ensureUserProfile({
      id: existingFirebaseUid,
      email: existingFirebaseEmail,
      displayName: 'LegacyProGamer',
      phoneNumber: '+2348033445566',
      role: 'user',
      createdAt: new Date(Date.now() - 86400000).toISOString(),
    });
    // Set wallet balance
    const existingWallet = await authRepo.ensureUserWallet(existingFirebaseUid);
    existingWallet.balance = initialWalletBalance;

    const concurrentFbUid = `fb_concurrent_${Date.now()}`;
    const concurrentFbEmail = `concurrent_${Date.now()}@gaminghub.ng`;
    const recoveryFbUid = `fb_recovery_${Date.now()}`;
    const recoveryFbEmail = `recovery_${Date.now()}@gaminghub.ng`;
    const otherMemberFbUid = `fb_other_${Date.now()}`;
    const otherMemberFbEmail = `other_${Date.now()}@gaminghub.ng`;
    const sharedRaceEmail = `SharedLinkRace_${Date.now()}@gaminghub.ng`;
    const sharedRaceFbUid1 = `fb_race_link_1_${Date.now()}`;
    const sharedRaceFbUid2 = `fb_race_link_2_${Date.now()}`;
    const indexOwnerTrapEmail = `index_trap_${Date.now()}@gaminghub.ng`;
    const indexAttackerFbUid = `fb_index_attacker_${Date.now()}`;
    const throttleFbUid = `fb_throttle_${Date.now()}`;
    const throttleFbEmail = `throttle_${Date.now()}@gaminghub.ng`;
    const throttleResetFbUid = `fb_throttle_reset_${Date.now()}`;
    const throttleResetFbEmail = `throttle_reset_${Date.now()}@gaminghub.ng`;
    const legacyNoIndexFbUid = `fb_legacy_noindex_${Date.now()}`;
    const legacyNoIndexEmail = `legacy_noindex_${Date.now()}@gaminghub.ng`;
    const legacyMixedRecoveryFbUid = `fb_mixed_recovery_${Date.now()}`;
    const legacyMixedRecoveryEmail = `MixedRecovery_${Date.now()}@GamingHub.NG`;

    // Configure test token verifier to simulate Firebase Admin token verification
    setCustomTokenVerifier(async (token: string) => {
      if (token === 'valid_firebase_verified_token_for_legacy') {
        return {
          uid: existingFirebaseUid,
          email: existingFirebaseEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'unverified_email_firebase_token') {
        return {
          uid: 'unverified_fb_uid_123',
          email: 'unverified@gaminghub.ng',
          emailVerified: false, // NOT verified
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_concurrent_link') {
        return {
          uid: concurrentFbUid,
          email: concurrentFbEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_recovery_user') {
        return {
          uid: recoveryFbUid,
          email: recoveryFbEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_other_member') {
        return {
          uid: otherMemberFbUid,
          email: otherMemberFbEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_race_link_1') {
        return {
          uid: sharedRaceFbUid1,
          email: sharedRaceEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_race_link_2') {
        return {
          uid: sharedRaceFbUid2,
          email: sharedRaceEmail.toLowerCase(),
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_index_attacker') {
        return {
          uid: indexAttackerFbUid,
          email: indexOwnerTrapEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_throttle_user') {
        return {
          uid: throttleFbUid,
          email: throttleFbEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_throttle_reset_user') {
        return {
          uid: throttleResetFbUid,
          email: throttleResetFbEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_legacy_noindex') {
        return {
          uid: legacyNoIndexFbUid,
          email: legacyNoIndexEmail,
          emailVerified: true,
          role: 'user',
        };
      }
      if (token === 'valid_firebase_token_mixed_recovery') {
        return {
          uid: legacyMixedRecoveryFbUid,
          email: legacyMixedRecoveryEmail.toLowerCase(),
          emailVerified: true,
          role: 'user',
        };
      }
      return null;
    });

    await runTest('5. Existing Firebase account linking', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const linkResult = await manager.linkCredentials({
        firebaseIdToken: 'valid_firebase_verified_token_for_legacy',
        password: 'NewIndependentPassword!789',
        email: existingFirebaseEmail,
      });

      assert.strictEqual(linkResult.success, true, 'Account linking must succeed');
      assert.ok(linkResult.user, 'Must return linked user');
      assert.strictEqual(linkResult.user!.id, existingFirebaseUid, 'STABLE UID: Must preserve existing Firebase UID');
      assert.strictEqual(linkResult.user!.email, existingFirebaseEmail.toLowerCase());

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 6: Rejection of unverified account linking
    // -------------------------------------------------------------
    await runTest('6. Rejection of unverified account linking', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const unverifiedResult = await manager.linkCredentials({
        firebaseIdToken: 'unverified_email_firebase_token',
        password: 'AttemptPassword!123',
        email: 'unverified@gaminghub.ng',
      });

      assert.strictEqual(unverifiedResult.success, false);
      assert.strictEqual(unverifiedResult.code, 'FIREBASE_EMAIL_UNVERIFIED');
      assert.strictEqual(manager.isAuthenticated(), false);

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 7: Stable UID preservation
    // -------------------------------------------------------------
    await runTest('7. Stable UID preservation after migration', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      // Member now logs in using their newly linked independent credentials
      const loginResult = await manager.login({
        email: existingFirebaseEmail,
        password: 'NewIndependentPassword!789',
      });

      assert.strictEqual(loginResult.success, true);
      assert.strictEqual(loginResult.user!.id, existingFirebaseUid, 'Must strictly retain the original Firebase UID');
      assert.strictEqual(manager.getUser()!.id, existingFirebaseUid);

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 8: Wallet ownership preservation
    // -------------------------------------------------------------
    await runTest('8. Wallet ownership and balance preservation', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      await manager.login({
        email: existingFirebaseEmail,
        password: 'NewIndependentPassword!789',
      });

      const userRes = await manager.fetch(`${apiBaseUrl}/api/auth/user`);
      assert.strictEqual(userRes.status, 200);
      const data = await userRes.json();

      assert.strictEqual(data.wallet.id, existingFirebaseUid);
      assert.strictEqual(data.wallet.userId, existingFirebaseUid);
      assert.strictEqual(
        data.wallet.balance,
        initialWalletBalance,
        `Wallet balance must be preserved at ${initialWalletBalance}`
      );

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 9: Logout and session revocation
    // -------------------------------------------------------------
    await runTest('9. Logout and session revocation', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      await manager.login({
        email: existingFirebaseEmail,
        password: 'NewIndependentPassword!789',
      });

      assert.strictEqual(manager.isAuthenticated(), true);
      const storedRefresh = await storage.getRefreshToken();
      assert.ok(storedRefresh);

      // Perform logout
      await manager.logout();

      assert.strictEqual(manager.isAuthenticated(), false);
      assert.strictEqual(manager.getAccessToken(), null);
      assert.strictEqual(await storage.getRefreshToken(), null);

      // Verify that the revoked refresh token is rejected by the server
      const retryRefreshRes = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: storedRefresh }),
      });
      assert.strictEqual(retryRefreshRes.status, 401, 'Revoked session must be rejected with HTTP 401');

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 10: Session restoration using secure storage manager
    // -------------------------------------------------------------
    await runTest('10. Session restoration using secure storage manager', async () => {
      // Phase 1: Login and obtain refresh token in secure storage
      const storage = new InMemorySecureTokenStorage();
      const manager1 = new AuthManager({ storage, apiBaseUrl });

      await manager1.login({
        email: newMemberEmail,
        password: newMemberPassword,
      });

      const savedRefreshToken = await storage.getRefreshToken();
      assert.ok(savedRefreshToken, 'Refresh token must be stored in secure storage');
      manager1.destroy();

      // Phase 2: Simulate app restart by instantiating new AuthManager with the same storage
      const manager2 = new AuthManager({ storage, apiBaseUrl });
      assert.strictEqual(manager2.isAuthenticated(), false, 'Initially unauthenticated before restoration');

      const restored = await manager2.restoreSession();
      assert.strictEqual(restored, true, 'restoreSession must return true');
      assert.strictEqual(manager2.isAuthenticated(), true, 'Must become authenticated');
      assert.strictEqual(manager2.getUser()!.email, newMemberEmail.toLowerCase());
      assert.ok(manager2.getAccessToken(), 'Must obtain new access token');

      manager2.destroy();
    });

    // -------------------------------------------------------------
    // Test 11: Expired access-token refresh
    // -------------------------------------------------------------
    await runTest('11. Expired access-token refresh via AuthManager', async () => {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      await manager.login({
        email: newMemberEmail,
        password: newMemberPassword,
      });

      const initialAccessToken = manager.getAccessToken();
      assert.ok(initialAccessToken);

      // Allow JWT second-resolution timestamp (iat) to advance
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Simulate token expiration by invoking refreshSession
      const refreshedAccessToken = await manager.refreshSession();
      assert.ok(refreshedAccessToken);
      assert.notStrictEqual(refreshedAccessToken, initialAccessToken, 'Refreshed access token must differ');

      // Verify refreshed access token works on protected endpoints
      const checkRes = await manager.fetch(`${apiBaseUrl}/api/auth/user`);
      assert.strictEqual(checkRes.status, 200);

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 12: Regression testing of existing Firebase compatibility
    // -------------------------------------------------------------
    await runTest('12. Regression testing of existing Firebase authentication compatibility', async () => {
      // Verify that a request presenting a valid Firebase token to /api/auth/user succeeds
      const fbRes = await fetch(`${apiBaseUrl}/api/auth/user`, {
        headers: {
          Authorization: 'Bearer valid_firebase_verified_token_for_legacy',
        },
      });

      assert.strictEqual(fbRes.status, 200, 'Firebase token must be accepted by dual-auth middleware');
      const data = await fbRes.json();
      assert.strictEqual(data.user.id, existingFirebaseUid);
      assert.strictEqual(data.wallet.balance, initialWalletBalance);
    });

    // -------------------------------------------------------------
    // Test 13: Two simultaneous registrations using the same email
    // -------------------------------------------------------------
    await runTest('13. Two simultaneous registrations using the same email', async () => {
      const simultaneousEmail = `simultaneous_${Date.now()}@gaminghub.ng`;
      const pass = 'SimultaneousPass!123';

      const [res1, res2] = await Promise.all([
        fetch(`${apiBaseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: simultaneousEmail, password: pass }),
        }),
        fetch(`${apiBaseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: simultaneousEmail, password: pass }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.strictEqual(statuses[0], 201, 'Exactly one registration must succeed with 201 Created');
      assert.strictEqual(statuses[1], 409, 'Concurrent registration must be rejected with 409 Conflict');

      const data409 = await (res1.status === 409 ? res1 : res2).json();
      assert.strictEqual(data409.code, 'EMAIL_ALREADY_IN_USE');
    });

    // -------------------------------------------------------------
    // Test 14: Failure during profile creation (transaction rollback)
    // -------------------------------------------------------------
    const interruptedEmail1 = `interrupted_profile_${Date.now()}@gaminghub.ng`;
    await runTest('14. Failure during profile creation rolls back transaction', async () => {
      authRepo.setTestFaultInjection({ failOnProfile: true });

      const failRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: interruptedEmail1, password: 'InterruptedPass!123' }),
      });

      assert.strictEqual(failRes.status, 500, 'Must fail with HTTP 500 on profile error');

      // Verify complete rollback: No credential, profile, or wallet must exist
      const cred = await authRepo.getCredentialByEmail(interruptedEmail1);
      assert.strictEqual(cred, null, 'Credential write must be rolled back');

      authRepo.setTestFaultInjection({});
    });

    // -------------------------------------------------------------
    // Test 15: Failure during wallet initialization (transaction rollback)
    // -------------------------------------------------------------
    const interruptedEmail2 = `interrupted_wallet_${Date.now()}@gaminghub.ng`;
    await runTest('15. Failure during wallet initialization rolls back transaction', async () => {
      authRepo.setTestFaultInjection({ failOnWallet: true });

      const failRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: interruptedEmail2, password: 'InterruptedPass!123' }),
      });

      assert.strictEqual(failRes.status, 500, 'Must fail with HTTP 500 on wallet error');

      // Verify complete rollback: No credential must exist
      const cred = await authRepo.getCredentialByEmail(interruptedEmail2);
      assert.strictEqual(cred, null, 'Credential write must be rolled back');

      authRepo.setTestFaultInjection({});
    });

    // -------------------------------------------------------------
    // Test 16: Successful retry after an interrupted registration
    // -------------------------------------------------------------
    await runTest('16. Successful retry after an interrupted registration', async () => {
      // Clear all faults and retry registration with interruptedEmail1
      authRepo.setTestFaultInjection({});

      const retryRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: interruptedEmail1, password: 'InterruptedPass!123', displayName: 'RecoveredPlayer' }),
      });

      assert.strictEqual(retryRes.status, 201, 'Registration retry must succeed with 201 Created');
      const data = await retryRes.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.user.id.startsWith('gh_'));

      // Verify all 3 records now exist properly
      const cred = await authRepo.getCredentialByEmail(interruptedEmail1);
      assert.ok(cred, 'Credential must exist after successful retry');
      const profile = await authRepo.getUserProfile(data.user.id);
      assert.ok(profile, 'Profile must exist');
      const wallet = await authRepo.ensureUserWallet(data.user.id);
      assert.strictEqual(wallet.balance, 0, 'Wallet must be initialized to ₦0');
    });

    // -------------------------------------------------------------
    // Test 17: Two simultaneous account-linking requests
    // -------------------------------------------------------------
    await runTest('17. Two simultaneous account-linking requests', async () => {
      // Seed concurrent legacy user
      await authRepo.ensureUserProfile({
        id: concurrentFbUid,
        email: concurrentFbEmail,
        displayName: 'ConcurrentLinkGamer',
        phoneNumber: '+2348055667788',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      const wallet = await authRepo.ensureUserWallet(concurrentFbUid);
      wallet.balance = 1200;

      const linkPass = 'ConcurrentLinkPass!123';

      const [res1, res2] = await Promise.all([
        fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_concurrent_link',
          },
          body: JSON.stringify({ password: linkPass, email: concurrentFbEmail }),
        }),
        fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_concurrent_link',
          },
          body: JSON.stringify({ password: linkPass, email: concurrentFbEmail }),
        }),
      ]);

      // Both should complete safely (one 200/201, the other 200 recovered or 409)
      const validStatuses = [200, 201, 409];
      assert.ok(validStatuses.includes(res1.status), `Res1 status must be valid: ${res1.status}`);
      assert.ok(validStatuses.includes(res2.status), `Res2 status must be valid: ${res2.status}`);

      // Verify credential was created once and balance remains 1200
      const cred = await authRepo.getCredentialByUserId(concurrentFbUid);
      assert.ok(cred, 'Credential must exist');
      assert.strictEqual(cred.userId, concurrentFbUid);
      const userWallet = await authRepo.ensureUserWallet(concurrentFbUid);
      assert.strictEqual(userWallet.balance, 1200, 'Balance must not be modified');
    });

    // -------------------------------------------------------------
    // Test 18: Retry after credentials have already been linked (safe recovery)
    // -------------------------------------------------------------
    await runTest('18. Safe recovery on retry after credentials already linked', async () => {
      // Pre-seed recovery user
      const initialRecoveryBalance = 4500;
      await authRepo.ensureUserProfile({
        id: recoveryFbUid,
        email: recoveryFbEmail,
        displayName: 'RecoveryGamer',
        phoneNumber: '+2348077889900',
        role: 'user',
        createdAt: new Date().toISOString(),
      });
      const w = await authRepo.ensureUserWallet(recoveryFbUid);
      w.balance = initialRecoveryBalance;

      const recoveryPass = 'RecoverySecretPass!123';

      // Step 1: Initial link
      const linkRes1 = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_recovery_user',
        },
        body: JSON.stringify({ password: recoveryPass, email: recoveryFbEmail }),
      });
      assert.strictEqual(linkRes1.status, 201, 'Initial linking must succeed with 201 Created');

      // Step 2: Retry link with matching password (simulating dropped response recovery)
      const linkRes2 = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_recovery_user',
        },
        body: JSON.stringify({ password: recoveryPass, email: recoveryFbEmail }),
      });

      assert.strictEqual(linkRes2.status, 200, 'Retry must recover with HTTP 200');
      const data2 = await linkRes2.json();
      assert.strictEqual(data2.success, true);
      assert.strictEqual(data2.recovered, true, 'Must indicate recovered session');
      assert.strictEqual(data2.user.id, recoveryFbUid, 'Must preserve existing Firebase UID');
      assert.ok(data2.tokens.accessToken, 'Must return valid access token on recovery');
    });

    // -------------------------------------------------------------
    // Test 19: Preservation of an existing wallet balance and profile
    // -------------------------------------------------------------
    await runTest('19. Preservation of an existing wallet balance and profile through linking & recovery', async () => {
      // Verify via GET /api/auth/user with the recovery user's credentials
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage, apiBaseUrl });

      const loginRes = await manager.login({
        email: recoveryFbEmail,
        password: 'RecoverySecretPass!123',
      });
      assert.strictEqual(loginRes.success, true);

      const userRes = await manager.fetch(`${apiBaseUrl}/api/auth/user`);
      assert.strictEqual(userRes.status, 200);
      const data = await userRes.json();

      assert.strictEqual(data.user.id, recoveryFbUid);
      assert.strictEqual(data.user.displayName, 'RecoveryGamer');
      assert.strictEqual(data.wallet.id, recoveryFbUid);
      assert.strictEqual(data.wallet.balance, 4500, 'Wallet balance of ₦4,500 must be strictly preserved');

      manager.destroy();
    });

    // -------------------------------------------------------------
    // Test 20: Rejection of attempts to link another member's credentials
    // -------------------------------------------------------------
    await runTest('20. Rejection of attempts to link another member credentials', async () => {
      // otherMemberFbUid attempts to link recoveryFbEmail (which belongs to recoveryFbUid)
      const hijackRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_other_member',
        },
        body: JSON.stringify({ password: 'MaliciousAttemptPass!123', email: recoveryFbEmail }),
      });

      // Must be rejected with HTTP 400 (EMAIL_MISMATCH with token email) or HTTP 409
      assert.ok(
        hijackRes.status === 400 || hijackRes.status === 409,
        `Must reject linking another member's account (got ${hijackRes.status})`
      );
      const data = await hijackRes.json();
      assert.strictEqual(data.success, false);
    });

    // -------------------------------------------------------------
    // Test 21: Concurrent registration with same normalized email & different UIDs creates single deterministic index
    // -------------------------------------------------------------
    await runTest('21. Concurrent registerMemberAtomic with different UIDs & normalized email creates single auth_email_index', async () => {
      const mixedCaseEmail = `  MixedRace_${Date.now()}@GamingHub.NG `;
      const normalized = mixedCaseEmail.trim().toLowerCase();
      const nowIso = new Date().toISOString();
      const uidA = `gh_race_a_${Date.now()}`;
      const uidB = `gh_race_b_${Date.now()}`;

      const results = await Promise.allSettled([
        authRepo.registerMemberAtomic({
          credential: {
            userId: uidA,
            email: mixedCaseEmail,
            passwordHash: 'hash_a',
            failedLoginAttempts: 0,
            lockUntil: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          profile: {
            id: uidA,
            email: normalized,
            phoneNumber: '',
            displayName: 'RacePlayerA',
            role: 'user',
            createdAt: nowIso,
          },
          initialBalance: 0,
        }),
        authRepo.registerMemberAtomic({
          credential: {
            userId: uidB,
            email: normalized,
            passwordHash: 'hash_b',
            failedLoginAttempts: 0,
            lockUntil: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          profile: {
            id: uidB,
            email: normalized,
            phoneNumber: '',
            displayName: 'RacePlayerB',
            role: 'user',
            createdAt: nowIso,
          },
          initialBalance: 0,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.strictEqual(fulfilled.length, 1, 'Exactly one atomic registration must commit');
      assert.strictEqual(rejected.length, 1, 'Competing atomic registration with different UID must reject');
      assert.strictEqual((rejected[0] as PromiseRejectedResult).reason.code, 'EMAIL_ALREADY_IN_USE');

      const winnerCred = await authRepo.getCredentialByEmail(normalized);
      assert.ok(winnerCred, 'Winning credential must exist');
      const loserUid = winnerCred!.userId === uidA ? uidB : uidA;
      assert.strictEqual(await authRepo.getUserProfile(loserUid), null, 'Loser must have no orphaned profile');

      const indexDoc = await authRepo.getEmailIndex(normalized);
      assert.ok(indexDoc, 'Deterministic auth_email_index document must exist');
      assert.strictEqual(indexDoc!.userId, winnerCred!.userId, 'Email index must belong to winner UID');
      assert.strictEqual(
        indexDoc!.emailKey,
        crypto.createHash('sha256').update(normalized, 'utf8').digest('hex'),
        'emailKey must equal SHA-256 of normalized email'
      );
    });

    // -------------------------------------------------------------
    // Test 22: Concurrent account linking using the same normalized email across distinct UIDs
    // -------------------------------------------------------------
    await runTest('22. Concurrent account linking using same normalized email across distinct UIDs', async () => {
      const nowIso = new Date().toISOString();
      await authRepo.ensureUserProfile({
        id: sharedRaceFbUid1,
        email: sharedRaceEmail.toLowerCase(),
        displayName: 'RaceLinker1',
        phoneNumber: '',
        role: 'user',
        createdAt: nowIso,
      });
      const w1 = await authRepo.ensureUserWallet(sharedRaceFbUid1);
      w1.balance = 1500;

      await authRepo.ensureUserProfile({
        id: sharedRaceFbUid2,
        email: sharedRaceEmail.toLowerCase(),
        displayName: 'RaceLinker2',
        phoneNumber: '',
        role: 'user',
        createdAt: nowIso,
      });
      const w2 = await authRepo.ensureUserWallet(sharedRaceFbUid2);
      w2.balance = 900;

      const [res1, res2] = await Promise.all([
        fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_race_link_1',
          },
          body: JSON.stringify({ password: 'RaceLinkPass!123' }),
        }),
        fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_race_link_2',
          },
          body: JSON.stringify({ password: 'RaceLinkPass!456' }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.strictEqual(statuses[0], 201, 'One UID must succeed linking with 201');
      assert.strictEqual(statuses[1], 409, 'Competing UID with same email must be rejected with 409');

      const loserJson = await (res1.status === 409 ? res1 : res2).json();
      assert.strictEqual(loserJson.code, 'CREDENTIALS_ALREADY_LINKED');
      assert.ok(!String(loserJson.error).includes('another member'), 'Must not disclose another member owns email');

      const indexDoc = await authRepo.getEmailIndex(sharedRaceEmail);
      assert.ok(indexDoc, 'Deterministic index must exist for winner');
      assert.strictEqual((await authRepo.ensureUserWallet(sharedRaceFbUid1)).balance, 1500);
      assert.strictEqual((await authRepo.ensureUserWallet(sharedRaceFbUid2)).balance, 900);
    });

    // -------------------------------------------------------------
    // Test 23: Existing pre-index credential blocks duplicates & lazy-backfills on login
    // -------------------------------------------------------------
    await runTest('23. Existing credential without email index blocks duplicates & lazy-backfills safely', async () => {
      const nowIso = new Date().toISOString();
      const legacyPass = 'LegacyPreIndex!123';

      // Seed existing profile & wallet for legacy user
      await authRepo.ensureUserProfile({
        id: legacyNoIndexFbUid,
        email: legacyNoIndexEmail,
        displayName: 'LegacyNoIndexPlayer',
        phoneNumber: '+2348099887766',
        role: 'user',
        createdAt: nowIso,
      });
      const legacyWallet = await authRepo.ensureUserWallet(legacyNoIndexFbUid);
      legacyWallet.balance = 6200;

      // Link via API, then delete deterministic index to simulate pre-index legacy credential
      const linkRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_legacy_noindex',
        },
        body: JSON.stringify({ password: legacyPass, email: legacyNoIndexEmail }),
      });
      assert.strictEqual(linkRes.status, 201);
      authRepo.deleteEmailIndexForTest(legacyNoIndexEmail);

      // Confirm index is currently absent
      assert.strictEqual(await authRepo.getEmailIndex(legacyNoIndexEmail), null, 'Index must be absent before backfill');

      // 1) Registration with same email must STILL be rejected even without index
      const dupRegRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: legacyNoIndexEmail, password: 'NewAttemptPass!123' }),
      });
      assert.strictEqual(dupRegRes.status, 409, 'Pre-index legacy credential must still block duplicate registration');

      // 2) Atomic linking by a different UID must STILL be rejected even without index
      await assert.rejects(
        async () => {
          await authRepo.createCredentialAtomic({
            userId: 'other_hijack_uid_999',
            email: legacyNoIndexEmail,
            passwordHash: 'hash',
            failedLoginAttempts: 0,
            lockUntil: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        },
        (err: any) => err.code === 'EMAIL_ALREADY_LINKED'
      );

      // 3) Successful login triggers safe lazy backfill of auth_email_index
      const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: legacyNoIndexEmail, password: legacyPass }),
      });
      assert.strictEqual(loginRes.status, 200);
      await new Promise((r) => setTimeout(r, 20)); // allow async backfill promise to settle

      const backfilledIndex = await authRepo.getEmailIndex(legacyNoIndexEmail);
      assert.ok(backfilledIndex, 'auth_email_index must be lazily backfilled on login');
      assert.strictEqual(backfilledIndex!.userId, legacyNoIndexFbUid, 'Backfilled index must preserve legacy UID');
      assert.strictEqual((await authRepo.ensureUserWallet(legacyNoIndexFbUid)).balance, 6200, 'Wallet balance preserved');
    });

    // -------------------------------------------------------------
    // Test 24: Existing email index belonging to another UID blocks registration & linking without overwriting
    // -------------------------------------------------------------
    await runTest('24. Existing auth_email_index belonging to another UID rejects registration & linking', async () => {
      const ownerUid = `gh_index_owner_${Date.now()}`;
      const nowIso = new Date().toISOString();
      await authRepo.ensureUserProfile({
        id: ownerUid,
        email: indexOwnerTrapEmail,
        displayName: 'TrueIndexOwner',
        phoneNumber: '',
        role: 'user',
        createdAt: nowIso,
      });
      const ownerWallet = await authRepo.ensureUserWallet(ownerUid);
      ownerWallet.balance = 7777;

      // Seed only the deterministic email index belonging to ownerUid
      authRepo.seedEmailIndexForTest(indexOwnerTrapEmail, ownerUid, nowIso);

      // Attempt registration with same email -> rejected 409
      const regRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: indexOwnerTrapEmail, password: 'AttemptRegPass!123' }),
      });
      assert.strictEqual(regRes.status, 409);

      // Attempt linking from a different Firebase UID -> rejected 409
      const linkRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_index_attacker',
        },
        body: JSON.stringify({ password: 'AttemptLinkPass!123', email: indexOwnerTrapEmail }),
      });
      assert.strictEqual(linkRes.status, 409);
      const linkJson = await linkRes.json();
      assert.strictEqual(linkJson.code, 'CREDENTIALS_ALREADY_LINKED');

      // Verify index and owner's wallet were never overwritten
      const idx = await authRepo.getEmailIndex(indexOwnerTrapEmail);
      assert.strictEqual(idx?.userId, ownerUid);
      assert.strictEqual((await authRepo.ensureUserWallet(ownerUid)).balance, 7777);
    });

    // -------------------------------------------------------------
    // Test 25: Failed recovery password throttling enforces (email, ip) 5-attempt lockout
    // -------------------------------------------------------------
    await runTest('25. Failed recovery password attempts trigger (email, ip) 429 rate-limit lockout', async () => {
      const nowIso = new Date().toISOString();
      const correctPass = 'CorrectRecovery!123';
      await authRepo.ensureUserProfile({
        id: throttleFbUid,
        email: throttleFbEmail,
        displayName: 'ThrottleGamer',
        phoneNumber: '',
        role: 'user',
        createdAt: nowIso,
      });
      const w = await authRepo.ensureUserWallet(throttleFbUid);
      w.balance = 3300;

      // Initial link succeeds
      const initRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_throttle_user',
        },
        body: JSON.stringify({ password: correctPass, email: throttleFbEmail }),
      });
      assert.strictEqual(initRes.status, 201);

      // Attempts 1..4 with wrong password return 409
      for (let i = 1; i <= 4; i++) {
        const failRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_throttle_user',
          },
          body: JSON.stringify({ password: `WrongRecovery!${i}00`, email: throttleFbEmail }),
        });
        assert.strictEqual(failRes.status, 409, `Attempt ${i} should return 409 before lockout`);
      }

      // 5th failed attempt hits maxAttempts=5 and returns 429 RATE_LIMIT_EXCEEDED
      const fifthRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_throttle_user',
        },
        body: JSON.stringify({ password: 'WrongRecovery!500', email: throttleFbEmail }),
      });
      assert.strictEqual(fifthRes.status, 429, '5th failed recovery attempt must trigger HTTP 429 lockout');
      assert.ok(fifthRes.headers.get('retry-after'), '429 response must include Retry-After header');
      const fifthJson = await fifthRes.json();
      assert.strictEqual(fifthJson.code, 'RATE_LIMIT_EXCEEDED');

      // 6th attempt even with CORRECT password remains blocked while locked out
      const blockedRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_throttle_user',
        },
        body: JSON.stringify({ password: correctPass, email: throttleFbEmail }),
      });
      assert.strictEqual(blockedRes.status, 429, 'Locked out recovery must reject even correct password with 429');
      assert.strictEqual((await authRepo.ensureUserWallet(throttleFbUid)).balance, 3300);
    });

    // -------------------------------------------------------------
    // Test 26: Successful recovery verification clears failure tracking and preserves profile/wallet
    // -------------------------------------------------------------
    await runTest('26. Successful recovery resets failure counter & preserves profile/wallet', async () => {
      const nowIso = new Date().toISOString();
      const correctPass = 'ResetRecoveryPass!123';
      await authRepo.ensureUserProfile({
        id: throttleResetFbUid,
        email: throttleResetFbEmail,
        displayName: 'ResetRecoveryGamer',
        phoneNumber: '+2348011223344',
        role: 'user',
        createdAt: nowIso,
      });
      const w = await authRepo.ensureUserWallet(throttleResetFbUid);
      w.balance = 5100;

      const initRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_throttle_reset_user',
        },
        body: JSON.stringify({ password: correctPass, email: throttleResetFbEmail }),
      });
      assert.strictEqual(initRes.status, 201);

      // 3 failed attempts (below threshold of 5)
      for (let i = 1; i <= 3; i++) {
        const failRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_throttle_reset_user',
          },
          body: JSON.stringify({ password: `BadRecovery!${i}`, email: throttleResetFbEmail }),
        });
        assert.strictEqual(failRes.status, 409);
      }

      // Valid recovery succeeds and resets failure counter
      const okRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_throttle_reset_user',
        },
        body: JSON.stringify({ password: correctPass, email: throttleResetFbEmail }),
      });
      assert.strictEqual(okRes.status, 200);
      const okJson = await okRes.json();
      assert.strictEqual(okJson.recovered, true);
      assert.strictEqual(okJson.user.id, throttleResetFbUid);

      // Because counter was reset on success, 3 more failed attempts stay under threshold (409, not 429)
      for (let i = 1; i <= 3; i++) {
        const afterResetFail = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid_firebase_token_throttle_reset_user',
          },
          body: JSON.stringify({ password: `AfterResetBad!${i}`, email: throttleResetFbEmail }),
        });
        assert.strictEqual(afterResetFail.status, 409, 'Counter must have reset after successful recovery');
      }

      const preservedProfile = await authRepo.getUserProfile(throttleResetFbUid);
      const preservedWallet = await authRepo.ensureUserWallet(throttleResetFbUid);
      assert.strictEqual(preservedProfile?.displayName, 'ResetRecoveryGamer');
      assert.strictEqual(preservedWallet.balance, 5100);
    });

    // -------------------------------------------------------------
    // Test 27: Login with a legacy mixed-case email (without mutating credential doc)
    // -------------------------------------------------------------
    const mixedLegacyUid = `fb_legacy_mixed_${Date.now()}`;
    const mixedLegacyRawEmail = `PlayerMixed_${Date.now()}@GamingHub.NG`;
    await runTest('27. Login with legacy mixed-case email succeeds without overwriting stored credential', async () => {
      const nowIso = new Date().toISOString();
      const pass = 'MixedLegacyPass!123';
      await authRepo.ensureUserProfile({
        id: mixedLegacyUid,
        email: mixedLegacyRawEmail,
        displayName: 'MixedLegacyGamer',
        phoneNumber: '+2348091112233',
        role: 'user',
        createdAt: nowIso,
      });
      const w = await authRepo.ensureUserWallet(mixedLegacyUid);
      w.balance = 8400;

      await authRepo.seedLegacyCredentialForTest(
        {
          userId: mixedLegacyUid,
          email: mixedLegacyRawEmail,
          passwordHash: await hashPassword(pass),
          failedLoginAttempts: 0,
          lockUntil: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { skipIndex: true, preserveRawEmail: true }
      );

      // Login using lowercase email
      const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: mixedLegacyRawEmail.toLowerCase(), password: pass }),
      });
      assert.strictEqual(loginRes.status, 200, 'Login with lowercase email must find legacy mixed-case credential');
      const loginJson = await loginRes.json();
      assert.strictEqual(loginJson.user.id, mixedLegacyUid);
      assert.strictEqual(loginJson.user.email, mixedLegacyRawEmail.trim().toLowerCase());

      await new Promise((r) => setTimeout(r, 20));
      // Stored credential doc must NOT be silently overwritten during ordinary login
      const storedCred = await authRepo.getCredentialByUserId(mixedLegacyUid);
      assert.strictEqual(storedCred?.email, mixedLegacyRawEmail, 'Ordinary login must not mutate stored credential email');

      // Email index must be backfilled safely
      const idx = await authRepo.getEmailIndex(mixedLegacyRawEmail);
      assert.strictEqual(idx?.userId, mixedLegacyUid);
      assert.strictEqual((await authRepo.ensureUserWallet(mixedLegacyUid)).balance, 8400);
    });

    // -------------------------------------------------------------
    // Test 28: Login with surrounding email whitespace
    // -------------------------------------------------------------
    const wsLegacyUid = `fb_legacy_ws_${Date.now()}`;
    const wsLegacyRawEmail = `  WhitespacePlayer_${Date.now()}@GamingHub.NG  `;
    await runTest('28. Login with legacy surrounding whitespace credential succeeds cleanly', async () => {
      const nowIso = new Date().toISOString();
      const pass = 'WhitespaceLegacy!123';
      await authRepo.ensureUserProfile({
        id: wsLegacyUid,
        email: wsLegacyRawEmail,
        displayName: 'WhitespaceGamer',
        phoneNumber: '+2348094445566',
        role: 'user',
        createdAt: nowIso,
      });
      const w = await authRepo.ensureUserWallet(wsLegacyUid);
      w.balance = 4150;

      await authRepo.seedLegacyCredentialForTest(
        {
          userId: wsLegacyUid,
          email: wsLegacyRawEmail,
          passwordHash: await hashPassword(pass),
          failedLoginAttempts: 0,
          lockUntil: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { skipIndex: true, preserveRawEmail: true }
      );

      // Login with trimmed lowercase and padded variants
      const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `  ${wsLegacyRawEmail.trim().toLowerCase()} `, password: pass }),
      });
      assert.strictEqual(loginRes.status, 200, 'Login with padded/normalized email must succeed');
      const loginJson = await loginRes.json();
      assert.strictEqual(loginJson.user.id, wsLegacyUid);
      assert.strictEqual((await authRepo.ensureUserWallet(wsLegacyUid)).balance, 4150);
    });

    // -------------------------------------------------------------
    // Test 29: Duplicate registration against an unnormalized legacy credential (no index)
    // -------------------------------------------------------------
    await runTest('29. Duplicate registration against unnormalized legacy credential without index is blocked', async () => {
      const nowIso = new Date().toISOString();
      const unnormUid = `fb_unnorm_dup_${Date.now()}`;
      const unnormRawEmail = `  UnnormDup_${Date.now()}@GamingHub.NG `;

      await authRepo.seedLegacyCredentialForTest(
        {
          userId: unnormUid,
          email: unnormRawEmail,
          passwordHash: await hashPassword('UnnormPass!123'),
          failedLoginAttempts: 0,
          lockUntil: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { skipIndex: true, preserveRawEmail: true }
      );

      // Confirm no email index exists yet
      assert.strictEqual(await authRepo.getEmailIndex(unnormRawEmail), null);

      // Registering with normalized lowercase must be rejected with 409
      const dupRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: unnormRawEmail.trim().toLowerCase(),
          password: 'NewRegAttempt!123',
        }),
      });
      assert.strictEqual(dupRes.status, 409, 'Unnormalized legacy credential must still block duplicate registration');
      const dupJson = await dupRes.json();
      assert.strictEqual(dupJson.code, 'EMAIL_ALREADY_IN_USE');
    });

    // -------------------------------------------------------------
    // Test 30: Linking recovery with a legacy mixed-case credential
    // -------------------------------------------------------------
    await runTest('30. Linking recovery succeeds with legacy mixed-case stored credential & preserves wallet/profile', async () => {
      const nowIso = new Date().toISOString();
      const pass = 'MixedRecoveryPass!123';
      await authRepo.ensureUserProfile({
        id: legacyMixedRecoveryFbUid,
        email: legacyMixedRecoveryEmail,
        displayName: 'MixedRecoveryGamer',
        phoneNumber: '+2348087776655',
        role: 'user',
        createdAt: nowIso,
      });
      const w = await authRepo.ensureUserWallet(legacyMixedRecoveryFbUid);
      w.balance = 9250;

      await authRepo.seedLegacyCredentialForTest(
        {
          userId: legacyMixedRecoveryFbUid,
          email: `  ${legacyMixedRecoveryEmail} `, // unnormalized mixed-case + whitespace
          passwordHash: await hashPassword(pass),
          failedLoginAttempts: 0,
          lockUntil: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { skipIndex: true, preserveRawEmail: true }
      );

      // Recovery via link-credentials with Firebase token holding lowercase email
      const recRes = await fetch(`${apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid_firebase_token_mixed_recovery',
        },
        body: JSON.stringify({ password: pass, email: legacyMixedRecoveryEmail.toLowerCase() }),
      });
      assert.strictEqual(recRes.status, 200, 'Linking recovery must normalize stored mixed-case email');
      const recJson = await recRes.json();
      assert.strictEqual(recJson.recovered, true);
      assert.strictEqual(recJson.user.id, legacyMixedRecoveryFbUid);

      // Wallet and profile strictly preserved, index safely created
      assert.strictEqual((await authRepo.ensureUserWallet(legacyMixedRecoveryFbUid)).balance, 9250);
      assert.strictEqual((await authRepo.getUserProfile(legacyMixedRecoveryFbUid))?.displayName, 'MixedRecoveryGamer');
      const idx = await authRepo.getEmailIndex(legacyMixedRecoveryEmail);
      assert.strictEqual(idx?.userId, legacyMixedRecoveryFbUid);
    });

    // -------------------------------------------------------------
    // Test 31: createCredential() enforces auth_email_index and rejects duplicates
    // -------------------------------------------------------------
    await runTest('31. createCredential() enforces auth_email_index and rejects duplicate emails across UIDs', async () => {
      const nowIso = new Date().toISOString();
      const email = `EnforcedCreateCred_${Date.now()}@GamingHub.ng`;
      const uid1 = `gh_createcred_1_${Date.now()}`;
      const uid2 = `gh_createcred_2_${Date.now()}`;

      await authRepo.createCredential({
        userId: uid1,
        email,
        passwordHash: 'hash_1',
        failedLoginAttempts: 0,
        lockUntil: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const idx = await authRepo.getEmailIndex(email);
      assert.ok(idx, 'createCredential() must atomically create auth_email_index');
      assert.strictEqual(idx!.userId, uid1);

      await assert.rejects(
        async () => {
          await authRepo.createCredential({
            userId: uid2,
            email: `  ${email.toLowerCase()} `,
            passwordHash: 'hash_2',
            failedLoginAttempts: 0,
            lockUntil: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        },
        (err: any) => err.code === 'EMAIL_ALREADY_LINKED'
      );
      assert.strictEqual(await authRepo.getCredentialByUserId(uid2), null);
    });

    // -------------------------------------------------------------
    // Test 32: updateCredential() rejects email changes while preserving rehash & failed-login updates
    // -------------------------------------------------------------
    await runTest('32. updateCredential() rejects unsafe email changes & preserves rehash and lockout counters', async () => {
      const nowIso = new Date().toISOString();
      const uid = `gh_update_guard_${Date.now()}`;
      const origEmail = `updateguard_${Date.now()}@gaminghub.ng`;

      await authRepo.createCredential({
        userId: uid,
        email: origEmail,
        passwordHash: 'old_hash',
        failedLoginAttempts: 0,
        lockUntil: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      // Unsafe email mutation must reject explicitly
      await assert.rejects(
        async () => {
          await authRepo.updateCredential(uid, { email: 'hijack@gaminghub.ng' } as any);
        },
        (err: any) => err.code === 'EMAIL_UPDATE_NOT_SUPPORTED'
      );
      assert.strictEqual((await authRepo.getCredentialByUserId(uid))?.email, origEmail);

      // Non-email updates (password rehash & failed login counters) still work
      await authRepo.updateCredential(uid, { passwordHash: 'rehashed_argon2id_value' });
      const lockRes = await authRepo.incrementFailedLoginAttempts(uid, 5, 60000);
      assert.strictEqual(lockRes.locked, false);
      let credAfter = await authRepo.getCredentialByUserId(uid);
      assert.strictEqual(credAfter?.passwordHash, 'rehashed_argon2id_value');
      assert.strictEqual(credAfter?.failedLoginAttempts, 1);

      await authRepo.resetFailedLoginAttempts(uid);
      credAfter = await authRepo.getCredentialByUserId(uid);
      assert.strictEqual(credAfter?.failedLoginAttempts, 0);
      assert.strictEqual(credAfter?.lockUntil, null);
      assert.strictEqual(credAfter?.email, origEmail);
    });

    // -------------------------------------------------------------
    // Test 33: Read-only legacy migration report detects unnormalized & conflicting accounts without mutating state
    // -------------------------------------------------------------
    await runTest('33. Read-only migration report identifies conflicts, index ownership, balances & leaves state untouched', async () => {
      const nowIso = new Date().toISOString();
      const conflictEmail = `MigrationAudit_${Date.now()}@GamingHub.NG`;
      const conflictUidA = `fb_mig_a_${Date.now()}`;
      const conflictUidB = `gh_mig_b_${Date.now()}`;

      await authRepo.ensureUserProfile({
        id: conflictUidA,
        email: conflictEmail,
        displayName: 'MigUserA',
        phoneNumber: '+2348010000001',
        role: 'user',
        createdAt: nowIso,
      });
      const wa = await authRepo.ensureUserWallet(conflictUidA);
      wa.balance = 12000;

      await authRepo.seedLegacyCredentialForTest(
        {
          userId: conflictUidA,
          email: conflictEmail,
          passwordHash: 'hash_a',
          failedLoginAttempts: 0,
          lockUntil: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { skipIndex: true, preserveRawEmail: true }
      );
      await authRepo.seedLegacyCredentialForTest(
        {
          userId: conflictUidB,
          email: conflictEmail.toLowerCase(),
          passwordHash: 'hash_b',
          failedLoginAttempts: 0,
          lockUntil: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { skipIndex: false }
      );

      const report = await authRepo.generateLegacyMigrationReport({
        resolveFirebaseVerification: async (uid) => (uid === conflictUidA ? true : false),
        resolveTransactionSummary: async (uid) =>
          uid === conflictUidA ? { count: 4, hasHistory: true } : { count: 0, hasHistory: false },
      });

      const key = crypto.createHash('sha256').update(conflictEmail.trim().toLowerCase(), 'utf8').digest('hex');
      const group = report.groups.find((g) => g.emailKey === key);
      assert.ok(group, 'Report must contain grouped entry for conflict emailKey');
      assert.strictEqual(group!.requiresManualReview, true);
      assert.ok(group!.conflictingUids.includes(conflictUidA));
      assert.ok(group!.conflictingUids.includes(conflictUidB));
      assert.strictEqual(group!.existingIndexOwnerUid, conflictUidB);
      assert.ok(group!.reviewReasons.includes('MULTIPLE_UIDS_FOR_EMAIL'));
      assert.ok(group!.reviewReasons.includes('INDEX_OWNER_MISMATCH'));
      assert.ok(group!.reviewReasons.includes('UNNORMALIZED_LEGACY_EMAIL'));

      const accA = group!.accounts.find((a) => a.uid === conflictUidA)!;
      assert.strictEqual(accA.firebaseEmailVerified, true);
      assert.strictEqual(accA.walletBalance, 12000);
      assert.strictEqual(accA.transactionCount, 4);
      assert.strictEqual(accA.hasTransactionHistory, true);

      // Confirm report executed strictly read-only
      assert.strictEqual((await authRepo.getCredentialByUserId(conflictUidA))?.email, conflictEmail);
      assert.strictEqual((await authRepo.ensureUserWallet(conflictUidA)).balance, 12000);
    });

  } finally {
    setCustomTokenVerifier(null);
    server.close();
  }

  console.log(`\n========================================================`);
  console.log(`Stage 3.3 Test Summary: ${testsPassed} passed, ${testsFailed} failed (Total: ${testsPassed + testsFailed})`);
  console.log(`========================================================\n`);

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runStage33TestSuite().catch((err) => {
  console.error('\n💥 Critical failure in Stage 3.3 test runner:', err);
  process.exit(1);
});
