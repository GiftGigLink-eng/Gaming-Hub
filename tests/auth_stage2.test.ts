import assert from 'assert';
import crypto from 'crypto';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  verifyDummyPassword,
  MAX_PASSWORD_LENGTH,
} from '../src/server/auth/argon2Service.js';
import {
  generateAccessToken,
  verifyAccessToken,
  generateRawRefreshToken,
  hashRefreshToken,
  generateSessionId,
  generateFamilyId,
  ACCESS_TOKEN_EXPIRATION_SECONDS,
  validateJwtSecretOnStartup,
  MIN_JWT_SECRET_LENGTH,
} from '../src/server/auth/tokenService.js';
import * as tokenModule from '../src/server/auth/tokenService.js';
import { authRepo, REFRESH_GRACE_WINDOW_MS } from '../src/server/auth/authRepository.js';
import { authRateLimiter } from '../src/server/auth/authRateLimiter.js';
import {
  validateEmailFormat,
  validatePasswordStrength,
  handleRegister,
  handleLinkCredentials,
  handleLogin,
  handleRefresh,
  handleLogout,
} from '../src/server/auth/authController.js';
import { setCustomTokenVerifier, authenticateFirebaseUser } from '../src/server/firebaseAdmin.js';

// Initialize a secure 256-bit test secret for non-production test execution
process.env.GAMING_HUB_JWT_SECRET = crypto.randomBytes(32).toString('hex');

console.log('🎮 Starting Gaming Hub Stage 2.8 Final Authentication Hardening Test Suite...\n');

let totalTests = 0;
let passedTests = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message || err);
    throw err;
  }
}

// Helper to mock express req & res objects
function createMockReqRes(body: any = {}, headers: Record<string, string> = {}, ip = '127.0.0.1') {
  const req: any = {
    body,
    headers: { ...headers },
    ip,
    socket: { remoteAddress: ip },
  };

  const resData: {
    statusCode: number;
    headers: Record<string, string>;
    jsonData: any;
  } = {
    statusCode: 200,
    headers: {},
    jsonData: null,
  };

  const res: any = {
    status(code: number) {
      resData.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      resData.headers[name] = value;
      return res;
    },
    json(payload: any) {
      resData.jsonData = payload;
      return res;
    },
  };

  return { req, res, resData };
}

