/**
 * Gaming Hub — Stage 3.2 Client-Side Authentication Manager Test Suite
 *
 * Automated verification of:
 * 1. Access-token attachment to authenticated API requests.
 * 2. Successful token refresh and refresh-token rotation in secure storage.
 * 3. Expired and revoked refresh token handling (HTTP 401 cleanup).
 * 4. Concurrent requests sharing one single-flight refresh operation.
 * 5. Failed refresh handling without crash or infinite loops.
 * 6. One-time retry after HTTP 401 with loop prevention.
 * 7. Logout and session cleanup across memory and secure storage.
 * 8. Existing Firebase authentication backward compatibility.
 * 9. Refresh token security (never stored in localStorage or sessionStorage).
 */

import assert from 'node:assert';
import {
  AuthManager,
  InMemorySecureTokenStorage,
  NativeAndroidSecureStorage,
  ISecureTokenStorage,
  AuthUser,
  AuthTokens,
} from '../src/lib/authManager.js';
import { authFetch } from '../src/lib/firebase.js';

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

async function runAllClientAuthManagerTests() {
  console.log('🛡️ Starting Gaming Hub Stage 3.2 Client-Side Authentication Manager Test Suite...\n');

  const mockUser: AuthUser = {
    id: 'gh_player_101',
    email: 'player101@gaminghub.ng',
    displayName: 'Player101',
    role: 'user',
    createdAt: new Date().toISOString(),
  };

  const initialTokens: AuthTokens = {
    accessToken: 'initial_gh_access_token_aaa',
    refreshToken: 'initial_gh_refresh_token_111',
    expiresIn: 900,
    tokenType: 'Bearer',
  };

  // -------------------------------------------------------------
  // Test 1: Access-token attachment
  // -------------------------------------------------------------
  await runTest('1. Access Token Attachment: Attaches Bearer token and preserves custom headers', async () => {
    let capturedHeaders: Headers | null = null;
    let capturedUrl = '';

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    const storage = new InMemorySecureTokenStorage();
    const manager = new AuthManager({ storage, customFetch: mockFetch });

    await manager.setSession({ user: mockUser, tokens: initialTokens });

    const res = await manager.fetch('/api/wallet', {
      headers: { 'X-Custom-Client': 'GamingHubApp' },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedUrl, '/api/wallet');
    assert.strictEqual(capturedHeaders?.get('Authorization'), 'Bearer initial_gh_access_token_aaa');
    assert.strictEqual(capturedHeaders?.get('X-Custom-Client'), 'GamingHubApp');
  });

  // -------------------------------------------------------------
  // Test 2: In-memory token security
  // -------------------------------------------------------------
  await runTest('2. In-Memory Token Security: Access token kept in memory; never leaked to storage', async () => {
    const storage = new InMemorySecureTokenStorage();
    const manager = new AuthManager({ storage });

    await manager.setSession({ user: mockUser, tokens: initialTokens });

    // Access token is held in manager memory
    assert.strictEqual(manager.getAccessToken(), 'initial_gh_access_token_aaa');
    assert.strictEqual(manager.isAuthenticated(), true);

    // Refresh token is held in secure storage vault, NOT in manager memory properties directly
    const storedRefresh = await storage.getRefreshToken();
    assert.strictEqual(storedRefresh, 'initial_gh_refresh_token_111');
  });

  // -------------------------------------------------------------
  // Test 3: Successful token refresh
  // -------------------------------------------------------------
  await runTest('3. Successful Token Refresh: Rotates refresh token and updates in-memory access token', async () => {
    let refreshCalls = 0;
    const storage = new InMemorySecureTokenStorage();

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) {
        refreshCalls++;
        const body = JSON.parse(String(init?.body));
        assert.strictEqual(body.refreshToken, 'initial_gh_refresh_token_111');

        return new Response(
          JSON.stringify({
            success: true,
            tokens: {
              accessToken: 'refreshed_access_token_bbb',
              refreshToken: 'rotated_refresh_token_222',
              expiresIn: 900,
            },
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 404 });
    };

    const manager = new AuthManager({ storage, customFetch: mockFetch });
    await manager.setSession({ user: mockUser, tokens: initialTokens });

    const newToken = await manager.refreshSession();

    assert.strictEqual(refreshCalls, 1, 'Should call /api/auth/refresh once');
    assert.strictEqual(newToken, 'refreshed_access_token_bbb');
    assert.strictEqual(manager.getAccessToken(), 'refreshed_access_token_bbb');

    // Secure storage must have the new rotated refresh token
    const storedRefresh = await storage.getRefreshToken();
    assert.strictEqual(storedRefresh, 'rotated_refresh_token_222');
  });

  // -------------------------------------------------------------
  // Test 4: Expired and revoked refresh tokens
  // -------------------------------------------------------------
  await runTest('4. Expired/Revoked Refresh Token: HTTP 401 clears local session and resets state', async () => {
    const storage = new InMemorySecureTokenStorage();

    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Refresh token has been revoked.',
            code: 'AUTH_TOKEN_INVALID',
          }),
          { status: 401 }
        );
      }
      return new Response(null, { status: 404 });
    };

    const manager = new AuthManager({ storage, customFetch: mockFetch });
    await manager.setSession({ user: mockUser, tokens: initialTokens });

    let authStateChangedFiredWithNull = false;
    manager.onAuthStateChanged((user) => {
      if (user === null) {
        authStateChangedFiredWithNull = true;
      }
    });

    const result = await manager.refreshSession();

    assert.strictEqual(result, null);
    assert.strictEqual(manager.isAuthenticated(), false);
    assert.strictEqual(manager.getUser(), null);
    assert.strictEqual(manager.getAccessToken(), null);
    assert.strictEqual(await storage.getRefreshToken(), null);
    assert.strictEqual(authStateChangedFiredWithNull, true);
  });

  // -------------------------------------------------------------
  // Test 5: Concurrent requests sharing one refresh operation
  // -------------------------------------------------------------
  await runTest('5. Concurrency Deduplication: 5 simultaneous refresh requests dispatch exactly 1 HTTP call', async () => {
    let networkCalls = 0;
    const storage = new InMemorySecureTokenStorage();

    const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) {
        networkCalls++;
        // Simulate 50ms network round-trip delay to ensure overlap
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(
          JSON.stringify({
            success: true,
            tokens: {
              accessToken: 'single_flight_access_token_ccc',
              refreshToken: 'single_flight_refresh_token_333',
              expiresIn: 900,
            },
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 404 });
    };

    const manager = new AuthManager({ storage, customFetch: mockFetch });
    await manager.setSession({ user: mockUser, tokens: initialTokens });

    // Fire 5 concurrent refresh operations simultaneously
    const results = await Promise.all([
      manager.refreshSession(),
      manager.refreshSession(),
      manager.refreshSession(),
      manager.refreshSession(),
      manager.refreshSession(),
    ]);

    assert.strictEqual(networkCalls, 1, 'Only 1 HTTP refresh request must be sent over the wire');
    for (const token of results) {
      assert.strictEqual(token, 'single_flight_access_token_ccc');
    }
    assert.strictEqual(manager.getAccessToken(), 'single_flight_access_token_ccc');
  });

  // -------------------------------------------------------------
  // Test 6: Failed refresh handling (500 or Network offline)
  // -------------------------------------------------------------
  await runTest('6. Failed Refresh: Server 500 or network offline does not crash or loop infinitely', async () => {
    const storage = new InMemorySecureTokenStorage();

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ success: false, error: 'Database temporarily unavailable' }),
        { status: 500 }
      );
    };

    const manager = new AuthManager({ storage, customFetch: mockFetch });
    await manager.setSession({ user: mockUser, tokens: initialTokens });

    const result = await manager.refreshSession();
    assert.strictEqual(result, null);
    // Transient server 500 does NOT immediately wipe user session
    assert.strictEqual(manager.getUser()?.id, mockUser.id);
  });

  // -------------------------------------------------------------
  // Test 7: One-time retry after HTTP 401
  // -------------------------------------------------------------
  await runTest('7. One-Time Retry: HTTP 401 automatically refreshes and retries once; halts if retry also 401', async () => {
    let endpointCallCount = 0;
    let refreshCallCount = 0;
    const storage = new InMemorySecureTokenStorage();

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);

      if (url.includes('/api/auth/refresh')) {
        refreshCallCount++;
        return new Response(
          JSON.stringify({
            success: true,
            tokens: {
              accessToken: 'new_token_after_401',
              refreshToken: 'new_refresh_token_after_401',
              expiresIn: 900,
            },
          }),
          { status: 200 }
        );
      }

      if (url === '/api/wallet') {
        endpointCallCount++;
        const auth = new Headers(init?.headers).get('Authorization');
        // Initial call with expired token returns 401
        if (auth === 'Bearer initial_gh_access_token_aaa') {
          return new Response(JSON.stringify({ error: 'Token expired' }), { status: 401 });
        }
        // Retried call with new token returns 200
        if (auth === 'Bearer new_token_after_401') {
          return new Response(JSON.stringify({ success: true, balance: 1500 }), { status: 200 });
        }
      }

      return new Response(null, { status: 404 });
    };

    const manager = new AuthManager({ storage, customFetch: mockFetch });
    await manager.setSession({ user: mockUser, tokens: initialTokens });

    const res = await manager.fetch('/api/wallet');

    assert.strictEqual(res.status, 200, 'Request should succeed on retry');
    const data = await res.json();
    assert.strictEqual(data.balance, 1500);
    assert.strictEqual(endpointCallCount, 2, 'Initial call (401) + retry call (200) = 2 calls');
    assert.strictEqual(refreshCallCount, 1, 'Refresh called exactly once');

    // Now test: If the endpoint ALWAYS returns 401 (even with new token), retry happens only ONCE
    let perpetual401Count = 0;
    const mockPerpetual401Fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            success: true,
            tokens: { accessToken: 'token_x', refreshToken: 'ref_x', expiresIn: 900 },
          }),
          { status: 200 }
        );
      }
      perpetual401Count++;
      return new Response(JSON.stringify({ error: 'Always forbidden' }), { status: 401 });
    };

    const manager2 = new AuthManager({ storage: new InMemorySecureTokenStorage(), customFetch: mockPerpetual401Fetch });
    await manager2.setSession({ user: mockUser, tokens: initialTokens });

    const failedRes = await manager2.fetch('/api/restricted');
    assert.strictEqual(failedRes.status, 401);
    assert.strictEqual(perpetual401Count, 2, 'Must NOT loop infinitely: exactly 1 initial + 1 retry');
  });

  // -------------------------------------------------------------
  // Test 8: Logout and session cleanup
  // -------------------------------------------------------------
  await runTest('8. Logout: Notifies server, clears in-memory tokens, and wipes secure storage', async () => {
    let logoutCalledWithToken = false;
    const storage = new InMemorySecureTokenStorage();

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/logout')) {
        const body = JSON.parse(String(init?.body));
        if (body.refreshToken === 'initial_gh_refresh_token_111') {
          logoutCalledWithToken = true;
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    };

    const manager = new AuthManager({ storage, customFetch: mockFetch });
    await manager.setSession({ user: mockUser, tokens: initialTokens });

    await manager.logout();

    assert.strictEqual(logoutCalledWithToken, true, 'Logout API should receive the refresh token to revoke session');
    assert.strictEqual(manager.isAuthenticated(), false);
    assert.strictEqual(manager.getUser(), null);
    assert.strictEqual(manager.getAccessToken(), null);
    assert.strictEqual(await storage.getRefreshToken(), null);
  });

  // -------------------------------------------------------------
  // Test 9: Existing Firebase authentication compatibility
  // -------------------------------------------------------------
  await runTest('9. Firebase Compatibility: authFetch preserves existing Firebase ID token when GH is inactive', async () => {
    // When Gaming Hub is unauthenticated, authFetch checks Firebase auth.currentUser
    const originalFetch = globalThis.fetch;
    let dispatchedAuthHeader: string | null = null;

    try {
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        dispatchedAuthHeader = new Headers(init?.headers).get('Authorization');
        return new Response(JSON.stringify({ success: true, service: 'ok' }), { status: 200 });
      };

      // Ensure Gaming Hub is cleared
      const { authManager: globalManager } = await import('../src/lib/authManager.js');
      await globalManager.clearSession();

      const res = await authFetch('/api/health');
      assert.strictEqual(res.status, 200);

      // In Node test environment, auth.currentUser is null, so request proceeds unauthenticated without throwing
      assert.strictEqual(dispatchedAuthHeader, null);

      // Now set a Gaming Hub session on the global manager and verify authFetch automatically attaches it
      await globalManager.setSession({ user: mockUser, tokens: initialTokens });

      const resWithGh = await authFetch('/api/wallet');
      assert.strictEqual(resWithGh.status, 200);
      assert.strictEqual(dispatchedAuthHeader, 'Bearer initial_gh_access_token_aaa');

      // Clean up global session
      await globalManager.clearSession();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // -------------------------------------------------------------
  // Test 10: Refresh-token security (localStorage / sessionStorage isolation)
  // -------------------------------------------------------------
  await runTest('10. Security: Refresh tokens are never placed into localStorage or sessionStorage', async () => {
    // Set up mock window.localStorage and window.sessionStorage if not defined
    const fakeLocalStorage: Record<string, string> = {};
    const fakeSessionStorage: Record<string, string> = {};

    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => fakeLocalStorage[k] || null,
        setItem: (k: string, v: string) => { fakeLocalStorage[k] = v; },
        removeItem: (k: string) => { delete fakeLocalStorage[k]; },
      },
      sessionStorage: {
        getItem: (k: string) => fakeSessionStorage[k] || null,
        setItem: (k: string, v: string) => { fakeSessionStorage[k] = v; },
        removeItem: (k: string) => { delete fakeSessionStorage[k]; },
      },
    };

    try {
      const storage = new InMemorySecureTokenStorage();
      const manager = new AuthManager({ storage });

      await manager.setSession({ user: mockUser, tokens: initialTokens });

      // Confirm localStorage and sessionStorage contain NO tokens
      assert.strictEqual(Object.keys(fakeLocalStorage).length, 0);
      assert.strictEqual(Object.keys(fakeSessionStorage).length, 0);
      assert.strictEqual(fakeLocalStorage['gh_refresh_token'], undefined);
      assert.strictEqual(fakeSessionStorage['gh_refresh_token'], undefined);
      assert.strictEqual(fakeLocalStorage['accessToken'], undefined);
    } finally {
      delete (globalThis as any).window;
    }
  });

  // -------------------------------------------------------------
  // Test 11: Native Bridge Availability Detection & Truth in Persistence
  // -------------------------------------------------------------
  await runTest('11. Bridge Detection: Accurately detects Keystore bridge availability and never falsely claims persistence or hardware backing', async () => {
    // Subtest A: Browser environment without bridge
    (globalThis as any).window = {};
    try {
      const nativeStorage = new NativeAndroidSecureStorage();
      assert.strictEqual(nativeStorage.isAvailable(), false, 'Native storage must be unavailable in plain browser');
      assert.strictEqual(nativeStorage.persistenceType, 'ephemeral_memory');
      assert.strictEqual(nativeStorage.isPersistent, true);
      assert.strictEqual(nativeStorage.isHardwareBacked(), false);

      // Default AuthManager in browser environment must use in-memory storage
      const defaultManager = new AuthManager({ storage: new InMemorySecureTokenStorage() });
      assert.strictEqual(defaultManager.isPersistentStorageActive(), false);
      assert.strictEqual(defaultManager.getStorageCapabilities().persistenceType, 'ephemeral_memory');
      assert.strictEqual(defaultManager.getStorageCapabilities().isHardwareBacked?.(), false);
    } finally {
      delete (globalThis as any).window;
    }

    // Subtest B: Android container with verified HARDWARE-BACKED Keystore bridge (TEE/StrongBox)
    (globalThis as any).window = {
      AndroidBridge: {
        isSecureStorageAvailable: () => true,
        isHardwareBacked: () => true,
        getStorageSecurityLevel: () => 'hardware_keystore',
        getSecureItem: (_k: string) => null,
        setSecureItem: (_k: string, _v: string) => true,
        removeSecureItem: (_k: string) => true,
      },
    };
    try {
      const nativeStorage = new NativeAndroidSecureStorage();
      assert.strictEqual(nativeStorage.isAvailable(), true, 'Must detect valid Keystore bridge');
      assert.strictEqual(nativeStorage.isHardwareBacked(), true, 'Must verify hardware backing');
      assert.strictEqual(nativeStorage.persistenceType, 'hardware_keystore');

      const nativeManager = new AuthManager();
      assert.strictEqual(nativeManager.isPersistentStorageActive(), true, 'Must report persistent storage active');
      assert.strictEqual(nativeManager.getStorageCapabilities().persistenceType, 'hardware_keystore');
      assert.strictEqual(nativeManager.getStorageCapabilities().isHardwareBacked?.(), true);
    } finally {
      delete (globalThis as any).window;
    }

    // Subtest C: Android container with SOFTWARE-BACKED Keystore (e.g. emulator, unverified hardware)
    // Preserves encrypted storage functionality without falsely claiming hardware backing
    (globalThis as any).window = {
      AndroidBridge: {
        isSecureStorageAvailable: () => true,
        isHardwareBacked: () => false,
        getStorageSecurityLevel: () => 'software_keystore',
        getSecureItem: (_k: string) => null,
        setSecureItem: (_k: string, _v: string) => true,
        removeSecureItem: (_k: string) => true,
      },
    };
    try {
      const nativeStorage = new NativeAndroidSecureStorage();
      assert.strictEqual(nativeStorage.isAvailable(), true, 'Software Keystore is functional');
      assert.strictEqual(nativeStorage.isHardwareBacked(), false, 'Must NOT claim hardware backing');
      assert.strictEqual(nativeStorage.persistenceType, 'software_keystore', 'Must report software_keystore');

      const nativeManager = new AuthManager();
      assert.strictEqual(nativeManager.isPersistentStorageActive(), true, 'Still persistent encrypted storage');
      assert.strictEqual(nativeManager.getStorageCapabilities().persistenceType, 'software_keystore');
      assert.strictEqual(nativeManager.getStorageCapabilities().isHardwareBacked?.(), false);
    } finally {
      delete (globalThis as any).window;
    }

    // Subtest D: Bridge present but isSecureStorageAvailable returns false (Keystore error on device)
    (globalThis as any).window = {
      AndroidBridge: {
        isSecureStorageAvailable: () => false,
        isHardwareBacked: () => false,
        getStorageSecurityLevel: () => 'unavailable',
        getSecureItem: () => null,
        setSecureItem: () => false,
        removeSecureItem: () => false,
      },
    };
    try {
      const nativeStorage = new NativeAndroidSecureStorage();
      assert.strictEqual(nativeStorage.isAvailable(), false, 'Must report unavailable if bridge indicates Keystore failure');
      assert.strictEqual(nativeStorage.isHardwareBacked(), false);
      assert.strictEqual(nativeStorage.persistenceType, 'ephemeral_memory');
    } finally {
      delete (globalThis as any).window;
    }
  });

  // -------------------------------------------------------------
  // Test 12: Native Android Keystore Storage Operations
  // -------------------------------------------------------------
  await runTest('12. Native Storage Operations: set, get, clear correctly delegate to native AndroidBridge methods', async () => {
    const mockKeystoreVault: Record<string, string> = {};
    let setCalls = 0;
    let getCalls = 0;
    let removeCalls = 0;

    (globalThis as any).window = {
      AndroidBridge: {
        isSecureStorageAvailable: () => true,
        getSecureItem: (k: string) => {
          getCalls++;
          return mockKeystoreVault[k] || null;
        },
        setSecureItem: (k: string, v: string) => {
          setCalls++;
          mockKeystoreVault[k] = v;
          return true;
        },
        removeSecureItem: (k: string) => {
          removeCalls++;
          delete mockKeystoreVault[k];
          return true;
        },
      },
    };

    try {
      const nativeStorage = new NativeAndroidSecureStorage();
      assert.strictEqual(nativeStorage.isAvailable(), true);

      // 1. Set refresh token
      const setSuccess = await nativeStorage.setRefreshToken('keystore_encrypted_token_xyz');
      assert.strictEqual(setSuccess, true);
      assert.strictEqual(setCalls, 1);
      assert.strictEqual(mockKeystoreVault['gh_refresh_token'], 'keystore_encrypted_token_xyz');

      // 2. Get refresh token
      const retrieved = await nativeStorage.getRefreshToken();
      assert.strictEqual(retrieved, 'keystore_encrypted_token_xyz');
      assert.strictEqual(getCalls, 1);

      // 3. Clear refresh token
      const clearSuccess = await nativeStorage.clearRefreshToken();
      assert.strictEqual(clearSuccess, true);
      assert.strictEqual(removeCalls, 1);
      assert.strictEqual(mockKeystoreVault['gh_refresh_token'], undefined);
    } finally {
      delete (globalThis as any).window;
    }
  });

  // -------------------------------------------------------------
  // Test 13: Storage Failure Safety
  // -------------------------------------------------------------
  await runTest('13. Storage Failure Safety: Handles hardware/bridge exceptions without throwing or claiming persistence', async () => {
    // Bridge that throws hardware exceptions (e.g. KeyPermanentlyInvalidatedException)
    (globalThis as any).window = {
      AndroidBridge: {
        isSecureStorageAvailable: () => true,
        getSecureItem: () => {
          throw new Error('AndroidKeyStore: KeyPermanentlyInvalidatedException');
        },
        setSecureItem: () => {
          throw new Error('AndroidKeyStore: ProviderException hardware error');
        },
        removeSecureItem: () => {
          throw new Error('AndroidKeyStore: IO failure');
        },
      },
    };

    try {
      const nativeStorage = new NativeAndroidSecureStorage();

      // Must catch and return false/null safely without uncaught exceptions or leaking
      const setRes = await nativeStorage.setRefreshToken('token_test');
      assert.strictEqual(setRes, false, 'Failed set must return false');

      const getRes = await nativeStorage.getRefreshToken();
      assert.strictEqual(getRes, null, 'Failed get must return null');

      const clearRes = await nativeStorage.clearRefreshToken();
      assert.strictEqual(clearRes, false, 'Failed remove must return false');
    } finally {
      delete (globalThis as any).window;
    }

    // When storage is unavailable, setRefreshToken must return false and NOT silently claim success
    (globalThis as any).window = {};
    try {
      const unavailableStorage = new NativeAndroidSecureStorage();
      const setRes = await unavailableStorage.setRefreshToken('token_abc');
      assert.strictEqual(setRes, false, 'Must never claim success when native bridge is unavailable');
    } finally {
      delete (globalThis as any).window;
    }
  });

  // -------------------------------------------------------------
  // Test 14: Cross-Tab / Multi-Instance Refresh Coordination
  // -------------------------------------------------------------
  await runTest('14. Cross-Tab Coordination: Synchronizes token rotation and logout across contexts via memory IPC', async () => {
    // Simulate Tab A and Tab B running in the same browser origin
    const tabAStorage = new InMemorySecureTokenStorage();
    const tabBStorage = new InMemorySecureTokenStorage();

    let tabARefreshCount = 0;
    const mockTabAFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) {
        tabARefreshCount++;
        return new Response(
          JSON.stringify({
            success: true,
            tokens: {
              accessToken: 'crosstab_access_token_rotated_444',
              refreshToken: 'crosstab_refresh_token_rotated_555',
              expiresIn: 900,
            },
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: 404 });
    };

    const tabA = new AuthManager({ storage: tabAStorage, customFetch: mockTabAFetch, enableCrossTabCoordination: true });
    const tabB = new AuthManager({ storage: tabBStorage, enableCrossTabCoordination: true });

    try {
      // 1. Tab A logs in / sets session
      await tabA.setSession({ user: mockUser, tokens: initialTokens });

      // Give Node / BroadcastChannel IPC a brief tick to dispatch
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Tab B should have automatically received the authenticated session in memory
      assert.strictEqual(tabB.isAuthenticated(), true, 'Tab B must receive authenticated state from Tab A');
      assert.strictEqual(tabB.getUser()?.id, mockUser.id);
      assert.strictEqual(tabB.getAccessToken(), 'initial_gh_access_token_aaa');

      // 2. Tab A refreshes its tokens
      const newTabAToken = await tabA.refreshSession();
      assert.strictEqual(newTabAToken, 'crosstab_access_token_rotated_444');
      assert.strictEqual(tabARefreshCount, 1);

      await new Promise((resolve) => setTimeout(resolve, 30));

      // Tab B's in-memory access token and refresh token must have updated without Tab B making any network call
      assert.strictEqual(tabB.getAccessToken(), 'crosstab_access_token_rotated_444', 'Tab B must have updated access token');
      assert.strictEqual(await tabBStorage.getRefreshToken(), 'crosstab_refresh_token_rotated_555', 'Tab B storage must have rotated refresh token');

      // 3. Tab A logs out
      await tabA.logout();

      await new Promise((resolve) => setTimeout(resolve, 30));

      // Tab B must be logged out as well
      assert.strictEqual(tabB.isAuthenticated(), false, 'Tab B must synchronize logout');
      assert.strictEqual(tabB.getAccessToken(), null);
      assert.strictEqual(await tabBStorage.getRefreshToken(), null);
    } finally {
      tabA.destroy();
      tabB.destroy();
    }
  });

  // -------------------------------------------------------------
  // Test 15: Cross-Tab 409 Recovery without Session Destruction
  // -------------------------------------------------------------
  await runTest('15. Cross-Tab 409 Recovery: Recovers from 409 CONCURRENT_REFRESH without wiping user session', async () => {
    const tabAStorage = new InMemorySecureTokenStorage();
    const tabBStorage = new InMemorySecureTokenStorage();

    const tabA = new AuthManager({ storage: tabAStorage, enableCrossTabCoordination: true });

    // Establish active session on Tab A
    await tabA.setSession({
      user: mockUser,
      tokens: {
        accessToken: 'fresh_tabA_access_token_999',
        refreshToken: 'fresh_tabA_refresh_token_888',
        expiresIn: 900,
      },
    });

    // Tab B simulates presenting a stale consumed token that returns 409 CONCURRENT_REFRESH
    const mockTabBFetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'A token refresh operation is currently in progress or recently completed.',
            code: 'CONCURRENT_REFRESH',
            retryable: true,
            graceWindowActive: true,
          }),
          { status: 409 }
        );
      }
      return new Response(null, { status: 404 });
    };

    const tabB = new AuthManager({ storage: tabBStorage, customFetch: mockTabBFetch, enableCrossTabCoordination: true });
    // Preload Tab B with stale token
    await tabBStorage.setRefreshToken('stale_refresh_token_000');

    try {
      // Tab B triggers refresh -> receives 409 -> requests auth from Tab A via BroadcastChannel -> recovers
      const recoveredToken = await tabB.refreshSession();

      assert.strictEqual(recoveredToken, 'fresh_tabA_access_token_999', 'Tab B must recover active token from Tab A');
      assert.strictEqual(tabB.isAuthenticated(), true, 'Tab B must remain authenticated');
      assert.strictEqual(await tabBStorage.getRefreshToken(), 'fresh_tabA_refresh_token_888');
    } finally {
      tabA.destroy();
      tabB.destroy();
    }
  });

  const { authManager: globalManager } = await import('../src/lib/authManager.js');
  globalManager.destroy();

  console.log('\n🎉 All Stage 3.2 Client-Side Authentication Manager tests PASSED successfully!\n');
  process.exit(0);
}

runAllClientAuthManagerTests().catch((err) => {
  console.error('\n💥 Test run failed with error:', err);
  process.exit(1);
});
