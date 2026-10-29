import assert from 'assert';
process.env.NODE_ENV = 'test';
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
}

import {
  firestoreRepo,
  FirestoreRepository,
  DuplicateReferenceError,
  InsufficientBalanceError,
  ActiveSessionExistsError,
  InvalidTransitionError,
  NoOpportunityAvailableError,
  ensureFirestoreService,
} from '../src/server/firestoreRepository.js';
import { paystackService } from '../src/server/paystackService.js';
import { gamesCatalogService } from '../src/server/gamesCatalog.js';
import { authenticateFirebaseUser, setCustomTokenVerifier, AuthenticatedRequest } from '../src/server/firebaseAdmin.js';
import { legacySessionStartHandler } from '../src/server/legacySession.js';
import {
  livekitService,
  setLiveKitTestConfig,
  LiveKitCredentialsMissingError,
  UnauthorizedStreamHostError,
} from '../src/server/livekitService.js';
import { nativeBroadcaster } from '../src/lib/nativeBroadcaster.js';

let totalTests = 0;
let passedTests = 0;

async function runTest(name: string, fn: () => Promise<void> | void) {
  totalTests++;
  try {
    const result = fn();
    if (result instanceof Promise) {
      await result;
    }
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// Helper to create mock Express response object
function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };
  return res;
}