async function runAllTests() {
  const runId = Date.now();
  const testUserEmail = `player_${runId}@gaminghub.ng`;
  const existingFirebaseUid = `firebase_user_${runId}`;

  // Configure custom token verifier for unit testing
  setCustomTokenVerifier(async (token: string, checkRevocation = false) => {
    if (token === 'valid_firebase_token_veteran') {
      return {
        uid: existingFirebaseUid,
        email: testUserEmail,
        emailVerified: true,
        phoneNumber: '+2348011112222',
      };
    }
    if (token === 'firebase_token_unverified_email') {
      return {
        uid: 'firebase_unverified_user',
        email: 'unverified@gaminghub.ng',
        emailVerified: false,
      };
    }
    if (token === 'firebase_token_revoked') {
      if (checkRevocation) {
        throw new Error('Firebase token has been revoked');
      }
      return {
        uid: 'firebase_revoked_user',
        email: 'revoked@gaminghub.ng',
        emailVerified: true,
      };
    }
    if (token === 'valid_firebase_token_mismatched') {
      return {
        uid: 'firebase_user_mismatch',
        email: 'actual_firebase_email@gaminghub.ng',
        emailVerified: true,
      };
    }
    throw new Error('Invalid Firebase ID token');
  });

  // Test 1: Argon2id Password Hashing, Verification & Input Limits
  await test('1. Argon2id: Hashes password, verifies valid password, and enforces 128-char limit', async () => {
    const password = 'GamerPassword2026!';
    const hash = await hashPassword(password);

    assert(hash.startsWith('$argon2id$'), 'Hash must use argon2id algorithm prefix');
    const isValid = await verifyPassword(hash, password);
    assert.strictEqual(isValid, true, 'Valid password must verify as true');

    const isWrongValid = await verifyPassword(hash, 'WrongPassword123!');
    assert.strictEqual(isWrongValid, false, 'Invalid password must verify as false');

    assert.strictEqual(needsRehash(hash), false, 'Freshly generated hash should not need rehash');

    // Test password length limit (>128 chars)
    const longPassword = 'A'.repeat(129) + '1a';
    await assert.rejects(
      async () => await hashPassword(longPassword),
      /Password length exceeds maximum allowed limit/i,
      'Should reject hashing passwords longer than 128 characters'
    );

    const isLongValid = await verifyPassword(hash, longPassword);
    assert.strictEqual(isLongValid, false, 'Overly long password verification must return false');
  });

  // Test 2: Input Validation (Email RFC and Password Strength & Length)
  await test('2. Input Validation: Enforces RFC email format and 8-128 char password constraints', () => {
    assert.strictEqual(validateEmailFormat('player@gaminghub.ng'), true);
    assert.strictEqual(validateEmailFormat('not-an-email'), false);
    assert.strictEqual(validateEmailFormat('missing@domain'), false);
    assert.strictEqual(validateEmailFormat(''), false);

    assert.strictEqual(validatePasswordStrength('Pass1234').valid, true);
    assert.strictEqual(validatePasswordStrength('short1').valid, false); // < 8 chars
    assert.strictEqual(validatePasswordStrength('onlyletters').valid, false); // No numbers
    assert.strictEqual(validatePasswordStrength('123456789').valid, false); // No letters

    const excessivePassword = 'Password1234' + 'X'.repeat(120);
    assert.strictEqual(validatePasswordStrength(excessivePassword).valid, false); // > 128 chars
  });

  // Test 3: Account Ownership Protection: Registration rejects existing Firebase account without token
  await test('3. Account Ownership: Rejects registration for existing Firebase user without linking token', async () => {
    authRepo.resetInMemory();
    const email = testUserEmail;

    // Seed existing Firebase user record
    await authRepo.ensureUserProfile({
      id: existingFirebaseUid,
      email,
      phoneNumber: '+2348011112222',
      displayName: 'VeteranGamer',
      role: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const { req, res, resData } = createMockReqRes({
      email,
      password: 'StrongPassword2026!',
    });

    await handleRegister(req, res);

    assert.strictEqual(resData.statusCode, 409, 'Must reject with HTTP 409 Conflict');
    assert.strictEqual(
      resData.jsonData.code,
      'FIREBASE_ACCOUNT_EXISTS_LINKING_REQUIRED',
      'Must return FIREBASE_ACCOUNT_EXISTS_LINKING_REQUIRED'
    );
  });

  // Test 4: New Independent Registration (Fresh User ID)
  await test('4. Registration: Creates fresh independent account with unique gh_* UID for new users', async () => {
    const newEmail = `brand_new_${Date.now()}@gaminghub.ng`;
    const { req, res, resData } = createMockReqRes({
      email: newEmail,
      password: 'BrandNewPassword2026!',
      displayName: 'NewPlayer',
    });

    await handleRegister(req, res);

    assert.strictEqual(resData.statusCode, 201, 'Registration must return HTTP 201');
    assert.strictEqual(resData.jsonData.success, true);
    assert(resData.jsonData.user.id.startsWith('gh_'), 'New independent users must receive gh_* UID');
    assert.strictEqual(resData.jsonData.user.email, newEmail);
    assert(resData.jsonData.tokens.accessToken, 'Must return JWT access token');
    assert(resData.jsonData.tokens.refreshToken, 'Must return raw refresh token');

    // Duplicate registration rejected
    const { req: dupReq, res: dupRes, resData: dupData } = createMockReqRes({
      email: newEmail,
      password: 'AnotherPassword2026!',
    });
    await handleRegister(dupReq, dupRes);
    assert.strictEqual(dupData.statusCode, 409);
    assert.strictEqual(dupData.jsonData.code, 'EMAIL_ALREADY_IN_USE');
  });

  // Test 5: Credential Linking Endpoint with Verified Firebase Token
  await test('5. Credential Linking: Links independent credentials to verified Firebase UID via token', async () => {
    // Attempt linking without Authorization header
    const { req: unauthReq, res: unauthRes, resData: unauthData } = createMockReqRes({
      password: 'StrongPassword2026!',
    });
    await handleLinkCredentials(unauthReq, unauthRes);
    assert.strictEqual(unauthData.statusCode, 401, 'Must reject unauthenticated request');
    assert.strictEqual(unauthData.jsonData.code, 'AUTH_HEADER_MISSING');

    // Attempt linking with email mismatch
    const { req: mismatchReq, res: mismatchRes, resData: mismatchData } = createMockReqRes(
      {
        email: 'wrong_email@gaminghub.ng',
        password: 'StrongPassword2026!',
      },
      { authorization: 'Bearer valid_firebase_token_mismatched' }
    );
    await handleLinkCredentials(mismatchReq, mismatchRes);
    assert.strictEqual(mismatchData.statusCode, 400);
    assert.strictEqual(mismatchData.jsonData.code, 'EMAIL_MISMATCH');

    // Legitimate linking with valid token
    const { req: linkReq, res: linkRes, resData: linkData } = createMockReqRes(
      {
        email: testUserEmail,
        password: 'StrongPassword2026!',
      },
      { authorization: 'Bearer valid_firebase_token_veteran' }
    );
    await handleLinkCredentials(linkReq, linkRes);

    assert.strictEqual(linkData.statusCode, 201, 'Credential linking must return HTTP 201');
    assert.strictEqual(linkData.jsonData.success, true);
    assert.strictEqual(linkData.jsonData.user.id, existingFirebaseUid, 'Preserves existing Firebase UID');
    assert(linkData.jsonData.tokens.accessToken, 'Issues access token');
    assert(linkData.jsonData.tokens.refreshToken, 'Issues refresh token');

    // Attempting to link credentials again must be rejected (duplicate prevention)
    const { req: reLinkReq, res: reLinkRes, resData: reLinkData } = createMockReqRes(
      {
        email: testUserEmail,
        password: 'AnotherPassword2026!',
      },
      { authorization: 'Bearer valid_firebase_token_veteran' }
    );
    await handleLinkCredentials(reLinkReq, reLinkRes);
    assert.strictEqual(reLinkData.statusCode, 409);
    assert.strictEqual(reLinkData.jsonData.code, 'CREDENTIALS_ALREADY_LINKED');
  });

  // Test 6: Successful Login with Linked Credentials
  await test('6. Login: Authenticates linked user and issues valid claims', async () => {
    const { req, res, resData } = createMockReqRes({
      email: testUserEmail,
      password: 'StrongPassword2026!',
    });

    await handleLogin(req, res);

    assert.strictEqual(resData.statusCode, 200);
    assert.strictEqual(resData.jsonData.success, true);
    assert.strictEqual(resData.jsonData.user.id, existingFirebaseUid);

    const claims = verifyAccessToken(resData.jsonData.tokens.accessToken);
    assert.strictEqual(claims.sub, existingFirebaseUid);
    assert.strictEqual(claims.email, testUserEmail);
  });

  // Test 7: User Enumeration Protection & Timing Normalization
  await test('7. User Enumeration: Non-existent email executes dummy Argon2 hash and returns generic 401', async () => {
    const nonExistentEmail = `unknown_ghost_${Date.now()}@gaminghub.ng`;
    const startTime = Date.now();

    const { req, res, resData } = createMockReqRes({
      email: nonExistentEmail,
      password: 'SomePassword123!',
    });

    await handleLogin(req, res);
    const duration = Date.now() - startTime;

    assert.strictEqual(resData.statusCode, 401);
    assert.strictEqual(resData.jsonData.code, 'INVALID_CREDENTIALS');
    // Ensure response was not instantaneous (dummy Argon2 took non-trivial time, typically >10ms)
    assert(duration >= 10, `Dummy Argon2 verification should equalize timing, took ${duration}ms`);
  });

  // Test 8: Login Abuse Protection without Global DoS Lockout
  await test('8. Abuse Protection: Rate limits attacking IP without locking victim out globally', async () => {
    authRateLimiter.resetAll();
    const attackerIp = '198.51.100.1';
    const legitimateIp = '203.0.113.5';

    // Attacker fails 5 consecutive times from attackerIp
    for (let i = 0; i < 5; i++) {
      const { req, res } = createMockReqRes(
        { email: testUserEmail, password: 'WrongPassword999!' },
        {},
        attackerIp
      );
      await handleLogin(req, res);
    }

    // Attacker's 6th attempt is throttled (429 RATE_LIMIT_EXCEEDED)
    const { req: atkReq, res: atkRes, resData: atkData } = createMockReqRes(
      { email: testUserEmail, password: 'WrongPassword999!' },
      {},
      attackerIp
    );
    await handleLogin(atkReq, atkRes);
    assert.strictEqual(atkData.statusCode, 429, 'Attacker IP must be rate limited');
    assert.strictEqual(atkData.jsonData.code, 'RATE_LIMIT_EXCEEDED');

    // Legitimate user logging in with correct password from legitimateIp CAN STILL LOG IN!
    // This confirms ZERO global account lockout DoS vulnerability!
    const { req: legReq, res: legRes, resData: legData } = createMockReqRes(
      { email: testUserEmail, password: 'StrongPassword2026!' },
      {},
      legitimateIp
    );
    await handleLogin(legReq, legRes);
    assert.strictEqual(legData.statusCode, 200, 'Legitimate user from separate IP must NOT be locked out');
    assert.strictEqual(legData.jsonData.success, true);
  });

  // Test 9: JWT Secret Validation (Strict Stage 2.9.1 Requirements)
  await test('9. JWT Secret: Validates 64-hex 32-byte representation, rejects missing, short, non-hex, placeholders, and repeated patterns', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalSecret = process.env.GAMING_HUB_JWT_SECRET;

    try {
      process.env.NODE_ENV = 'production';

      // 1. Missing production secret terminates startup
      delete process.env.GAMING_HUB_JWT_SECRET;
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /GAMING_HUB_JWT_SECRET must be explicitly defined in production/i);

      // 2. Empty production secret terminates startup
      process.env.GAMING_HUB_JWT_SECRET = '   ';
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /GAMING_HUB_JWT_SECRET must be explicitly defined in production/i);

      // 3. Known placeholders are rejected
      const placeholders = ['secret', 'password', '123456', 'jwt_secret', 'test', 'generate_using_crypto_randombytes_32_hex'];
      for (const ph of placeholders) {
        process.env.GAMING_HUB_JWT_SECRET = ph;
        assert.throws(() => {
          validateJwtSecretOnStartup();
        }, /FATAL/i);
      }

      // 4. Short secret (<64 hex chars) is rejected
      process.env.GAMING_HUB_JWT_SECRET = 'short_20_char_secret';
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /must be exactly 64 hexadecimal characters/i);

      // 5. 32-character repeated-character secret is rejected (too short: 32 chars instead of 64 hex chars)
      process.env.GAMING_HUB_JWT_SECRET = 'a'.repeat(32);
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /must be exactly 64 hexadecimal characters/i);

      // 6. 64-character repeated-character secret is rejected (insecure repeating pattern)
      process.env.GAMING_HUB_JWT_SECRET = 'a'.repeat(64);
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /repeating character pattern/i);

      // 7. 64-character repeating block pattern is rejected
      process.env.GAMING_HUB_JWT_SECRET = '0123456789abcdef'.repeat(4);
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /repeating character pattern/i);

      // 8. Invalid hexadecimal (64 characters but non-hex characters present) is rejected
      process.env.GAMING_HUB_JWT_SECRET = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz1234567890abcdef1234567890abcdef';
      assert.throws(() => {
        validateJwtSecretOnStartup();
      }, /invalid hexadecimal characters/i);

      // 9. Correctly formatted 32-byte CSPRNG random secret (64 hex characters) is accepted
      const secureRandomSecret = crypto.randomBytes(32).toString('hex'); // Exactly 64 hex chars (256 bits)
      process.env.GAMING_HUB_JWT_SECRET = secureRandomSecret;
      assert.doesNotThrow(() => {
        validateJwtSecretOnStartup();
      }, 'Valid 64-hex 32-byte secret must pass validation');

      // 10. Verify no hardcoded production secret remains in module
      assert.strictEqual(
        (tokenModule as any).DEFAULT_SECURE_JWT_SECRET,
        undefined,
        'DEFAULT_SECURE_JWT_SECRET must be completely removed'
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.GAMING_HUB_JWT_SECRET = originalSecret;
    }
  });

  // Test 10: Refresh Concurrency & Atomic Rotation Lock
  await test('10. Refresh Concurrency: Two simultaneous rotations cannot fork session state', async () => {
    // Login to obtain active session
    const { req: loginReq, res: loginRes, resData: loginData } = createMockReqRes({
      email: testUserEmail,
      password: 'StrongPassword2026!',
    });
    await handleLogin(loginReq, loginRes);

    const tokenR1 = loginData.jsonData.tokens.refreshToken;

    // First rotation succeeds
    const { req: rotReq1, res: rotRes1, resData: rotData1 } = createMockReqRes({
      refreshToken: tokenR1,
    });
    await handleRefresh(rotReq1, rotRes1);
    assert.strictEqual(rotData1.statusCode, 200);
    const tokenR2 = rotData1.jsonData.tokens.refreshToken;

    // Second rotation using already rotated token within grace window
    const { req: rotReq2, res: rotRes2, resData: rotData2 } = createMockReqRes({
      refreshToken: tokenR1,
    });
    await handleRefresh(rotReq2, rotRes2);
    assert.strictEqual(rotData2.statusCode, 409);
    assert.strictEqual(rotData2.jsonData.code, 'CONCURRENT_REFRESH');
    assert.strictEqual(rotData2.jsonData.retryable, true, 'Concurrent rotation must be marked retryable');

    // Confirm session lineage is not forked: active token R2 remains uniquely valid
    const { req: verifyReq, res: verifyRes, resData: verifyData } = createMockReqRes({
      refreshToken: tokenR2,
    });
    await handleRefresh(verifyReq, verifyRes);
    assert.strictEqual(verifyData.statusCode, 200, 'Only the legitimate rotated token advances session');
  });

  // Test 11: Safe Lost-Response Recovery (Idempotency Key Protocol)
  await test('11. Safe Lost-Response Recovery: Client retries with matching idempotency key recover safely; attackers fail closed', async () => {
    // Login to obtain fresh session
    const { req: loginReq, res: loginRes, resData: loginData } = createMockReqRes({
      email: testUserEmail,
      password: 'StrongPassword2026!',
    });
    await handleLogin(loginReq, loginRes);

    const tokenOriginal = loginData.jsonData.tokens.refreshToken;
    const clientSecretIdempotencyKey = 'client_retry_nonce_' + crypto.randomUUID();

    // Rotation 1: Client initiates refresh with secret idempotency key (simulating dropped response)
    const { req: dropReq, res: dropRes, resData: dropData } = createMockReqRes({
      refreshToken: tokenOriginal,
      idempotencyKey: clientSecretIdempotencyKey,
    });
    await handleRefresh(dropReq, dropRes);
    assert.strictEqual(dropData.statusCode, 200, 'Server rotated token successfully');
    // Imagine the client network dropped and never received dropData.jsonData!

    // Attacker presenting consumed token WITHOUT matching idempotencyKey MUST FAIL CLOSED (zero token leakage)
    const { req: atkReq, res: atkRes, resData: atkData } = createMockReqRes({
      refreshToken: tokenOriginal,
      idempotencyKey: 'attacker_guessed_key_12345',
    });
    await handleRefresh(atkReq, atkRes);
    assert.strictEqual(atkData.statusCode, 409, 'Attacker without key cannot recover tokens');
    assert.strictEqual(atkData.jsonData.code, 'CONCURRENT_REFRESH');
    assert.strictEqual(atkData.jsonData.retryable, true);
    assert.strictEqual(atkData.jsonData.tokens, undefined, 'Must NEVER return active tokens to attacker');

    // Legitimate client retries with the SAME idempotencyKey
    const { req: retryReq, res: retryRes, resData: retryData } = createMockReqRes({
      refreshToken: tokenOriginal,
      idempotencyKey: clientSecretIdempotencyKey,
    });
    await handleRefresh(retryReq, retryRes);
    assert.strictEqual(retryData.statusCode, 200, 'Legitimate client recovers successfully');
    assert.strictEqual(retryData.jsonData.recovered, true);
    assert(retryData.jsonData.tokens.refreshToken, 'Issued recovered refresh token');
    assert(retryData.jsonData.tokens.accessToken, 'Issued recovered access token');

    // Presenting again fails closed (recovery is one-time use)
    const { req: exhaustedReq, res: exhaustedRes, resData: exhaustedData } = createMockReqRes({
      refreshToken: tokenOriginal,
      idempotencyKey: clientSecretIdempotencyKey,
    });
    await handleRefresh(exhaustedReq, exhaustedRes);
    assert.strictEqual(exhaustedData.statusCode, 409);
  });

  // Test 12: Firebase Unverified & Revoked Token Rejection
  await test('12. Firebase Credential Linking Safeguards: Rejects unverified email and revoked tokens', async () => {
    // 1. Reject unverified Firebase email account
    const { req: unverReq, res: unverRes, resData: unverData } = createMockReqRes(
      { password: 'StrongPassword2026!' },
      { authorization: 'Bearer firebase_token_unverified_email' }
    );
    await handleLinkCredentials(unverReq, unverRes);
    assert.strictEqual(unverData.statusCode, 403, 'Unverified Firebase email must be rejected');
    assert.strictEqual(unverData.jsonData.code, 'FIREBASE_EMAIL_UNVERIFIED');

    // 2. Reject revoked Firebase token
    const { req: revReq, res: revRes, resData: revData } = createMockReqRes(
      { password: 'StrongPassword2026!' },
      { authorization: 'Bearer firebase_token_revoked' }
    );
    await handleLinkCredentials(revReq, revRes);
    assert.strictEqual(revData.statusCode, 401, 'Revoked Firebase token must be rejected');
    assert.strictEqual(revData.jsonData.code, 'FIREBASE_TOKEN_INVALID');
  });

  // Test 13: Regression Protection: Existing Protected Routes strictly require Firebase tokens
  await test('13. Route Boundaries: Existing protected routes reject Gaming Hub JWTs (Firebase-only)', async () => {
    // Generate valid Gaming Hub JWT access token
    const ghJwt = generateAccessToken({
      sub: 'gh_independent_user_999',
      uid: 'gh_independent_user_999',
      email: 'gh_user@gaminghub.ng',
      sessionId: 'sess_test',
      role: 'user',
    });

    const { req, res, resData } = createMockReqRes({}, { authorization: `Bearer ${ghJwt}` });

    let nextCalled = false;
    await authenticateFirebaseUser(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false, 'Gaming Hub JWT must NOT pass authenticateFirebaseUser');
    assert.strictEqual(resData.statusCode, 401, 'Must reject with 401');
    assert.strictEqual(resData.jsonData.code, 'AUTH_TOKEN_VERIFICATION_FAILED');
  });

  // Test 14: Replay Attack Detection Outside Grace Window
  await test('14. Replay Attack: Reusing consumed token outside grace window revokes entire family', async () => {
    const { req: loginReq, res: loginRes, resData: loginData } = createMockReqRes({
      email: testUserEmail,
      password: 'StrongPassword2026!',
    });
    await handleLogin(loginReq, loginRes);

    const oldToken = loginData.jsonData.tokens.refreshToken;

    // Rotate token
    const { req: rotReq, res: rotRes, resData: rotData } = createMockReqRes({
      refreshToken: oldToken,
    });
    await handleRefresh(rotReq, rotRes);
    assert.strictEqual(rotData.statusCode, 200);
    const activeToken = rotData.jsonData.tokens.refreshToken;

    // Age consumed record outside the 25-second grace window
    const oldHash = hashRefreshToken(oldToken);
    const sessionRes = await authRepo.findSessionByTokenHash(oldHash);
    assert(sessionRes?.consumedRecord, 'Must have recorded consumed token');
    sessionRes.consumedRecord.consumedAt = Date.now() - (REFRESH_GRACE_WINDOW_MS + 5000); // 30 seconds ago

    // Replay attack
    const { req: replayReq, res: replayRes, resData: replayData } = createMockReqRes({
      refreshToken: oldToken,
    });
    await handleRefresh(replayReq, replayRes);

    assert.strictEqual(replayData.statusCode, 401);
    assert.strictEqual(replayData.jsonData.code, 'AUTH_REPLAY_ATTACK_DETECTED');

    // Active token in compromised family is revoked
    const { req: checkReq, res: checkRes, resData: checkData } = createMockReqRes({
      refreshToken: activeToken,
    });
    await handleRefresh(checkReq, checkRes);
    assert.strictEqual(checkData.statusCode, 401);
  });

  // Test 15: Logout and Session Revocation
  await test('15. Logout: Revokes active session and rejects subsequent refresh attempts', async () => {
    const { req: loginReq, res: loginRes, resData: loginData } = createMockReqRes({
      email: testUserEmail,
      password: 'StrongPassword2026!',
    });
    await handleLogin(loginReq, loginRes);
    const token = loginData.jsonData.tokens.refreshToken;

    // Logout
    const { req: logoutReq, res: logoutRes, resData: logoutData } = createMockReqRes({
      refreshToken: token,
    });
    await handleLogout(logoutReq, logoutRes);
    assert.strictEqual(logoutData.statusCode, 200);
    assert.strictEqual(logoutData.jsonData.sessionRevoked, true);

    // Refresh rejected
    const { req: refReq, res: refRes, resData: refData } = createMockReqRes({
      refreshToken: token,
    });
    await handleRefresh(refReq, refRes);
    assert.strictEqual(refData.statusCode, 401);
  });

  console.log(`\n🎉 All ${passedTests}/${totalTests} Stage 2.8 Final Authentication Hardening tests PASSED successfully!\n`);
}

runAllTests().catch((err) => {
  console.error('\n💥 Test suite failed:', err);
  process.exit(1);
});
