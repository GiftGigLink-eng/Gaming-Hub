import assert from 'assert';
import crypto from 'crypto';
import { getApps, deleteApp } from 'firebase-admin/app';
import {
  createFirebaseAdminApp,
  EXPECTED_PROJECT_ID,
} from '../src/server/firebaseAdmin.js';

console.log('🧪 Starting Firebase Admin Credential Security Test Suite...\n');

let total = 0;
let passed = 0;

async function run(name: string, fn: () => Promise<void> | void) {
  total++;
  try {
    const res = fn();
    if (res instanceof Promise) await res;
    passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// Generate valid test RSA private key for testing genuine cert() credential parsing
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const validServiceAccount = {
  type: 'service_account',
  project_id: EXPECTED_PROJECT_ID,
  private_key_id: 'test-key-id-12345',
  private_key: privateKey,
  client_email: `test-sa@${EXPECTED_PROJECT_ID}.iam.gserviceaccount.com`,
  client_id: '1234567890',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
};

async function cleanupApps() {
  const apps = [...getApps()];
  for (const app of apps) {
    await deleteApp(app);
  }
}

async function runAllTests() {
  try {
    // -------------------------------------------------------------
    // TEST 1: Malformed JSON throws safe startup error
    // -------------------------------------------------------------
    await run('Malformed JSON: Throws safe startup error in production', async () => {
      await cleanupApps();
      const malformedJson = '{"type": "service_account", "private_key": "broken...';
      let caughtError: any = null;

      try {
        createFirebaseAdminApp({
          serviceAccountKeyJson: malformedJson,
          isProduction: true,
        });
      } catch (err: any) {
        caughtError = err;
      }

      assert(caughtError !== null, 'Must throw an error for malformed JSON');
      assert.strictEqual(
        caughtError.message,
        'Invalid FIREBASE_SERVICE_ACCOUNT_KEY format.',
        'Error message must be exactly "Invalid FIREBASE_SERVICE_ACCOUNT_KEY format."'
      );

      // Verify no sensitive tokens or payload contents are leaked in error message
      assert(!caughtError.message.includes('broken'), 'Must not leak input snippet');
      assert(!caughtError.message.includes('private_key'), 'Must not leak key names');
    });

    // -------------------------------------------------------------
    // TEST 2: Missing production credential fails fast
    // -------------------------------------------------------------
    await run('Missing Credential: Fails clearly at startup in production', async () => {
      await cleanupApps();
      let caughtError: any = null;

      try {
        createFirebaseAdminApp({
          serviceAccountKeyJson: undefined,
          googleAppCreds: undefined,
          isProduction: true,
        });
      } catch (err: any) {
        caughtError = err;
      }

      assert(caughtError !== null, 'Must throw when credentials are missing in production');
      assert(
        caughtError.message.includes('Missing FIREBASE_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS in production.'),
        `Unexpected error message: ${caughtError.message}`
      );
    });

    // -------------------------------------------------------------
    // TEST 3: Incorrect Firebase project ID is rejected
    // -------------------------------------------------------------
    await run('Project ID Mismatch: Rejects mismatched service account project ID', async () => {
      await cleanupApps();
      const mismatchedSa = {
        ...validServiceAccount,
        project_id: 'wrong-project-id-999',
      };
      let caughtError: any = null;

      try {
        createFirebaseAdminApp({
          serviceAccountKeyJson: JSON.stringify(mismatchedSa),
          isProduction: true,
        });
      } catch (err: any) {
        caughtError = err;
      }

      assert(caughtError !== null, 'Must throw when service account project ID does not match expected');
      assert(
        caughtError.message.includes('Firebase service account project ID mismatch'),
        `Unexpected error message: ${caughtError.message}`
      );
    });

    await run('Project ID Mismatch: Rejects mismatched configuration project ID in production', async () => {
      await cleanupApps();
      let caughtError: any = null;

      try {
        createFirebaseAdminApp({
          projectId: 'tampered-project-id-888',
          serviceAccountKeyJson: JSON.stringify(validServiceAccount),
          isProduction: true,
        });
      } catch (err: any) {
        caughtError = err;
      }

      assert(caughtError !== null, 'Must throw when configured project ID does not match expected');
      assert(
        caughtError.message.includes('Firebase project ID mismatch'),
        `Unexpected error message: ${caughtError.message}`
      );
    });

    // -------------------------------------------------------------
    // TEST 4: Valid credential JSON initializes successfully
    // -------------------------------------------------------------
    await run('Valid Credential JSON: Initializes Firebase Admin App successfully', async () => {
      await cleanupApps();
      const app = createFirebaseAdminApp({
        serviceAccountKeyJson: JSON.stringify(validServiceAccount),
        isProduction: true,
      });

      assert(app, 'App instance must be returned');
      assert.strictEqual(app.options.projectId, EXPECTED_PROJECT_ID);
      assert(app.options.credential, 'Credential must be attached');
    });

    // -------------------------------------------------------------
    // TEST 5: Repeated initialization returns existing instance
    // -------------------------------------------------------------
    await run('Repeated Initialization: Reuses existing app without creating duplicates', async () => {
      // An app is already active from TEST 4
      const appsBefore = getApps();
      assert.strictEqual(appsBefore.length, 1, 'Exactly one app must be active');

      const appSecond = createFirebaseAdminApp({
        serviceAccountKeyJson: JSON.stringify(validServiceAccount),
        isProduction: true,
      });

      const appsAfter = getApps();
      assert.strictEqual(appsAfter.length, 1, 'Must still have exactly one app after repeated initialization');
      assert.strictEqual(appSecond, appsBefore[0], 'Must return existing app reference');
    });

    // -------------------------------------------------------------
    // TEST 6: Development mode preserves emulator / local fallback
    // -------------------------------------------------------------
    await run('Development Mode: Missing credentials does not throw in non-production', async () => {
      await cleanupApps();
      const app = createFirebaseAdminApp({
        serviceAccountKeyJson: undefined,
        googleAppCreds: undefined,
        isProduction: false,
      });

      assert(app, 'Dev app instance must be created without throwing missing credential error');
      assert.strictEqual(app.options.projectId, EXPECTED_PROJECT_ID);
    });

    // -------------------------------------------------------------
    // TEST 7: Google Cloud Run / GCP runtime initializes natively in production
    // -------------------------------------------------------------
    await run('GCP Runtime: Production Cloud Run initializes using platform credentials', async () => {
      await cleanupApps();
      const app = createFirebaseAdminApp({
        serviceAccountKeyJson: undefined,
        googleAppCreds: undefined,
        isProduction: true,
        isExternalHosting: false,
      });

      assert(app, 'App must initialize on GCP runtime in production without requiring manual keys');
      assert.strictEqual(app.options.projectId, EXPECTED_PROJECT_ID);
    });

    console.log(`\n🎉 Firebase Admin Credential Security Suite Completed: ${passed}/${total} passed!\n`);
  } finally {
    // Restore clean singleton state for subsequent modules/server
    await cleanupApps();
    createFirebaseAdminApp();
  }
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