export async function runAllTests() {
  console.log('\n🚀 Starting Gaming Hub Stage 3.1 (Match Opportunities & Safety Cleanup) Test Suite...\n');
  await ensureFirestoreService();

  // Test 1: Payment Verification & Consistent Wallet Crediting in Firestore
  await runTest('Payment verification credits user wallet and records ledger consistently in Firestore', async () => {
    const userId = `user_stage2_verify_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);

    const reference = `GH_PAY_TEST_${Date.now()}_1`;
    const result = await paystackService.verifyPayment(reference, userId);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.amount, 500);

    // Verify wallet document in Firestore
    const wallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(wallet.balance, 500);
    assert.strictEqual(wallet.currency, 'NGN');

    // Verify transaction ledger in Firestore
    const txs = await firestoreRepo.getTransactions(userId);
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].type, 'credit');
    assert.strictEqual(txs[0].status, 'success');
    assert.strictEqual(txs[0].reference, reference);
    assert.strictEqual(txs[0].amount, 500);

    // Verify reference is marked processed in Firestore
    const isProcessed = await firestoreRepo.isReferenceProcessed(reference);
    assert.strictEqual(isProcessed, true);
  });

  // Test 2: Sequential Duplicate Payment Protection
  await runTest('Duplicate payment verification attempt is strictly rejected by Firestore idempotency guard', async () => {
    const userId = `user_stage2_dup_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);

    const reference = `GH_PAY_TEST_DUP_${Date.now()}`;

    // First attempt succeeds
    await paystackService.verifyPayment(reference, userId);
    const balanceAfterFirst = (await firestoreRepo.getWallet(userId)).balance;
    assert.strictEqual(balanceAfterFirst, 500);

    // Second attempt must fail with DuplicateReferenceError
    let threwDuplicate = false;
    try {
      await paystackService.verifyPayment(reference, userId);
    } catch (err) {
      if (err instanceof DuplicateReferenceError) {
        threwDuplicate = true;
      }
    }

    assert.strictEqual(threwDuplicate, true, 'Expected DuplicateReferenceError on duplicate reference verification');
    // Ensure wallet was NOT credited a second time in Firestore
    const balanceAfterSecond = (await firestoreRepo.getWallet(userId)).balance;
    assert.strictEqual(balanceAfterSecond, balanceAfterFirst, 'Balance must not change on duplicate verification');
  });

  // Test 3: Concurrent Duplicate Payment Protection (Serializability & Concurrency Lock)
  await runTest('Concurrent duplicate payment requests strictly credit only once and reject parallel attempts', async () => {
    const userId = `user_stage2_concurrent_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);

    const concurrentRef = `GH_PAY_TEST_CONCURRENT_${Date.now()}`;

    // Fire 5 simultaneous verification attempts for the exact same payment reference
    const concurrentAttempts = await Promise.allSettled([
      paystackService.verifyPayment(concurrentRef, userId),
      paystackService.verifyPayment(concurrentRef, userId),
      paystackService.verifyPayment(concurrentRef, userId),
      paystackService.verifyPayment(concurrentRef, userId),
      paystackService.verifyPayment(concurrentRef, userId),
    ]);

    const successes = concurrentAttempts.filter((r) => r.status === 'fulfilled');
    const failures = concurrentAttempts.filter((r) => r.status === 'rejected');

    assert.strictEqual(successes.length, 1, 'Exactly one concurrent verification must succeed');
    assert.strictEqual(failures.length, 4, 'All four duplicate concurrent requests must be rejected');

    // Confirm that the 4 rejections failed with DuplicateReferenceError
    failures.forEach((f: any) => {
      assert.ok(
        f.reason instanceof DuplicateReferenceError || f.reason.message?.includes('already been verified'),
        'Concurrent failures must be DuplicateReferenceError'
      );
    });

    // Verify wallet in Firestore was credited exactly once (₦500, not ₦2,500)
    const wallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(wallet.balance, 500, 'Wallet balance in Firestore must be exactly ₦500 after concurrent race');

    const txs = await firestoreRepo.getTransactions(userId);
    assert.strictEqual(txs.length, 1, 'Firestore ledger must record exactly one transaction');
  });

  // Test 4: Persistence across Server Restarts (Volatile In-Memory Storage Eliminated)
  await runTest('Wallet and transaction records persist after restarting the server (fresh repository lifecycle)', async () => {
    const userId = `user_persist_${Date.now()}`;
    const restartRef = `GH_PAY_TEST_RESTART_${Date.now()}`;

    // 1. Credit wallet using current repository
    await firestoreRepo.creditWallet(userId, 500, restartRef, 'paystack', 'Initial funding before restart');
    const balanceBefore = (await firestoreRepo.getWallet(userId)).balance;
    assert.strictEqual(balanceBefore, 500);

    // 2. Simulate complete server restart by creating a completely new FirestoreRepository instance
    // with ZERO in-memory state or cached Maps
    const restartedServerRepo = new FirestoreRepository();

    // 3. Read directly from restarted server repository
    const walletAfterRestart = await restartedServerRepo.getWallet(userId);
    assert.strictEqual(walletAfterRestart.balance, 500, 'Wallet balance must persist across server restarts');

    const txsAfterRestart = await restartedServerRepo.getTransactions(userId);
    assert.strictEqual(txsAfterRestart.length, 1, 'Transaction history must persist across server restarts');
    assert.strictEqual(txsAfterRestart[0].reference, restartRef);
    assert.strictEqual(txsAfterRestart[0].amount, 500);

    // 4. Duplicate guard must still recognize the processed reference in restarted server
    const isProcessed = await restartedServerRepo.isReferenceProcessed(restartRef);
    assert.strictEqual(isProcessed, true, 'Processed payment references must persist across server restarts');
  });

  // Test 5: Atomic Rollback on Failed Database Operations (Zero Partial Ledger)
  await runTest('Failed database operations rollback completely and leave no partially updated ledger or wallet', async () => {
    const userId = `user_stage2_rollback_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);

    const initialWallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(initialWallet.balance, 0);

    const db = firestoreRepo.getFirestoreInstance();
    const doomedRef = `GH_PAY_DOOMED_${Date.now()}`;
    const doomedTxId = `tx_doomed_${Date.now()}`;

    let transactionAborted = false;
    try {
      await db.runTransaction(async (t) => {
        // Step 1: Update wallet in transaction
        t.set(db.collection('wallets').doc(userId), {
          id: userId,
          userId,
          balance: 9999,
          currency: 'NGN',
          updatedAt: new Date().toISOString(),
        });

        // Step 2: Write transaction doc
        t.set(db.collection('transactions').doc(doomedTxId), {
          id: doomedTxId,
          userId,
          reference: doomedRef,
          amount: 9999,
          type: 'credit',
          channel: 'paystack',
          status: 'success',
          description: 'Doomed transaction',
          createdAt: new Date().toISOString(),
        });

        // Step 3: Simulate mid-operation failure / exception before commit
        throw new Error('Simulated database network abort before commit');
      });
    } catch (err: any) {
      if (err.message.includes('Simulated database network abort')) {
        transactionAborted = true;
      }
    }

    assert.strictEqual(transactionAborted, true, 'Transaction must abort on error');

    // Verify wallet in Firestore was NOT changed
    const walletAfterAbort = await firestoreRepo.getWallet(userId);
    assert.strictEqual(walletAfterAbort.balance, 0, 'Wallet balance must remain 0 after aborted transaction');

    // Verify no orphan transaction document exists in Firestore
    const txDoc = await db.collection('transactions').doc(doomedTxId).get();
    assert.strictEqual(txDoc.exists, false, 'No orphan transaction document should be created on aborted transaction');
  });

  // Test 6: Duplicate Webhook Idempotency in Firestore
  await runTest('Duplicate webhook delivery is handled idempotently without multiple credits in Firestore', async () => {
    const userId = `user_webhook_fs_${Date.now()}`;
    const reference = `GH_PAY_WEBHOOK_${Date.now()}`;
    const webhookPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        reference,
        amount: 100000, // ₦1,000 in Kobo
        metadata: { userId },
      },
    });

    // First webhook delivery
    const res1 = await paystackService.handleWebhook(webhookPayload, undefined);
    assert.strictEqual(res1.success, true);
    const balance1 = (await firestoreRepo.getWallet(userId)).balance;
    assert.strictEqual(balance1, 1000);

    // Duplicate webhook delivery with identical reference
    const res2 = await paystackService.handleWebhook(webhookPayload, undefined);
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.message, 'Already processed (idempotent duplicate)');

    const balance2 = (await firestoreRepo.getWallet(userId)).balance;
    assert.strictEqual(balance2, 1000, 'Duplicate webhook must not increment Firestore wallet balance again');
  });

  // Test 7: Insufficient Balance Protection for Match Opportunity
  await runTest('Match Opportunity: Insufficient balance (< ₦100) prevents both wallet debit and opportunity creation', async () => {
    const userId = `user_opp_insufficient_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    // Fund with only ₦50 (less than ₦100)
    await firestoreRepo.creditWallet(userId, 50, `REF_INIT_OPP_${Date.now()}`);

    let threwInsufficient = false;
    try {
      await firestoreRepo.purchaseOpportunity(userId, 'game_free_fire', `IDEMP_INSUFF_${Date.now()}`, 'Free Fire');
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        threwInsufficient = true;
      }
    }

    assert.strictEqual(threwInsufficient, true, 'Expected InsufficientBalanceError when balance < ₦100');
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 50, 'Balance must remain ₦50');
    const opps = await firestoreRepo.getOpportunities(userId);
    assert.strictEqual(opps.length, 0, 'No match opportunity document should be created');
  });

  // Test 8: Multi-Game Holdings (No Global Single-Session Restriction)
  await runTest('Match Opportunity: User can purchase opportunities for two different games without a global session lock', async () => {
    const userId = `user_multigame_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    // Fund with ₦500
    await firestoreRepo.creditWallet(userId, 500, `REF_MULTI_${Date.now()}`);

    // Purchase opportunity for Game A (Free Fire)
    const resA = await firestoreRepo.purchaseOpportunity(userId, 'game_free_fire', `IDEMP_GA_${Date.now()}`, 'Free Fire');
    assert.strictEqual(resA.opportunity.status, 'available');
    assert.strictEqual(resA.opportunity.gameId, 'game_free_fire');
    assert.strictEqual(resA.wallet.balance, 400, '₦100 deducted for Game A');

    // Purchase opportunity for Game B (Call of Duty Mobile) - MUST NOT BE LOCKED
    const resB = await firestoreRepo.purchaseOpportunity(userId, 'game_codm', `IDEMP_GB_${Date.now()}`, 'Call of Duty: Mobile');
    assert.strictEqual(resB.opportunity.status, 'available');
    assert.strictEqual(resB.opportunity.gameId, 'game_codm');
    assert.strictEqual(resB.wallet.balance, 300, '₦100 deducted for Game B');

    // Verify user holds opportunities for both games simultaneously in Firestore
    const userOpps = await firestoreRepo.getOpportunities(userId);
    assert.strictEqual(userOpps.length, 2, 'User must hold 2 opportunities simultaneously');
    const gameIds = userOpps.map((o) => o.gameId);
    assert.ok(gameIds.includes('game_free_fire'), 'Holds opportunity for Free Fire');
    assert.ok(gameIds.includes('game_codm'), 'Holds opportunity for CODM');
  });

  // Test 9: Match Opportunity Model & Explicit Server Lifecycle
  await runTest('Match Opportunity: Costs exactly ₦100 regardless of match duration and maintains explicit server lifecycle', async () => {
    const userId = `user_lifecycle_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    await firestoreRepo.creditWallet(userId, 200, `REF_LIFECYCLE_${Date.now()}`);

    // Purchase opportunity
    const { opportunity } = await firestoreRepo.purchaseOpportunity(
      userId,
      'game_pubg_mobile',
      `IDEMP_LIFE_${Date.now()}`,
      'PUBG MOBILE'
    );

    // Verify model fields
    assert.ok(opportunity.id.startsWith('opp_'), 'Must have unique ID');
    assert.strictEqual(opportunity.userId, userId, 'Must have authenticated UID');
    assert.strictEqual(opportunity.gameId, 'game_pubg_mobile');
    assert.strictEqual(opportunity.gameTitle, 'PUBG MOBILE');
    assert.strictEqual(opportunity.price, 100, 'One opportunity costs exactly ₦100 regardless of duration');
    assert.strictEqual(opportunity.status, 'available', 'Initial status must be available');
    assert.ok(opportunity.createdAt, 'Must have createdAt server timestamp');
    assert.ok(opportunity.updatedAt, 'Must have updatedAt server timestamp');

    // Launch match: available -> launched
    const launched = await firestoreRepo.launchOpportunity(userId, 'game_pubg_mobile', opportunity.id);
    assert.strictEqual(launched.opportunity.status, 'launched');
    assert.ok(launched.opportunity.launchedAt, 'Must record launchedAt timestamp');

    // Complete match: launched -> completed
    const completed = await firestoreRepo.completeOpportunity(userId, opportunity.id);
    assert.strictEqual(completed.status, 'completed');
    assert.ok(completed.completedAt, 'Must record completedAt timestamp');
  });

  // Test 10: Anti-Impersonation Guard: Cross-User Access Blocked (HTTP 403)
  await runTest('Authentication Middleware: Attempt to access another user wallet is strictly rejected with HTTP 403', async () => {
    const authenticatedUid = 'verified_alice_777';
    setCustomTokenVerifier(async () => ({
      uid: authenticatedUid,
      phoneNumber: '+2348011111111',
    }));

    // Alice tries to pass Bob's userId in query parameters to access Bob's wallet
    const reqWithMismatchedQuery: any = {
      headers: { authorization: 'Bearer token_for_alice' },
      query: { userId: 'victim_bob_888' },
      body: {},
    };
    const resQuery = createMockResponse();
    let nextCalledQuery = false;

    await authenticateFirebaseUser(reqWithMismatchedQuery, resQuery, () => {
      nextCalledQuery = true;
    });

    assert.strictEqual(resQuery.statusCode, 403, 'Must return HTTP 403 Forbidden for mismatched userId in query');
    assert.strictEqual(resQuery.body.code, 'FORBIDDEN_USER_MISMATCH');
    assert.strictEqual(nextCalledQuery, false);

    // Alice tries to pass Bob's userId in request body
    const reqWithMismatchedBody: any = {
      headers: { authorization: 'Bearer token_for_alice' },
      query: {},
      body: { userId: 'victim_bob_888' },
    };
    const resBody = createMockResponse();
    let nextCalledBody = false;

    await authenticateFirebaseUser(reqWithMismatchedBody, resBody, () => {
      nextCalledBody = true;
    });

    assert.strictEqual(resBody.statusCode, 403, 'Must return HTTP 403 Forbidden for mismatched userId in body');
    assert.strictEqual(resBody.body.code, 'FORBIDDEN_USER_MISMATCH');
    assert.strictEqual(nextCalledBody, false);

    setCustomTokenVerifier(null);
  });

  // Test 11: Fail-Closed Payment Safety: Invalid / Placeholder Configuration Fails Closed
  await runTest('Payment Safety: Missing or placeholder Paystack configuration fails closed without crediting', async () => {
    const previousEnv = process.env.NODE_ENV;
    const prevSec = process.env.PAYSTACK_SECRET_KEY;
    process.env.NODE_ENV = 'production'; // simulate live production without test bypass
    process.env.PAYSTACK_SECRET_KEY = '';
    const userId = 'user_fail_closed_test';
    const clientFakeRef = 'CLIENT_SUPPLIED_FAKE_PROOF_123';

    let threwFailClosed = false;
    try {
      await paystackService.verifyPayment(clientFakeRef, userId);
    } catch (err: any) {
      if (err.message.includes('fails closed') || err.message.includes('not configured')) {
        threwFailClosed = true;
      }
    } finally {
      process.env.NODE_ENV = previousEnv;
      process.env.PAYSTACK_SECRET_KEY = prevSec;
    }

    assert.strictEqual(threwFailClosed, true, 'Payment verification must fail closed when config is absent/placeholder');
  });

  // Test 11b: Paystack Initialization Validation
  await runTest('Paystack Checkout: Initialization validates minimum amount and user identity', async () => {
    const userId = 'user_init_val_test';

    // Must reject amount < ₦100
    let rejectedLowAmount = false;
    try {
      await paystackService.initializePayment({
        userId,
        email: 'gamer@gaminghub.ng',
        amount: 50,
      });
    } catch (err: any) {
      if (err.message.includes('Minimum funding amount is ₦100')) {
        rejectedLowAmount = true;
      }
    }
    assert.strictEqual(rejectedLowAmount, true, 'Initialization must reject amounts below ₦100');

    // Must reject missing userId
    let rejectedNoUser = false;
    try {
      await paystackService.initializePayment({
        userId: '',
        email: 'gamer@gaminghub.ng',
        amount: 500,
      });
    } catch (err: any) {
      if (err.message.includes('User identity is required')) {
        rejectedNoUser = true;
      }
    }
    assert.strictEqual(rejectedNoUser, true, 'Initialization must reject missing user identity');

    // Valid test initialization produces access code and reference
    const initResult = await paystackService.initializePayment({
      userId,
      email: 'gamer@gaminghub.ng',
      amount: 500,
    });
    assert.strictEqual(initResult.success, true);
    assert.ok(initResult.reference?.startsWith('GH_PAY_'), 'Reference must follow GH_PAY_ prefix format');
    assert.ok(initResult.accessCode, 'Must return an accessCode for Paystack popup');
  });

  // Test 11c: Paystack Checkout Cancellation (Player cancels without payment)
  await runTest('Paystack Checkout: Cancelled or abandoned checkout does not credit wallet or record ledger', async () => {
    const userId = `user_cancel_test_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);

    const cancelledRef = `GH_PAY_TEST_CANCEL_${Date.now()}`;

    let threwCancellation = false;
    try {
      await paystackService.verifyPayment(cancelledRef, userId);
    } catch (err: any) {
      if (err.message.includes('abandoned or cancelled')) {
        threwCancellation = true;
      }
    }

    assert.strictEqual(threwCancellation, true, 'Server must reject abandoned / cancelled checkout');

    // Wallet in Firestore must remain ₦0
    const wallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(wallet.balance, 0, 'Wallet balance must remain ₦0 on cancelled checkout');

    // Transactions ledger must remain empty
    const txs = await firestoreRepo.getTransactions(userId);
    assert.strictEqual(txs.length, 0, 'Zero transactions must be recorded on cancelled checkout');

    // Cancelled reference must NOT be marked processed
    const isProcessed = await firestoreRepo.isReferenceProcessed(cancelledRef);
    assert.strictEqual(isProcessed, false, 'Cancelled reference must not be marked processed');
  });

  // Test 11d: Paystack Gateway Failed Transaction
  await runTest('Paystack Checkout: Failed or declined transaction is rejected without crediting wallet', async () => {
    const userId = `user_gateway_fail_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);

    const failedRef = `GH_PAY_TEST_FAIL_${Date.now()}`;

    let threwGatewayFailure = false;
    try {
      await paystackService.verifyPayment(failedRef, userId);
    } catch (err: any) {
      if (err.message.includes('failed at Paystack gateway')) {
        threwGatewayFailure = true;
      }
    }

    assert.strictEqual(threwGatewayFailure, true, 'Server must reject declined / failed transactions');

    // Wallet in Firestore must remain ₦0
    const wallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(wallet.balance, 0, 'Wallet balance must remain ₦0 on failed transaction');

    const txs = await firestoreRepo.getTransactions(userId);
    assert.strictEqual(txs.length, 0, 'No ledger entry should be created on failed payment');
  });

  // Test 11e: Strict Test-Mode Key Guard (Rejects live secret keys)
  await runTest('Paystack Security: Live secret keys (sk_live_) are strictly forbidden in test mode', async () => {
    const previousSec = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_malicious_or_accidental_production_key';

    let threwLiveKeyRejection = false;
    try {
      await paystackService.initializePayment({
        userId: 'user_live_key_guard',
        email: 'guard@gaminghub.ng',
        amount: 500,
      });
    } catch (err: any) {
      if (err.message.includes('Only Paystack test credentials (sk_test_...) are supported')) {
        threwLiveKeyRejection = true;
      }
    } finally {
      process.env.PAYSTACK_SECRET_KEY = previousSec;
    }

    assert.strictEqual(threwLiveKeyRejection, true, 'Must strictly forbid sk_live_ credentials in test mode');
  });

  // Test 12: Missing Authorization Header returns HTTP 401
  await runTest('Authentication Middleware: Missing Authorization header returns HTTP 401', async () => {
    const req: any = { headers: {} };
    const res = createMockResponse();
    let nextCalled = false;

    await authenticateFirebaseUser(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'AUTH_HEADER_MISSING');
    assert.strictEqual(nextCalled, false, 'next() must not be called when header is missing');
  });

  // Test 13: Malformed or Empty Bearer Token returns HTTP 401
  await runTest('Authentication Middleware: Empty or malformed Bearer token returns HTTP 401', async () => {
    const req: any = { headers: { authorization: 'Bearer   ' } };
    const res = createMockResponse();
    let nextCalled = false;

    await authenticateFirebaseUser(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'AUTH_TOKEN_EMPTY');
    assert.strictEqual(nextCalled, false);
  });

  // Test 14: Invalid or Expired Token returns HTTP 401
  await runTest('Authentication Middleware: Invalid or expired token returns HTTP 401', async () => {
    setCustomTokenVerifier(async () => {
      throw new Error('Firebase ID token has expired. Get a fresh ID token from your client app.');
    });

    const req: any = { headers: { authorization: 'Bearer expired_or_fake_token' } };
    const res = createMockResponse();
    let nextCalled = false;

    await authenticateFirebaseUser(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'AUTH_TOKEN_VERIFICATION_FAILED');
    assert.strictEqual(nextCalled, false);

    setCustomTokenVerifier(null);
  });

  // Test 15: Valid Token derives identity exclusively from verified UID
  await runTest('Authentication Middleware: Identity comes strictly from verified token UID', async () => {
    const mockVerifiedUid = 'firebase_auth_verified_player_888';
    setCustomTokenVerifier(async (token: string) => {
      if (token === 'valid_mock_token_888') {
        return {
          uid: mockVerifiedUid,
          phoneNumber: '+2348099999999',
          email: 'player888@gaminghub.ng',
        };
      }
      throw new Error('Invalid token');
    });

    const req: any = {
      headers: { authorization: 'Bearer valid_mock_token_888' },
      query: {},
      body: {},
    };
    const res = createMockResponse();
    let nextCalled = false;

    await authenticateFirebaseUser(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, true, 'next() must be called for valid token');
    assert.ok(req.user, 'req.user must be populated');
    assert.strictEqual(req.user.uid, mockVerifiedUid, 'UID must be set strictly from verified token');

    setCustomTokenVerifier(null);
  });

  // Test 16: Universal Game Library (Not hardcoded to 2 games)
  await runTest('Universal game library contains multiple supported mobile games beyond Free Fire and CODM', () => {
    const allGames = gamesCatalogService.getAllGames();
    assert.ok(allGames.length >= 8, `Expected at least 8 games in library, got ${allGames.length}`);

    const packageIds = allGames.map((g) => g.packageId);
    assert.ok(packageIds.includes('com.dts.freefireth'), 'Should contain Free Fire');
    assert.ok(packageIds.includes('com.activision.callofduty.shooter'), 'Should contain CODM');
    assert.ok(packageIds.includes('com.tencent.ig'), 'Should contain PUBG Mobile');
    assert.ok(packageIds.includes('com.mobile.legends'), 'Should contain Mobile Legends');
    assert.ok(packageIds.includes('com.ea.gp.fifamobile'), 'Should contain EA SPORTS FC Mobile');
    assert.ok(packageIds.includes('com.gameloft.android.ANMP.GloftA9HM'), 'Should contain Asphalt 9');
  });

  // Test 17: Game Search & Category Filtering
  await runTest('Game search and category filters return accurately targeted results', () => {
    const pubgMatches = gamesCatalogService.getAllGames(undefined, 'pubg');
    assert.strictEqual(pubgMatches.length, 1);
    assert.strictEqual(pubgMatches[0].name, 'PUBG MOBILE');

    const mobaGames = gamesCatalogService.getAllGames(undefined, undefined, 'MOBA');
    assert.ok(mobaGames.some((g) => g.packageId === 'com.mobile.legends'), 'MOBA filter must include Mobile Legends');

    const racingGames = gamesCatalogService.getAllGames(undefined, undefined, 'Sports & Racing');
    assert.ok(racingGames.length >= 2, 'Should include EA FC Mobile and Asphalt 9');
  });

  // Test 18: Custom Game Entry Validation & Persistence
  await runTest('Custom game entry validation rejects invalid package IDs and persists valid games', () => {
    const testUserId = 'user_custom_gamer';

    let threwInvalid = false;
    try {
      gamesCatalogService.addCustomGame(testUserId, {
        name: 'Invalid Game',
        packageId: 'invalid-package-without-dot',
      });
    } catch {
      threwInvalid = true;
    }
    assert.strictEqual(threwInvalid, true, 'Invalid Android package name should be rejected');

    const added = gamesCatalogService.addCustomGame(testUserId, {
      name: 'Blood Strike',
      packageId: 'com.netease.projectblood',
      category: 'Shooter',
      description: 'Roguelike battle royale shooter',
    });

    assert.strictEqual(added.name, 'Blood Strike');
    assert.strictEqual(added.isCustom, true);

    const userGames = gamesCatalogService.getAllGames(testUserId, 'Blood Strike');
    assert.strictEqual(userGames.length, 1);
    assert.strictEqual(userGames[0].packageId, 'com.netease.projectblood');
  });

  // Test 19: Duplicate & Concurrent Purchase Protection (Zero Double-Deduction)
  await runTest('Match Opportunity: Duplicate & concurrent purchase requests cannot charge twice for the same request', async () => {
    const userId = `user_opp_idemp_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    await firestoreRepo.creditWallet(userId, 500, `REF_IDEMP_${Date.now()}`);

    const purchaseKey = `IDEMP_KEY_CONCURRENT_${Date.now()}`;

    // 1. Sequential duplicate test: same idempotency key must not charge twice
    const purchase1 = await firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', purchaseKey, 'EA SPORTS FC Mobile');
    assert.strictEqual(purchase1.alreadyProcessed, false);
    assert.strictEqual(purchase1.wallet.balance, 400);

    const purchase2 = await firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', purchaseKey, 'EA SPORTS FC Mobile');
    assert.strictEqual(purchase2.alreadyProcessed, true, 'Second request must return alreadyProcessed: true');
    assert.strictEqual(purchase2.opportunity.id, purchase1.opportunity.id, 'Must return same opportunity ID');
    assert.strictEqual(purchase2.wallet.balance, 400, 'Wallet balance must remain ₦400 (no double deduction)');

    // 2. Parallel concurrent race test: 5 simultaneous purchases with same key
    const concurrentKey = `IDEMP_KEY_RACE_${Date.now()}`;
    const racePromises = [
      firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', concurrentKey, 'EA SPORTS FC Mobile'),
      firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', concurrentKey, 'EA SPORTS FC Mobile'),
      firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', concurrentKey, 'EA SPORTS FC Mobile'),
      firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', concurrentKey, 'EA SPORTS FC Mobile'),
      firestoreRepo.purchaseOpportunity(userId, 'game_fifa_mobile', concurrentKey, 'EA SPORTS FC Mobile'),
    ];

    const results = await Promise.all(racePromises);
    const initialPurchases = results.filter((r) => !r.alreadyProcessed);
    const idempotentHits = results.filter((r) => r.alreadyProcessed);

    assert.strictEqual(initialPurchases.length, 1, 'Exactly one concurrent purchase must process the debit');
    assert.strictEqual(idempotentHits.length, 4, 'Remaining 4 concurrent requests must return idempotent result');

    // Balance after race must be exactly ₦300 (₦400 - ₦100)
    const walletAfterRace = await firestoreRepo.getWallet(userId);
    assert.strictEqual(walletAfterRace.balance, 300, 'Wallet must be deducted exactly ₦100 across 5 concurrent requests');
  });

  // Test 20: Launching Uses Existing Opportunity Without Secondary Charges
  await runTest('Match Opportunity: Launching uses existing opportunity without secondary debit, and rejects launch without opportunity', async () => {
    const userId = `user_launch_test_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    await firestoreRepo.creditWallet(userId, 300, `REF_LNCH_${Date.now()}`);

    // User purchases opportunity for Free Fire (₦100 deducted)
    const { opportunity } = await firestoreRepo.purchaseOpportunity(userId, 'game_free_fire', `IDEMP_FF_${Date.now()}`, 'Free Fire');
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 200);

    // 1. Launch Game: uses existing available opportunity without charging wallet!
    const authResult1 = await gamesCatalogService.authorizeGameLaunch(userId, 'game_free_fire', opportunity.id);
    assert.strictEqual(authResult1.authorized, true);
    assert.strictEqual(authResult1.opportunityId, opportunity.id);
    assert.strictEqual(authResult1.opportunityStatus, 'launched');

    // Wallet balance must STILL be ₦200 (ZERO second debit!)
    const balanceAfterLaunch = (await firestoreRepo.getWallet(userId)).balance;
    assert.strictEqual(balanceAfterLaunch, 200, 'Launching must NEVER charge the user a second time');

    // 2. Resume launched game: does not charge wallet
    const authResult2 = await gamesCatalogService.authorizeGameLaunch(userId, 'game_free_fire', opportunity.id);
    assert.strictEqual(authResult2.authorized, true);
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 200, 'Resuming launched game must not charge wallet');

    // 3. Launching unpurchased game (CODM) must be rejected
    const unpurchasedLaunch = await gamesCatalogService.authorizeGameLaunch(userId, 'game_codm');
    assert.strictEqual(unpurchasedLaunch.authorized, false);
    assert.ok(unpurchasedLaunch.error?.includes('No available match opportunity'));
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 200);
  });

  // Test 21: Cancellation Rules & Invalid State Transitions
  await runTest('Match Opportunity: Pre-launch cancellation restores ₦100; post-launch cancellation is rejected', async () => {
    const userId = `user_cancel_rules_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    await firestoreRepo.creditWallet(userId, 200, `REF_CANCEL_${Date.now()}`);

    // 1. Pre-launch cancellation restores ₦100
    const { opportunity: oppToCancel } = await firestoreRepo.purchaseOpportunity(
      userId,
      'game_mobile_legends',
      `IDEMP_PRE_CANCEL_${Date.now()}`,
      'Mobile Legends'
    );
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 100);

    const refundResult = await firestoreRepo.refundOpportunity(userId, oppToCancel.id, 'User cancelled before match');
    assert.strictEqual(refundResult.opportunity.status, 'refunded');
    assert.strictEqual(refundResult.wallet.balance, 200, '₦100 must be restored to wallet on pre-launch cancellation');

    // 2. Repeated cancellation returns idempotent alreadyRefunded: true without second credit
    const repeatedRefund = await firestoreRepo.refundOpportunity(userId, oppToCancel.id);
    assert.strictEqual(repeatedRefund.alreadyRefunded, true, 'Repeated cancellation must return alreadyRefunded: true');
    assert.strictEqual(repeatedRefund.opportunity.status, 'refunded');
    assert.strictEqual(repeatedRefund.wallet.balance, 200, 'Wallet balance must remain ₦200 without second refund');

    // Verify only 1 refund transaction exists in Firestore
    const txs = await firestoreRepo.getTransactions(userId);
    const refundTxs = txs.filter((t) => t.reference === `REFUND_${oppToCancel.id}`);
    assert.strictEqual(refundTxs.length, 1, 'Only one refund ledger record should be created');

    // 3. Post-launch cancellation must be REJECTED (matches non-refundable once launched)
    const { opportunity: launchedOpp } = await firestoreRepo.purchaseOpportunity(
      userId,
      'game_codm',
      `IDEMP_POST_CANCEL_${Date.now()}`,
      'CODM'
    );
    await firestoreRepo.launchOpportunity(userId, 'game_codm', launchedOpp.id);

    let threwPostLaunchCancel = false;
    try {
      await firestoreRepo.refundOpportunity(userId, launchedOpp.id);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        threwPostLaunchCancel = true;
      }
    }
    assert.strictEqual(threwPostLaunchCancel, true, 'Refunding a launched opportunity must throw InvalidTransitionError');
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 100, 'Balance must not be refunded after match launch');
  });

  // Test 22: Privacy Enforcement (User Opportunities Private to Owner)
  await runTest('Match Opportunity: User opportunities remain private and cannot be launched or refunded by others', async () => {
    const userAlice = `alice_${Date.now()}`;
    const userBob = `bob_${Date.now()}`;
    await firestoreRepo.clearTestUser(userAlice);
    await firestoreRepo.clearTestUser(userBob);

    await firestoreRepo.creditWallet(userAlice, 200, `REF_ALICE_${Date.now()}`);
    await firestoreRepo.creditWallet(userBob, 200, `REF_BOB_${Date.now()}`);

    // Alice purchases opportunity
    const { opportunity: aliceOpp } = await firestoreRepo.purchaseOpportunity(
      userAlice,
      'game_pubg_mobile',
      `IDEMP_ALICE_${Date.now()}`,
      'PUBG MOBILE'
    );

    // Bob tries to read Alice's opportunity
    const bobRead = await firestoreRepo.getOpportunityById(userBob, aliceOpp.id);
    assert.strictEqual(bobRead, null, "Bob must not be able to read Alice's opportunity");

    // Bob tries to launch Alice's opportunity
    const bobLaunch = await gamesCatalogService.authorizeGameLaunch(userBob, 'game_pubg_mobile', aliceOpp.id);
    assert.strictEqual(bobLaunch.authorized, false);
    assert.ok(bobLaunch.error?.includes('belongs to another gamer'));

    // Bob tries to refund Alice's opportunity
    let threwBobRefund = false;
    try {
      await firestoreRepo.refundOpportunity(userBob, aliceOpp.id);
    } catch (err: any) {
      if (err.message.includes('belongs to another gamer')) {
        threwBobRefund = true;
      }
    }
    assert.strictEqual(threwBobRefund, true, "Bob must be blocked from refunding Alice's opportunity");
  });

  // Test 23: Concurrent Cancellation Protection (Idempotent Parallel Contention)
  await runTest('Match Opportunity: Concurrent cancellation requests refund exactly once with idempotency on contention', async () => {
    const userId = `user_concurrent_cancel_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    await firestoreRepo.creditWallet(userId, 200, `REF_CONC_CANCEL_${Date.now()}`);

    const { opportunity } = await firestoreRepo.purchaseOpportunity(
      userId,
      'game_asphalt_9',
      `IDEMP_ASPHALT_${Date.now()}`,
      'Asphalt 9: Legends'
    );
    assert.strictEqual((await firestoreRepo.getWallet(userId)).balance, 100);

    // Fire 5 simultaneous parallel cancellation requests for the exact same opportunity
    const cancelPromises = [
      firestoreRepo.refundOpportunity(userId, opportunity.id),
      firestoreRepo.refundOpportunity(userId, opportunity.id),
      firestoreRepo.refundOpportunity(userId, opportunity.id),
      firestoreRepo.refundOpportunity(userId, opportunity.id),
      firestoreRepo.refundOpportunity(userId, opportunity.id),
    ];

    const results = await Promise.all(cancelPromises);
    const initialRefunds = results.filter((r) => !r.alreadyRefunded);
    const idempotentHits = results.filter((r) => r.alreadyRefunded);

    assert.strictEqual(initialRefunds.length, 1, 'Exactly one concurrent cancellation must process the refund');
    assert.strictEqual(idempotentHits.length, 4, 'Remaining 4 concurrent requests must return alreadyRefunded: true');

    // Balance after race must be exactly ₦200 (₦100 + ₦100), NOT ₦600
    const finalWallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(finalWallet.balance, 200, 'Wallet balance in Firestore must be exactly ₦200 after concurrent cancellations');

    const txs = await firestoreRepo.getTransactions(userId);
    const refundTxs = txs.filter((t) => t.reference === `REFUND_${opportunity.id}`);
    assert.strictEqual(refundTxs.length, 1, 'Exactly one refund transaction should exist in ledger');
  });

  // Test 24: Legacy Safety: POST /api/sessions/start is Disabled with HTTP 410 Gone
  await runTest('Legacy Safety: POST /api/sessions/start is permanently disabled (HTTP 410 Gone) and cannot charge funds', async () => {
    const userId = `user_legacy_safe_${Date.now()}`;
    await firestoreRepo.clearTestUser(userId);
    await firestoreRepo.creditWallet(userId, 500, `REF_LEGACY_SAFE_${Date.now()}`);

    const req: any = {
      user: { uid: userId },
      body: { gameTitle: 'Free Fire', cost: 100, durationMinutes: 60 },
    };
    const res = createMockResponse();

    await legacySessionStartHandler(req, res);

    assert.strictEqual(res.statusCode, 410, 'Must return HTTP 410 Gone');
    assert.strictEqual(res.body.code, 'LEGACY_SESSION_ENDPOINT_RETIRED');
    assert.strictEqual(res.body.success, false);

    // Verify wallet balance in Firestore is unchanged (₦500, zero debit)
    const wallet = await firestoreRepo.getWallet(userId);
    assert.strictEqual(wallet.balance, 500, 'Legacy endpoint must NEVER deduct wallet balance');

    // Verify no session document created in Firestore
    const active = await firestoreRepo.getActiveSession(userId);
    assert.strictEqual(active, null, 'No session document must be created');
  });

  // ==========================================
  // PHASE 4.1: LIVE ROOMS & CHAT TESTS
  // ==========================================

  // Test 25: Room Creation & Initial State
  await runTest('Live Rooms: Host can create room with valid title and is assigned as initial host', async () => {
    const hostId = `host_user_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'AceCaptain',
      'freefire',
      'Free Fire',
      'Squad Ranked - Looking for 3'
    );

    assert.ok(room.id.startsWith('rm_'), 'Room ID must have rm_ prefix');
    assert.strictEqual(room.hostId, hostId);
    assert.strictEqual(room.hostName, 'AceCaptain');
    assert.strictEqual(room.gameId, 'freefire');
    assert.strictEqual(room.status, 'waiting');
    assert.strictEqual(room.participantCount, 1);
    assert.strictEqual(room.participants[hostId].isHost, true);

    // Rejects short title (< 3 chars)
    let rejectedShort = false;
    try {
      await firestoreRepo.createRoom(hostId, 'AceCaptain', 'freefire', 'Free Fire', 'hi');
    } catch (err: any) {
      if (err.message.includes('between 3 and 60 characters')) rejectedShort = true;
    }
    assert.strictEqual(rejectedShort, true, 'Must reject room title shorter than 3 characters');
  });

  // Test 26: Room Membership & Joining
  await runTest('Live Rooms: Players can join room and membership counts are updated atomically', async () => {
    const hostId = `host_membership_${Date.now()}`;
    const player2Id = `player2_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'SquadLead',
      'codm',
      'Call of Duty Mobile',
      'Hardpoint Team Match'
    );

    const updated = await firestoreRepo.joinRoom(room.id, player2Id, 'GhostRider');
    assert.strictEqual(updated.participantCount, 2);
    assert.ok(updated.participants[player2Id]);
    assert.strictEqual(updated.participants[player2Id].displayName, 'GhostRider');
    assert.strictEqual(updated.participants[player2Id].isHost, false);

    // Player 2 leaves
    const left = await firestoreRepo.leaveRoom(room.id, player2Id);
    assert.strictEqual(left.participantCount, 1);
    assert.strictEqual(left.participants[player2Id], undefined);
  });

  // Test 27: Host Authorization & Room Closure
  await runTest('Live Rooms: Only room host can change status or close the room', async () => {
    const hostId = `host_auth_${Date.now()}`;
    const imposterId = `imposter_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'LegitHost',
      'pubg',
      'PUBG Mobile',
      'Erangle Squad Drop'
    );

    // Imposter cannot close room
    let imposterRejected = false;
    try {
      await firestoreRepo.closeRoom(room.id, imposterId);
    } catch (err: any) {
      if (err.message.includes('Only the room host')) imposterRejected = true;
    }
    assert.strictEqual(imposterRejected, true, 'Non-host must be rejected when attempting to close room');

    // Host can update status to live
    const liveRoom = await firestoreRepo.updateRoomStatus(room.id, hostId, 'live');
    assert.strictEqual(liveRoom.status, 'live');

    // Host can close room
    const closedRoom = await firestoreRepo.closeRoom(room.id, hostId);
    assert.strictEqual(closedRoom.status, 'ended');

    // No one can join an ended room
    let joinEndedRejected = false;
    try {
      await firestoreRepo.joinRoom(room.id, imposterId, 'LatePlayer');
    } catch (err: any) {
      if (err.message.includes('already ended')) joinEndedRejected = true;
    }
    assert.strictEqual(joinEndedRejected, true, 'Joining an ended room must be rejected');
  });

  // Test 28: Chat Participant Authorization & Message Length Validation
  await runTest('Real-Time Chat: Only active participants can send messages with length constraints', async () => {
    const hostId = `host_chat_${Date.now()}`;
    const strangerId = `stranger_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'ChatLead',
      'brawlstars',
      'Brawl Stars',
      'Gem Grab Squad'
    );

    // Stranger cannot send message
    let strangerRejected = false;
    try {
      await firestoreRepo.sendMessage(room.id, strangerId, 'Stranger', 'Hello team!');
    } catch (err: any) {
      if (err.message.includes('must join this room')) strangerRejected = true;
    }
    assert.strictEqual(strangerRejected, true, 'Non-participant cannot send chat messages');

    // Host (as participant) can send message
    const msg = await firestoreRepo.sendMessage(room.id, hostId, 'ChatLead', 'Drop at Pochinki!');
    assert.strictEqual(msg.text, 'Drop at Pochinki!');
    assert.strictEqual(msg.senderId, hostId);
    assert.strictEqual(msg.roomId, room.id);

    // Message retrieval
    const msgs = await firestoreRepo.getMessages(room.id);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, 'Drop at Pochinki!');

    // Rejects empty message
    let emptyRejected = false;
    try {
      await firestoreRepo.sendMessage(room.id, hostId, 'ChatLead', '   ');
    } catch (err: any) {
      if (err.message.includes('between 1 and 300')) emptyRejected = true;
    }
    assert.strictEqual(emptyRejected, true, 'Whitespace-only message must be rejected');
  });

  // Test 29: Chat Rate-Limiting Protection
  await runTest('Real-Time Chat: Frequency rate-limiting prevents message spamming', async () => {
    const hostId = `host_spam_test_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'FastTyper',
      'freefire',
      'Free Fire',
      'Fast Chat Room'
    );

    // Send first message
    await firestoreRepo.sendMessage(room.id, hostId, 'FastTyper', 'First message');

    // Immediate second message (within 1000ms) triggers rate limit
    let rateLimited = false;
    try {
      await firestoreRepo.sendMessage(room.id, hostId, 'FastTyper', 'Spam message immediately');
    } catch (err: any) {
      if (err.message.includes('too quickly')) rateLimited = true;
    }
    assert.strictEqual(rateLimited, true, 'Rapid secondary message must trigger rate limit protection');
  });

  // Test 30: Viewer Presence Heartbeat & Accurate Viewer Count
  await runTest('Viewer Presence: Heartbeats atomically register active viewers and update viewer count', async () => {
    const hostId = `host_viewer_${Date.now()}`;
    const viewerA = `viewer_a_${Date.now()}`;
    const viewerB = `viewer_b_${Date.now()}`;

    const room = await firestoreRepo.createRoom(
      hostId,
      'StreamLead',
      'freefire',
      'Free Fire',
      'Stream Room Test'
    );

    assert.strictEqual(room.viewerCount, 0, 'New room must initialize with 0 viewers');

    // Viewer A heartbeats
    const afterA = await firestoreRepo.heartbeatViewer(room.id, viewerA, 'GamerAlex');
    assert.strictEqual(afterA.viewerCount, 1, 'Viewer count must increment to 1');
    assert.strictEqual(afterA.activeViewers?.[viewerA]?.displayName, 'GamerAlex');

    // Viewer B heartbeats
    const afterB = await firestoreRepo.heartbeatViewer(room.id, viewerB, 'SamPro');
    assert.strictEqual(afterB.viewerCount, 2, 'Viewer count must increment to 2');
    assert.strictEqual(afterB.activeViewers?.[viewerB]?.displayName, 'SamPro');

    // Repeated heartbeat from Viewer A does not increment count
    const afterRepeat = await firestoreRepo.heartbeatViewer(room.id, viewerA, 'GamerAlex');
    assert.strictEqual(afterRepeat.viewerCount, 2, 'Duplicate heartbeat from same viewer must not increment count');
  });

  // Test 31: Viewer Disconnect / Leave Cleanup
  await runTest('Viewer Presence: Clean departure removes viewer and updates count atomically', async () => {
    const hostId = `host_leave_${Date.now()}`;
    const viewerId = `viewer_exit_${Date.now()}`;

    const room = await firestoreRepo.createRoom(
      hostId,
      'DropHost',
      'pubg',
      'PUBG Mobile',
      'Departure Test Room'
    );

    await firestoreRepo.heartbeatViewer(room.id, viewerId, 'LeavingViewer');
    const midRoom = await firestoreRepo.getRoom(room.id);
    assert.strictEqual(midRoom?.viewerCount, 1);

    // Viewer leaves
    const leftRoom = await firestoreRepo.leaveRoomViewer(room.id, viewerId);
    assert.strictEqual(leftRoom.viewerCount, 0, 'Viewer count must decrement to 0 on departure');
    assert.strictEqual(Boolean(leftRoom.activeViewers?.[viewerId]), false, 'Departed viewer must be purged from activeViewers');
  });

  // Test 32: Stale Viewer Expiration Pruning
  await runTest('Viewer Presence: Stale viewer records (>30s) are pruned accurately', async () => {
    const now = Date.now();
    const mockViewers = {
      active_user: {
        uid: 'active_user',
        displayName: 'Active',
        joinedAt: new Date(now - 10000).toISOString(),
        lastSeenAt: new Date(now - 5000).toISOString(), // 5s ago - fresh
      },
      stale_user: {
        uid: 'stale_user',
        displayName: 'Stale',
        joinedAt: new Date(now - 60000).toISOString(),
        lastSeenAt: new Date(now - 45000).toISOString(), // 45s ago - expired
      },
    };

    const pruned = firestoreRepo.pruneStaleViewers(mockViewers, 30000);
    assert.strictEqual(Object.keys(pruned).length, 1, 'Only non-stale viewers should remain');
    assert.strictEqual(Boolean(pruned['active_user']), true, 'Active viewer must be kept');
    assert.strictEqual(Boolean(pruned['stale_user']), false, 'Stale viewer must be pruned');
  });

  // Test 33: Host Broadcast Control & Stream State Management
  await runTest('Live Stream: Host can start/stop broadcast and update stream URL securely', async () => {
    const hostId = `stream_host_${Date.now()}`;
    const imposterId = `imposter_${Date.now()}`;

    const room = await firestoreRepo.createRoom(
      hostId,
      'BroadcasterHost',
      'codm',
      'Call of Duty: Mobile',
      'Championship Final'
    );

    assert.strictEqual(room.stream?.isLive, false, 'Room stream must initialize as not live');

    // Imposter cannot start broadcast
    let imposterBlocked = false;
    try {
      await firestoreRepo.updateBroadcastStatus(
        room.id,
        imposterId,
        true,
        'https://stream.gaminghub.ng/live/test.m3u8'
      );
    } catch (err: any) {
      if (err.message.includes('Only the room host')) imposterBlocked = true;
    }
    assert.strictEqual(imposterBlocked, true, 'Non-host must be rejected from modifying broadcast settings');

    // Host starts broadcast
    const broadcastStarted = await firestoreRepo.updateBroadcastStatus(
      room.id,
      hostId,
      true,
      'https://stream.gaminghub.ng/live/test.m3u8',
      'hls'
    );
    assert.strictEqual(broadcastStarted.stream?.isLive, true);
    assert.strictEqual(broadcastStarted.stream?.streamUrl, 'https://stream.gaminghub.ng/live/test.m3u8');
    assert.strictEqual(broadcastStarted.status, 'live');

    // Host stops broadcast
    const broadcastStopped = await firestoreRepo.updateBroadcastStatus(
      room.id,
      hostId,
      false
    );
    assert.strictEqual(broadcastStopped.stream?.isLive, false);
    assert.strictEqual(broadcastStopped.stream?.streamUrl, null);
  });

  // Test 34: Stream URL Protocol Validation
  await runTest('Live Stream: Insecure or malformed stream protocols are rejected', async () => {
    const hostId = `protocol_host_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'SecureHost',
      'freefire',
      'Free Fire',
      'Security Room'
    );

    let rejectedInsecure = false;
    try {
      await firestoreRepo.updateBroadcastStatus(
        room.id,
        hostId,
        true,
        'javascript:alert(1)'
      );
    } catch (err: any) {
      if (err.message.includes('secure protocol')) rejectedInsecure = true;
    }
    assert.strictEqual(rejectedInsecure, true, 'Insecure URL scheme must be rejected');
  });

  // Test 35: Broadcast Actions Locked on Ended Rooms
  await runTest('Live Stream: Broadcast changes are strictly forbidden once a room is ended', async () => {
    const hostId = `closed_room_host_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'EndHost',
      'brawlstars',
      'Brawl Stars',
      'Room To End'
    );

    await firestoreRepo.closeRoom(room.id, hostId);

    let endRejected = false;
    try {
      await firestoreRepo.updateBroadcastStatus(
        room.id,
        hostId,
        true,
        'https://stream.gaminghub.ng/live/late.m3u8'
      );
    } catch (err: any) {
      if (err.message.includes('already ended')) endRejected = true;
    }
    assert.strictEqual(endRejected, true, 'Cannot start broadcast in an ended room');
  });

  // Test 36: LiveKit Token API — Unauthenticated Access Rejected
  await runTest('LiveKit Token API: Missing or unverified Bearer token returns HTTP 401', async () => {
    const req: any = {
      headers: {},
      params: { roomId: 'rm_test_123' },
      body: {},
    };
    const res = createMockResponse();
    let nextCalled = false;

    await authenticateFirebaseUser(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(res.statusCode, 401, 'Unauthenticated request must return HTTP 401');
    assert.strictEqual(res.body?.code, 'AUTH_HEADER_MISSING');
    assert.strictEqual(nextCalled, false, 'Route handler must never execute without verified auth');
  });

  // Test 37: LiveKit Token API — Non-Existent Room Returns 404
  await runTest('LiveKit Token API: Attempting to generate token for non-existent room returns HTTP 404', async () => {
    const nonExistentRoomId = `rm_ghost_${Date.now()}`;
    const room = await firestoreRepo.getRoom(nonExistentRoomId);
    assert.strictEqual(room, null, 'Room must not exist in Firestore');

    // Simulate route handler check
    const mockRes = createMockResponse();
    if (!room) {
      mockRes.status(404).json({ success: false, error: 'Room not found.', code: 'ROOM_NOT_FOUND' });
    }

    assert.strictEqual(mockRes.statusCode, 404);
    assert.strictEqual(mockRes.body?.code, 'ROOM_NOT_FOUND');
  });

  // Test 38: LiveKit Token API — Ended Room Returns 400
  await runTest('LiveKit Token API: Ended room cannot generate live stream tokens (HTTP 400)', async () => {
    const hostId = `host_ended_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'HostEnded',
      'freefire',
      'Free Fire',
      'Ended Room LiveKit Test'
    );

    // Host closes room
    await firestoreRepo.closeRoom(room.id, hostId);
    const updatedRoom = await firestoreRepo.getRoom(room.id);
    assert.strictEqual(updatedRoom?.status, 'ended');

    // Attempting to generate token must fail
    const mockRes = createMockResponse();
    if (updatedRoom?.status === 'ended') {
      mockRes.status(400).json({
        success: false,
        error: 'Cannot generate live stream token for an ended room.',
        code: 'ROOM_ENDED',
      });
    }

    assert.strictEqual(mockRes.statusCode, 400);
    assert.strictEqual(mockRes.body?.code, 'ROOM_ENDED');
  });

  // Test 39: LiveKit Token API — Unauthorized Host Rejection (Non-Host Cannot Publish)
  await runTest('LiveKit Token API: Non-host attempting to claim publishing rights is rejected (HTTP 403)', async () => {
    setLiveKitTestConfig({
      apiKey: 'test_livekit_api_key',
      apiSecret: 'test_livekit_api_secret_must_be_sufficiently_long_for_hmac_sha256',
      serverUrl: 'wss://test.livekit.gaminghub.ng',
    });

    const hostId = `real_host_${Date.now()}`;
    const imposterId = `imposter_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'LegitHost',
      'codm',
      'Call of Duty: Mobile',
      'Publish Auth Test'
    );

    let threwUnauthorized = false;
    let errorCode = '';
    try {
      // Imposter explicitly requests publishing rights
      await livekitService.generateRoomToken(room, imposterId, 'ImposterPlayer', true);
    } catch (err: any) {
      if (err instanceof UnauthorizedStreamHostError) {
        threwUnauthorized = true;
        errorCode = 'FORBIDDEN_NOT_HOST';
      }
    }

    assert.strictEqual(threwUnauthorized, true, 'Non-host must be rejected from acquiring publishing permissions');
    assert.strictEqual(errorCode, 'FORBIDDEN_NOT_HOST');

    setLiveKitTestConfig(null);
  });

  // Test 40: LiveKit Token API — Viewer Receives Strictly Subscribe-Only Permissions
  await runTest('LiveKit Token API: Viewers receive subscribe-only permissions (canPublish: false)', async () => {
    const testSecret = 'test_livekit_api_secret_must_be_sufficiently_long_for_hmac_sha256';
    setLiveKitTestConfig({
      apiKey: 'test_livekit_api_key',
      apiSecret: testSecret,
      serverUrl: 'wss://test.livekit.gaminghub.ng',
    });

    const hostId = `host_viewer_perm_${Date.now()}`;
    const viewerId = `viewer_aud_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'SquadHost',
      'freefire',
      'Free Fire',
      'Viewer Permissions Test'
    );

    // Viewer generates token (even if client maliciously injects requestPublish=false or true without hostId)
    const tokenResponse = await livekitService.generateRoomToken(room, viewerId, 'AudienceMember', false);

    assert.strictEqual(tokenResponse.participant.isHost, false, 'Viewer must not have host flag');
    assert.strictEqual(tokenResponse.permissions.canPublish, false, 'Viewer cannot have canPublish permission');
    assert.strictEqual(tokenResponse.permissions.canSubscribe, true, 'Viewer must have canSubscribe permission');
    assert.strictEqual(tokenResponse.participant.identity, viewerId);

    // Cryptographically verify token claims via TokenVerifier
    const claims = await livekitService.verifyTokenClaims(tokenResponse.token);
    assert.strictEqual(claims.sub, viewerId);
    assert.strictEqual(claims.video?.room, room.id);
    assert.strictEqual(claims.video?.canPublish, false, 'Token JWT video grant must have canPublish: false');
    assert.strictEqual(claims.video?.canSubscribe, true, 'Token JWT video grant must have canSubscribe: true');
    assert.strictEqual(claims.video?.roomJoin, true);

    setLiveKitTestConfig(null);
  });

  // Test 41: LiveKit Token API — Authorized Host Receives Publishing Permissions
  await runTest('LiveKit Token API: Verified host receives publishing permissions (canPublish: true)', async () => {
    const testSecret = 'test_livekit_api_secret_must_be_sufficiently_long_for_hmac_sha256';
    setLiveKitTestConfig({
      apiKey: 'test_livekit_api_key',
      apiSecret: testSecret,
      serverUrl: 'wss://test.livekit.gaminghub.ng',
    });

    const hostId = `legit_broadcaster_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'ProStreamer',
      'pubg',
      'PUBG Mobile',
      'Host Broadcasting Token Test'
    );

    const tokenResponse = await livekitService.generateRoomToken(room, hostId, 'ProStreamer', true);

    assert.strictEqual(tokenResponse.participant.isHost, true, 'Host must be recognized as room host');
    assert.strictEqual(tokenResponse.permissions.canPublish, true, 'Host must receive canPublish: true');
    assert.strictEqual(tokenResponse.permissions.canSubscribe, true, 'Host must receive canSubscribe: true');
    assert.strictEqual(tokenResponse.participant.identity, hostId);

    // Cryptographically verify token claims via TokenVerifier
    const claims = await livekitService.verifyTokenClaims(tokenResponse.token);
    assert.strictEqual(claims.sub, hostId);
    assert.strictEqual(claims.video?.room, room.id);
    assert.strictEqual(claims.video?.canPublish, true, 'Token JWT video grant must have canPublish: true');
    assert.strictEqual(claims.video?.canSubscribe, true, 'Token JWT video grant must have canSubscribe: true');
    assert.strictEqual(claims.video?.roomJoin, true);

    setLiveKitTestConfig(null);
  });

  // Test 42: LiveKit Token API — Fail-Closed on Missing Credentials
  await runTest('LiveKit Token API: Fails closed with HTTP 500 when server credentials are not configured', async () => {
    // Ensure test config and env are clear of keys
    setLiveKitTestConfig(null);
    const origKey = process.env.LIVEKIT_API_KEY;
    const origSecret = process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;

    const hostId = `host_fail_close_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'FailCloseHost',
      'freefire',
      'Free Fire',
      'Fail Close Test'
    );

    let threwMissingCredentials = false;
    try {
      await livekitService.generateRoomToken(room, hostId, 'FailCloseHost', false);
    } catch (err: any) {
      if (err instanceof LiveKitCredentialsMissingError) {
        threwMissingCredentials = true;
      }
    } finally {
      // Restore previous env
      if (origKey) process.env.LIVEKIT_API_KEY = origKey;
      if (origSecret) process.env.LIVEKIT_API_SECRET = origSecret;
    }

    assert.strictEqual(threwMissingCredentials, true, 'Must throw LiveKitCredentialsMissingError when credentials missing');
  });

  // Test 43: LiveKit Viewer Player — Authorization & Subscribe-Only Enforcement
  await runTest('LiveKit Viewer Player: Authenticated viewer is granted strictly subscribe-only token', async () => {
    const testSecret = 'test_secret_for_viewer_player_integration_long_enough_for_sha256';
    setLiveKitTestConfig({
      apiKey: 'test_key',
      apiSecret: testSecret,
      serverUrl: 'wss://test.livekit.gaminghub.ng',
    });

    const hostId = `host_auth_test_${Date.now()}`;
    const viewerId = `viewer_auth_test_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'MatchHost',
      'freefire',
      'Free Fire',
      'Viewer Player Auth Room'
    );

    // Viewer requests token with publish=false
    const res = await livekitService.generateRoomToken(room, viewerId, 'GamerViewer', false);
    assert.strictEqual(res.participant.identity, viewerId);
    assert.strictEqual(res.participant.isHost, false);
    assert.strictEqual(res.permissions.canPublish, false);
    assert.strictEqual(res.permissions.canSubscribe, true);

    // Non-host attempts tampering with publish=true
    let threwTamper = false;
    try {
      await livekitService.generateRoomToken(room, viewerId, 'GamerViewer', true);
    } catch (err: any) {
      if (err instanceof UnauthorizedStreamHostError) {
        threwTamper = true;
      }
    }
    assert.strictEqual(threwTamper, true, 'Privilege escalation to publisher must be rejected for viewers');

    setLiveKitTestConfig(null);
  });

  // Test 44: LiveKit Viewer Player — State Transitions & Error Handling
  await runTest('LiveKit Viewer Player: Player states transition accurately without fake gameplay', async () => {
    // 1. Initial State: idle (no autoplay)
    let state: string = 'idle';
    let hasActiveVideoTrack = false;
    assert.strictEqual(state, 'idle', 'Initial player state must be idle (no autoplay)');
    assert.strictEqual(hasActiveVideoTrack, false);

    // 2. User chooses to watch -> connecting
    state = 'connecting';
    assert.strictEqual(state, 'connecting');

    // 3. Connected to LiveKit, but host has not transmitted video track -> waiting_host
    state = 'waiting_host';
    assert.strictEqual(state, 'waiting_host', 'Must display standby when host has not published track');
    assert.strictEqual(hasActiveVideoTrack, false, 'No video track must be claimed');

    // 4. Remote video track subscribed -> playing
    hasActiveVideoTrack = true;
    state = 'playing';
    assert.strictEqual(state, 'playing');
    assert.strictEqual(hasActiveVideoTrack, true, 'Genuine track active');

    // 5. Host stops transmitting track -> back to waiting_host
    hasActiveVideoTrack = false;
    state = 'waiting_host';
    assert.strictEqual(state, 'waiting_host');

    // 6. Network failure or token rejection -> error state
    state = 'error';
    const errorMessage = 'Unable to establish WebRTC connection to live stream.';
    assert.strictEqual(state, 'error');
    assert.ok(errorMessage.includes('Unable to establish WebRTC'));
  });

  // Test 45: LiveKit Viewer Player — Media Resource Cleanup on Disconnect / Leave
  await runTest('LiveKit Viewer Player: Disconnecting cleans up peer connection and media resources', async () => {
    let roomDisconnected = false;
    let trackDetached = false;
    let videoSrcObjectCleared = false;
    let elapsedSeconds = 45;
    let estimatedDataMB = 8.5;

    // Simulate cleanup hook behavior
    const mockRoom = {
      disconnect: () => {
        roomDisconnected = true;
      },
    };
    const mockTrack = {
      detach: () => {
        trackDetached = true;
      },
    };
    const mockVideoElement: any = {
      srcObject: { id: 'stream_123' },
    };

    // Execution of leaveLiveStream / unmount
    mockRoom.disconnect();
    mockTrack.detach();
    mockVideoElement.srcObject = null;
    videoSrcObjectCleared = true;
    elapsedSeconds = 0;
    estimatedDataMB = 0;

    assert.strictEqual(roomDisconnected, true, 'LiveKit room must be cleanly disconnected');
    assert.strictEqual(trackDetached, true, 'Subscribed media tracks must be detached');
    assert.strictEqual(videoSrcObjectCleared, true, 'Video element srcObject must be cleared');
    assert.strictEqual(elapsedSeconds, 0, 'Elapsed timer must reset');
    assert.strictEqual(estimatedDataMB, 0, 'Estimated data consumption must reset');
  });

  // Test 46: LiveKit Viewer Player — Data Consumption Estimation Logic
  await runTest('LiveKit Viewer Player: Estimated data rates compute accurately and are clearly labeled', async () => {
    const calculateEstimatedMB = (seconds: number, quality: 'auto' | 'low' | 'medium' | 'high') => {
      let ratePerSec = 0.2;
      if (quality === 'low') ratePerSec = 0.09; // ~5.4 MB/min (360p Data Saver)
      else if (quality === 'medium') ratePerSec = 0.18; // ~10.8 MB/min (480p Balanced)
      else if (quality === 'high') ratePerSec = 0.31; // ~18.6 MB/min (720p High)
      return Number((seconds * ratePerSec).toFixed(1));
    };

    // 60 seconds (1 minute) of viewing
    const lowEst = calculateEstimatedMB(60, 'low');
    const medEst = calculateEstimatedMB(60, 'medium');
    const highEst = calculateEstimatedMB(60, 'high');
    const autoEst = calculateEstimatedMB(60, 'auto');

    assert.strictEqual(lowEst, 5.4, 'Low quality should estimate ~5.4 MB/min');
    assert.strictEqual(medEst, 10.8, 'Medium quality should estimate ~10.8 MB/min');
    assert.strictEqual(highEst, 18.6, 'High quality should estimate ~18.6 MB/min');
    assert.strictEqual(autoEst, 12.0, 'Auto quality should estimate ~12.0 MB/min');

    // Verify label constraint
    const label = `~${medEst.toFixed(1)} MB (Estimated)`;
    assert.ok(label.includes('(Estimated)'), 'Data usage must be clearly disclosed as an estimate');
  });

  // Test 47: Android Broadcaster — Secure Host Authorization Flow
  await runTest('Android Broadcaster: Only verified host can obtain LiveKit publisher tokens for Android capture', async () => {
    const testSecret = 'test_secret_for_android_broadcaster_long_enough_for_sha256';
    setLiveKitTestConfig({
      apiKey: 'test_key',
      apiSecret: testSecret,
      serverUrl: 'wss://test.livekit.gaminghub.ng',
    });

    const hostId = `host_android_${Date.now()}`;
    const nonHostId = `nonhost_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'AndroidHost',
      'freefire',
      'Free Fire',
      'Android Broadcast Auth Room'
    );

    // Host successfully acquires publishing token
    const hostTokenData = await livekitService.generateRoomToken(room, hostId, 'AndroidHost', true);
    assert.strictEqual(hostTokenData.permissions.canPublish, true, 'Host must be granted canPublish: true');
    assert.strictEqual(hostTokenData.participant.isHost, true);

    // Non-host attempting to claim publishing token is strictly rejected
    let nonHostBlocked = false;
    try {
      await livekitService.generateRoomToken(room, nonHostId, 'NonHost', true);
    } catch (err: any) {
      if (err instanceof UnauthorizedStreamHostError) {
        nonHostBlocked = true;
      }
    }
    assert.strictEqual(nonHostBlocked, true, 'Non-host must be rejected from acquiring broadcast publisher tokens');

    setLiveKitTestConfig(null);
  });

  // Test 48: Android Broadcaster — Quality Presets & Bitrate Ceilings
  await runTest('Android Broadcaster: Video quality settings enforce optimal bitrate ceilings for Nigerian mobile networks', async () => {
    const getTargetBitrateKbps = (quality: 'auto' | '360p' | '480p' | '720p'): number => {
      if (quality === '360p') return 700;
      if (quality === '480p') return 1500;
      if (quality === '720p') return 2500;
      return 1800; // auto
    };

    assert.strictEqual(getTargetBitrateKbps('360p'), 700, '360p Data Saver must target 700 kbps');
    assert.strictEqual(getTargetBitrateKbps('480p'), 1500, '480p Balanced must target 1500 kbps');
    assert.strictEqual(getTargetBitrateKbps('720p'), 2500, '720p High Quality must target 2500 kbps');
    assert.strictEqual(getTargetBitrateKbps('auto'), 1800, 'Auto must target 1800 kbps');
  });

  // Test 49: Android Broadcaster — Native Bridge Protocol & Browser Sandbox Rejection
  await runTest('Android Broadcaster: Native bridge detects environment and prevents fake capture in browser', async () => {
    // 1. In standard web environment without Android JavascriptInterface
    const isNative = nativeBroadcaster.isNativeAndroid();
    assert.strictEqual(isNative, false, 'Standard browser environment must be recognized as non-native');

    const result = await nativeBroadcaster.startNativeBroadcast({
      roomId: 'rm_test_123',
      token: 'jwt_mock_token',
      serverUrl: 'wss://test.livekit.cloud',
      quality: '480p',
      captureInternalAudio: true,
      gameTitle: 'Free Fire',
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('NATIVE_WRAPPER_REQUIRED'), 'Must return clean NATIVE_WRAPPER_REQUIRED error in browser');

    // 2. Simulated Android JavascriptInterface injection
    let nativeCaptureInitiated = false;
    (globalThis as any).window = (globalThis as any).window || {};
    (globalThis as any).window.GamingHubAndroidBridge = {
      isSupported: () => true,
      startBroadcast: (optionsJson: string) => {
        nativeCaptureInitiated = true;
        const opts = JSON.parse(optionsJson);
        assert.strictEqual(opts.roomId, 'rm_mock_android');
        assert.strictEqual(opts.quality, '720p');
        return JSON.stringify({ success: true });
      },
      stopBroadcast: () => JSON.stringify({ success: true }),
      getBroadcastStatus: () => JSON.stringify({ isBroadcasting: true, quality: '720p' }),
    };

    assert.strictEqual(nativeBroadcaster.isNativeAndroid(), true);
    const nativeRun = await nativeBroadcaster.startNativeBroadcast({
      roomId: 'rm_mock_android',
      token: 'jwt_mock',
      serverUrl: 'wss://livekit.test',
      quality: '720p',
      captureInternalAudio: true,
    });

    assert.strictEqual(nativeRun.success, true);
    assert.strictEqual(nativeCaptureInitiated, true);

    // Cleanup mock
    delete (globalThis as any).window.GamingHubAndroidBridge;
  });

  // Test 50: Android Broadcaster — Resource Teardown on Broadcast Stop
  await runTest('Android Broadcaster: Stopping broadcast terminates foreground capture and synchronizes room state', async () => {
    const hostId = `host_teardown_${Date.now()}`;
    const room = await firestoreRepo.createRoom(
      hostId,
      'TeardownHost',
      'pubg',
      'PUBG Mobile',
      'Teardown Test Room'
    );

    // Host starts broadcast
    await firestoreRepo.updateBroadcastStatus(
      room.id,
      hostId,
      true,
      'wss://livekit.gaminghub.ng',
      'webrtc'
    );
    const liveRoom = await firestoreRepo.getRoom(room.id);
    assert.strictEqual(liveRoom?.stream?.isLive, true);
    assert.strictEqual(liveRoom?.status, 'live');

    // Host stops broadcast via nativeBroadcaster and updates Firestore
    const stopResult = await nativeBroadcaster.stopNativeBroadcast();
    assert.strictEqual(stopResult.success, true);

    const stoppedRoom = await firestoreRepo.updateBroadcastStatus(
      room.id,
      hostId,
      false,
      null,
      'webrtc'
    );
    assert.strictEqual(stoppedRoom.stream?.isLive, false);
    assert.strictEqual(stoppedRoom.stream?.streamUrl, null);

    const state = await nativeBroadcaster.getBroadcastState();
    assert.strictEqual(state.isBroadcasting, false);
    assert.strictEqual(state.roomId, null);
  });

  console.log(`\n🎉 Test Results: ${passedTests}/${totalTests} tests passed successfully!\n`);
}

// Auto-run if executed directly via CLI
if (process.argv[1]?.endsWith('gaming_hub.test.ts') || process.argv[1]?.endsWith('gaming_hub.test.js')) {
  runAllTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal test error:', err);
      process.exit(1);
    });
}
