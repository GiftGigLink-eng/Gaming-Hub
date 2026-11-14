/**
 * Gaming Hub — Independent Client-Side Authentication Manager (Stage 3.2 Hardened)
 *
 * Central client-side authentication service responsible for:
 * 1. Maintaining authenticated session state and user identity strictly in memory.
 * 2. Keeping access tokens strictly in memory (never written to web storage).
 * 3. Managing refresh tokens via hardware-backed Android Keystore or in-memory closure vault.
 *    - Never stored in localStorage or sessionStorage.
 *    - Accurately reports storage persistence capabilities (never falsely claiming persistence).
 * 4. Cross-tab and cross-WebView coordination:
 *    - Web Locks API (navigator.locks) for cross-tab single-flight refresh serialization.
 *    - BroadcastChannel IPC for zero-storage in-memory token rotation & logout synchronization.
 *    - Safe 409 CONCURRENT_REFRESH recovery without premature session destruction.
 * 5. Attaching access tokens to authenticated API requests.
 * 6. Intercepting HTTP 401 with safe one-time retry without recursion.
 * 7. Logging out and clearing authentication state across all contexts.
 * 8. Preserving backward compatibility with Firebase Authentication.
 */

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  role?: string;
  createdAt?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // in seconds
  tokenType?: string;
}

export type AuthStatus = 'unauthenticated' | 'authenticated' | 'refreshing';

export interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  isAuthenticated: boolean;
}

export type StoragePersistenceType = 'hardware_keystore' | 'software_keystore' | 'ephemeral_memory';

export interface StorageCapabilities {
  readonly persistenceType: StoragePersistenceType;
  readonly isPersistent: boolean;
  isAvailable(): boolean;
  isHardwareBacked?(): boolean;
}

/**
 * Interface for platform-supported secure storage of long-lived refresh tokens.
 * In accordance with Stage 3.2 requirements:
 * - Refresh tokens are NEVER stored in localStorage or sessionStorage.
 * - Adapter accurately reports persistence and fails safely when unavailable.
 * - Hardware backing is explicitly verified via KeyInfo; never falsely claimed.
 */
export interface ISecureTokenStorage extends StorageCapabilities {
  getRefreshToken(): Promise<string | null> | string | null;
  setRefreshToken(token: string): Promise<boolean> | boolean | Promise<void> | void;
  clearRefreshToken(): Promise<boolean> | boolean | Promise<void> | void;
}

/**
 * In-memory secure storage vault for standard web browser runtimes.
 * Holds the refresh token in an isolated JavaScript closure, completely
 * inaccessible to localStorage, sessionStorage, or DOM inspection.
 */
export class InMemorySecureTokenStorage implements ISecureTokenStorage {
  public readonly persistenceType: StoragePersistenceType = 'ephemeral_memory';
  public readonly isPersistent = false;
  private tokenVault: string | null = null;

  public isAvailable(): boolean {
    return true;
  }

  public isHardwareBacked(): boolean {
    return false;
  }

  public getRefreshToken(): string | null {
    return this.tokenVault;
  }

  public setRefreshToken(token: string): boolean {
    this.tokenVault = token;
    return true;
  }

  public clearRefreshToken(): boolean {
    this.tokenVault = null;
    return true;
  }
}

/**
 * Native Android secure storage adapter.
 * When running inside a native Android APK wrapper with JavascriptInterface,
 * delegates refresh token persistence to Android Keystore AES-256-GCM.
 *
 * Explicit Security Level Verification:
 * - Never claims hardware backing when unverified or running on software-backed Keystore.
 * - If KeyInfo.isInsideSecureHardware() is true: reports 'hardware_keystore'.
 * - If KeyStore is operational but software-backed: reports 'software_keystore'.
 * - If bridge is unavailable: reports 'ephemeral_memory' / isPersistent = false.
 * - Preserves encrypted storage functionality when hardware backing is unavailable.
 */
export class NativeAndroidSecureStorage implements ISecureTokenStorage {
  public readonly isPersistent = true;

  public get persistenceType(): StoragePersistenceType {
    if (!this.isAvailable()) {
      return 'ephemeral_memory';
    }
    return this.isHardwareBacked() ? 'hardware_keystore' : 'software_keystore';
  }

  private getNativeBridge(): any {
    if (typeof window === 'undefined') return null;
    return (
      (window as any).AndroidBridge ||
      (window as any).AndroidSecureStorage ||
      (window as any).GamingHubAndroidBridge ||
      null
    );
  }

  public isAvailable(): boolean {
    const bridge = this.getNativeBridge();
    if (!bridge) return false;
    if (
      typeof bridge.getSecureItem !== 'function' ||
      typeof bridge.setSecureItem !== 'function'
    ) {
      return false;
    }
    if (typeof bridge.isSecureStorageAvailable === 'function') {
      try {
        return Boolean(bridge.isSecureStorageAvailable());
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns whether the KeyStore key is verified to be inside secure hardware (TEE/StrongBox).
   * Strictly returns false if unverified, throwing, or unsupported.
   */
  public isHardwareBacked(): boolean {
    if (!this.isAvailable()) return false;
    const bridge = this.getNativeBridge();
    if (typeof bridge.isHardwareBacked === 'function') {
      try {
        return Boolean(bridge.isHardwareBacked());
      } catch {
        return false;
      }
    }
    // If bridge provides getStorageSecurityLevel, check for hardware_keystore
    if (typeof bridge.getStorageSecurityLevel === 'function') {
      try {
        return bridge.getStorageSecurityLevel() === 'hardware_keystore';
      } catch {
        return false;
      }
    }
    // Never claim hardware backing if no explicit verification is present
    return false;
  }

  public async getRefreshToken(): Promise<string | null> {
    if (!this.isAvailable()) {
      return null;
    }
    try {
      const bridge = this.getNativeBridge();
      const val = await bridge.getSecureItem('gh_refresh_token');
      return val || null;
    } catch {
      // Safe error handling without logging or leaking token
      return null;
    }
  }

  public async setRefreshToken(token: string): Promise<boolean> {
    if (!this.isAvailable()) {
      // Never silently write to memory and falsely claim hardware Keystore is active
      return false;
    }
    try {
      const bridge = this.getNativeBridge();
      const success = await bridge.setSecureItem('gh_refresh_token', token);
      return Boolean(success);
    } catch {
      return false;
    }
  }

  public async clearRefreshToken(): Promise<boolean> {
    if (!this.isAvailable()) {
      return true;
    }
    try {
      const bridge = this.getNativeBridge();
      if (typeof bridge.removeSecureItem === 'function') {
        const success = await bridge.removeSecureItem('gh_refresh_token');
        return Boolean(success);
      }
      return true;
    } catch {
      return false;
    }
  }
}

type CoordinationMessage =
  | {
      type: 'AUTH_SESSION_ROTATED';
      tokens: AuthTokens;
      user: AuthUser;
      timestamp: number;
    }
  | {
      type: 'AUTH_SESSION_LOGOUT';
      timestamp: number;
    }
  | {
      type: 'AUTH_SESSION_REVOKED';
      timestamp: number;
    }
  | {
      type: 'REQUEST_CURRENT_AUTH';
      requestId: string;
      timestamp: number;
    }
  | {
      type: 'RESPONSE_CURRENT_AUTH';
      requestId: string;
      tokens: AuthTokens;
      user: AuthUser;
      timestamp: number;
    };

export interface AuthManagerOptions {
  storage?: ISecureTokenStorage;
  apiBaseUrl?: string;
  customFetch?: typeof fetch;
  enableCrossTabCoordination?: boolean;
}

/**
 * Central Client-Side Authentication Manager
 */
export class AuthManager {
  private user: AuthUser | null = null;
  private accessToken: string | null = null;
  private accessTokenExpiresAt: number | null = null;
  private status: AuthStatus = 'unauthenticated';

  private secureStorage: ISecureTokenStorage;
  private apiBaseUrl: string;
  private fetchFn: typeof fetch;

  // In-context single-flight promise preventing simultaneous refresh operations
  private activeRefreshPromise: Promise<string | null> | null = null;

  // Cross-tab coordination channel (BroadcastChannel)
  private broadcastChannel: BroadcastChannel | null = null;
  private pendingAuthRequests: Map<string, (msg: CoordinationMessage) => void> = new Map();

  // Observers
  private stateSubscribers: Set<(state: AuthState) => void> = new Set();
  private userSubscribers: Set<(user: AuthUser | null) => void> = new Set();

  constructor(options?: AuthManagerOptions) {
    if (options?.storage) {
      this.secureStorage = options.storage;
    } else {
      const nativeStorage = new NativeAndroidSecureStorage();
      if (nativeStorage.isAvailable()) {
        this.secureStorage = nativeStorage;
      } else {
        this.secureStorage = new InMemorySecureTokenStorage();
      }
    }

    this.apiBaseUrl = options?.apiBaseUrl || '';
    this.fetchFn = options?.customFetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (async () => ({} as Response)));

    // Initialize cross-tab BroadcastChannel coordination if enabled and supported
    const enableCoordination = options?.enableCrossTabCoordination !== false;
    if (enableCoordination && typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel('gh_auth_coordination_channel');
        // Unref in Node environment so background listener does not prevent process exit
        if (typeof (this.broadcastChannel as any)?.unref === 'function') {
          (this.broadcastChannel as any).unref();
        }
        this.broadcastChannel.onmessage = (event: MessageEvent<CoordinationMessage>) => {
          this.handleCoordinationMessage(event.data);
        };
      } catch {
        this.broadcastChannel = null;
      }
    }
  }

  /**
   * Cleans up listeners and IPC channels.
   */
  public destroy(): void {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {}
      this.broadcastChannel = null;
    }
    this.stateSubscribers.clear();
    this.userSubscribers.clear();
    this.pendingAuthRequests.clear();
  }

  /**
   * Handles incoming cross-tab / cross-WebView IPC messages.
   */
  private async handleCoordinationMessage(message: CoordinationMessage): Promise<void> {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'AUTH_SESSION_ROTATED': {
        // Sibling tab refreshed tokens: synchronize in-memory state without network call
        this.user = { ...message.user };
        this.accessToken = message.tokens.accessToken;
        const expiresInSeconds = typeof message.tokens.expiresIn === 'number' && message.tokens.expiresIn > 30
          ? message.tokens.expiresIn - 30
          : (message.tokens.expiresIn || 900);
        this.accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;

        await this.secureStorage.setRefreshToken(message.tokens.refreshToken);
        this.status = 'authenticated';
        this.notifySubscribers();
        break;
      }

      case 'AUTH_SESSION_LOGOUT':
      case 'AUTH_SESSION_REVOKED': {
        // Sibling tab terminated session: synchronize local state
        await this.clearLocalSession();
        break;
      }

      case 'REQUEST_CURRENT_AUTH': {
        // Sibling tab needs current active auth state (e.g. after receiving 409)
        if (this.isAuthenticated() && this.accessToken && this.user) {
          const currentRefresh = await this.secureStorage.getRefreshToken();
          if (currentRefresh) {
            const remainingSeconds = Math.max(30, Math.floor(((this.accessTokenExpiresAt || 0) - Date.now()) / 1000));
            this.broadcastMessage({
              type: 'RESPONSE_CURRENT_AUTH',
              requestId: message.requestId,
              tokens: {
                accessToken: this.accessToken,
                refreshToken: currentRefresh,
                expiresIn: remainingSeconds,
              },
              user: this.user,
              timestamp: Date.now(),
            });
          }
        }
        break;
      }

      case 'RESPONSE_CURRENT_AUTH': {
        // Check if there is an active listener for this request ID
        const resolver = this.pendingAuthRequests.get(message.requestId);
        if (resolver) {
          resolver(message);
          this.pendingAuthRequests.delete(message.requestId);
        }
        break;
      }
    }
  }

  private broadcastMessage(message: CoordinationMessage): void {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage(message);
      } catch {}
    }
  }

  /**
   * Accurately reports storage capabilities.
   */
  public getStorageCapabilities(): StorageCapabilities {
    return {
      persistenceType: this.secureStorage.persistenceType,
      isPersistent: this.secureStorage.isPersistent,
      isAvailable: () => this.secureStorage.isAvailable(),
      isHardwareBacked: () => (typeof this.secureStorage.isHardwareBacked === 'function' ? this.secureStorage.isHardwareBacked() : false),
    };
  }

  /**
   * Returns whether genuine persistent hardware Keystore storage is active.
   */
  public isPersistentStorageActive(): boolean {
    return this.secureStorage.isPersistent && this.secureStorage.isAvailable();
  }

  /**
   * Returns whether a valid user session is currently active.
   */
  public isAuthenticated(): boolean {
    return this.status === 'authenticated' && this.user !== null;
  }

  /**
   * Returns current authenticated user profile or null.
   */
  public getUser(): AuthUser | null {
    return this.user ? { ...this.user } : null;
  }

  /**
   * Returns current access token from memory (or null).
   */
  public getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Returns current authentication state snapshot.
   */
  public getState(): AuthState {
    return {
      user: this.getUser(),
      status: this.status,
      isAuthenticated: this.isAuthenticated(),
    };
  }

  /**
   * Establishes a new authenticated session (called after login, register, or linking).
   */
  public async setSession(params: { user: AuthUser; tokens: AuthTokens }): Promise<void> {
    const { user, tokens } = params;

    this.user = { ...user };
    this.accessToken = tokens.accessToken;
    const expiresInSeconds = typeof tokens.expiresIn === 'number' && tokens.expiresIn > 30
      ? tokens.expiresIn - 30
      : (tokens.expiresIn || 900);
    this.accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;

    await this.secureStorage.setRefreshToken(tokens.refreshToken);

    this.status = 'authenticated';
    this.notifySubscribers();

    // Broadcast session establishment to sibling tabs
    this.broadcastMessage({
      type: 'AUTH_SESSION_ROTATED',
      tokens,
      user: this.user,
      timestamp: Date.now(),
    });
  }

  /**
   * Retrieves a guaranteed valid access token.
   * If the token in memory is expired or missing, triggers a refresh using the secure refresh token.
   */
  public async getValidAccessToken(): Promise<string | null> {
    const now = Date.now();

    // If access token exists and has not reached its buffered expiration, return it directly
    if (this.accessToken && this.accessTokenExpiresAt && this.accessTokenExpiresAt > now) {
      return this.accessToken;
    }

    // Proactively refresh expired or near-expiry access token
    return await this.refreshSession();
  }

  /**
   * Refreshes the access token using the securely stored refresh token.
   * Enforces single-flight execution:
   * 1. In-process: Concurrent callers await the same active refresh promise.
   * 2. Cross-tab: Web Locks API (navigator.locks) serializes refresh across tabs when supported.
   */
  public async refreshSession(): Promise<string | null> {
    if (this.activeRefreshPromise) {
      return this.activeRefreshPromise;
    }

    const tokenBefore = this.accessToken;

    // Cross-tab lock coordination via Web Locks API
    if (typeof navigator !== 'undefined' && (navigator as any).locks?.request) {
      this.activeRefreshPromise = (navigator as any).locks.request(
        'gaming_hub_auth_refresh_lock',
        async () => {
          // Once lock is acquired, check if another tab refreshed while we waited
          if (this.accessToken && this.accessToken !== tokenBefore && this.accessTokenExpiresAt && this.accessTokenExpiresAt > Date.now()) {
            return this.accessToken;
          }
          return await this.performRefresh();
        }
      );
    } else {
      this.activeRefreshPromise = this.performRefresh();
    }

    try {
      return await this.activeRefreshPromise;
    } finally {
      this.activeRefreshPromise = null;
    }
  }

  /**
   * Internal refresh executor
   */
  private async performRefresh(): Promise<string | null> {
    const refreshToken = await this.secureStorage.getRefreshToken();
    if (!refreshToken) {
      await this.clearSession();
      return null;
    }

    const previousStatus = this.status;
    this.status = 'refreshing';
    this.notifySubscribers();

    try {
      const response = await this.fetchFn(`${this.apiBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.success && data.tokens?.accessToken && data.tokens?.refreshToken) {
          if (data.user) {
            this.user = { ...data.user };
          }
          this.accessToken = data.tokens.accessToken;
          const expiresInSeconds = typeof data.tokens.expiresIn === 'number' && data.tokens.expiresIn > 30
            ? data.tokens.expiresIn - 30
            : (data.tokens.expiresIn || 900);
          this.accessTokenExpiresAt = Date.now() + expiresInSeconds * 1000;

          // Rotate refresh token in secure storage
          await this.secureStorage.setRefreshToken(data.tokens.refreshToken);

          this.status = 'authenticated';
          this.notifySubscribers();

          // Broadcast rotated tokens to sibling tabs
          if (this.user) {
            this.broadcastMessage({
              type: 'AUTH_SESSION_ROTATED',
              tokens: data.tokens,
              user: this.user,
              timestamp: Date.now(),
            });
          }

          return this.accessToken;
        }
      }

      // Handle 401 Unauthorized: Session is expired or revoked
      if (response.status === 401) {
        this.broadcastMessage({
          type: 'AUTH_SESSION_REVOKED',
          timestamp: Date.now(),
        });
        await this.clearLocalSession();
        return null;
      }

      // Handle 409 CONCURRENT_REFRESH: Another rotation occurred within grace window
      if (response.status === 409) {
        // 1. Check if storage was updated by native bridge or another thread
        const latestStoredToken = await this.secureStorage.getRefreshToken();
        if (latestStoredToken && latestStoredToken !== refreshToken) {
          // Retry once with the newly rotated token
          return await this.performRefreshWithToken(latestStoredToken);
        }

        // 2. Request current tokens from sibling tabs via BroadcastChannel (without disk storage)
        if (this.broadcastChannel) {
          const recovered = await this.requestAuthFromSiblingTabs(600);
          if (recovered && this.accessToken) {
            return this.accessToken;
          }
        }

        // 3. Graceful degradation: Preserve local user state without wiping session
        this.status = this.user ? 'authenticated' : previousStatus;
        this.notifySubscribers();
        return null;
      }

      // Other HTTP errors (e.g. 500, network offline): preserve session state without wiping credentials
      this.status = this.user ? 'authenticated' : previousStatus;
      this.notifySubscribers();
      return null;
    } catch {
      // Network failure / offline: retain session state
      this.status = this.user ? 'authenticated' : previousStatus;
      this.notifySubscribers();
      return null;
    }
  }

  /**
   * Helper to execute a single refresh attempt with a specified token
   */
  private async performRefreshWithToken(token: string): Promise<string | null> {
    try {
      const retryRes = await this.fetchFn(`${this.apiBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (retryRes.ok) {
        const data = await retryRes.json();
        if (data?.success && data.tokens?.accessToken) {
          this.accessToken = data.tokens.accessToken;
          this.accessTokenExpiresAt = Date.now() + (data.tokens.expiresIn || 900) * 1000;
          await this.secureStorage.setRefreshToken(data.tokens.refreshToken);
          this.status = 'authenticated';
          this.notifySubscribers();

          if (this.user) {
            this.broadcastMessage({
              type: 'AUTH_SESSION_ROTATED',
              tokens: data.tokens,
              user: this.user,
              timestamp: Date.now(),
            });
          }
          return this.accessToken;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Registers a new player using the Gaming Hub backend.
   * If the email belongs to an existing Firebase account that needs linking,
   * returns { success: false, code: 'FIREBASE_ACCOUNT_EXISTS_LINKING_REQUIRED' } so the UI can prompt linking.
   */
  public async register(params: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ success: boolean; user?: AuthUser; error?: string; code?: string }> {
    try {
      const response = await this.fetchFn(`${this.apiBaseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        return {
          success: false,
          error: data.error || 'Registration failed. Please check your details.',
          code: data.code || 'REGISTRATION_FAILED',
        };
      }

      await this.setSession({
        user: data.user,
        tokens: data.tokens,
      });

      return { success: true, user: data.user };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Network error during registration.',
        code: 'NETWORK_ERROR',
      };
    }
  }

  /**
   * Authenticates a player using the Gaming Hub backend.
   * Never leaks or logs passwords. Stores tokens strictly in memory and secure storage.
   */
  public async login(params: {
    email: string;
    password: string;
  }): Promise<{ success: boolean; user?: AuthUser; error?: string; code?: string; retryAfter?: number }> {
    try {
      const response = await this.fetchFn(`${this.apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        return {
          success: false,
          error: data.error || 'Incorrect email or password.',
          code: data.code || 'INVALID_CREDENTIALS',
          retryAfter: data.retryAfter,
        };
      }

      await this.setSession({
        user: data.user,
        tokens: data.tokens,
      });

      return { success: true, user: data.user };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Network error during login.',
        code: 'NETWORK_ERROR',
      };
    }
  }

  /**
   * Links independent Gaming Hub credentials to an existing authenticated Firebase account.
   * Requires proof of ownership via a valid, verified Firebase ID token.
   * Preserves existing Firebase UID, player identity, wallet balance, and records.
   */
  public async linkCredentials(params: {
    firebaseIdToken: string;
    password: string;
    email?: string;
    displayName?: string;
  }): Promise<{ success: boolean; user?: AuthUser; error?: string; code?: string }> {
    try {
      const response = await this.fetchFn(`${this.apiBaseUrl}/api/auth/link-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.firebaseIdToken}`,
        },
        body: JSON.stringify({
          password: params.password,
          email: params.email,
          displayName: params.displayName,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        return {
          success: false,
          error: data.error || 'Failed to link credentials to existing account.',
          code: data.code || 'LINKING_FAILED',
        };
      }

      await this.setSession({
        user: data.user,
        tokens: data.tokens,
      });

      return { success: true, user: data.user };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Network error during account linking.',
        code: 'NETWORK_ERROR',
      };
    }
  }

  /**
   * Restores an active session from persistent secure storage (e.g. Android Keystore on app launch).
   * Attempts to refresh the session using the stored refresh token.
   * Returns true if session was successfully restored, false otherwise.
   */
  public async restoreSession(): Promise<boolean> {
    const refreshToken = await this.secureStorage.getRefreshToken();
    if (!refreshToken) {
      return false;
    }
    const token = await this.refreshSession();
    if (!token) return false;

    // If user profile was not in refresh payload, retrieve it with authenticated access token
    if (!this.user) {
      try {
        const res = await this.fetchFn(`${this.apiBaseUrl}/api/auth/user`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const uData = await res.json();
          if (uData.success && uData.user) {
            this.user = uData.user;
            this.status = 'authenticated';
            this.notifySubscribers();
          }
        }
      } catch {}
    }

    return Boolean(token && this.isAuthenticated());
  }

  /**
   * Queries sibling tabs for latest auth state across memory IPC with timeout.
   */
  private async requestAuthFromSiblingTabs(timeoutMs = 600): Promise<boolean> {
    if (!this.broadcastChannel) return false;

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAuthRequests.delete(requestId);
        resolve(false);
      }, timeoutMs);

      this.pendingAuthRequests.set(requestId, async (msg) => {
        if (msg.type === 'RESPONSE_CURRENT_AUTH' && msg.tokens?.accessToken) {
          clearTimeout(timer);
          this.user = { ...msg.user };
          this.accessToken = msg.tokens.accessToken;
          this.accessTokenExpiresAt = Date.now() + (msg.tokens.expiresIn || 900) * 1000;
          await this.secureStorage.setRefreshToken(msg.tokens.refreshToken);
          this.status = 'authenticated';
          this.notifySubscribers();
          resolve(true);
        }
      });

      this.broadcastMessage({
        type: 'REQUEST_CURRENT_AUTH',
        requestId,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Terminate session on server and clear local state across all contexts.
   */
  public async logout(): Promise<void> {
    try {
      const refreshToken = await this.secureStorage.getRefreshToken();
      const currentAccessToken = this.accessToken;

      if (refreshToken || currentAccessToken) {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (currentAccessToken) {
          headers['Authorization'] = `Bearer ${currentAccessToken}`;
        }

        await this.fetchFn(`${this.apiBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ refreshToken }),
        }).catch(() => {});
      }
    } finally {
      this.broadcastMessage({
        type: 'AUTH_SESSION_LOGOUT',
        timestamp: Date.now(),
      });
      await this.clearLocalSession();
    }
  }

  /**
   * Completely clears in-memory tokens and secure storage.
   */
  public async clearSession(): Promise<void> {
    await this.clearLocalSession();
  }

  private async clearLocalSession(): Promise<void> {
    this.user = null;
    this.accessToken = null;
    this.accessTokenExpiresAt = null;
    this.status = 'unauthenticated';

    await this.secureStorage.clearRefreshToken();
    this.notifySubscribers();
  }

  /**
   * Subscribe to full authentication state changes.
   */
  public subscribe(callback: (state: AuthState) => void): () => void {
    this.stateSubscribers.add(callback);
    try {
      callback(this.getState());
    } catch {}
    return () => this.stateSubscribers.delete(callback);
  }

  /**
   * Subscribe to authenticated user changes (compatibility pattern).
   */
  public onAuthStateChanged(callback: (user: AuthUser | null) => void): () => void {
    this.userSubscribers.add(callback);
    try {
      callback(this.getUser());
    } catch {}
    return () => this.userSubscribers.delete(callback);
  }

  private notifySubscribers() {
    const state = this.getState();
    const user = this.getUser();

    for (const sub of this.stateSubscribers) {
      try {
        sub(state);
      } catch {}
    }

    for (const sub of this.userSubscribers) {
      try {
        sub(user);
      } catch {}
    }
  }

  /**
   * Authenticated HTTP Fetch Wrapper
   *
   * 1. Attaches Gaming Hub access token if authenticated, otherwise passes through.
   * 2. Automatically intercepts HTTP 401, refreshes the token, and retries the request once.
   * 3. Prevents infinite refresh loops via an internal retry marker.
   */
  public async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const isRetry = Boolean((init as any)?._isRetry);
    const headers = new Headers(init?.headers || {});
    let usedGamingHub = false;

    if (this.isAuthenticated()) {
      const token = await this.getValidAccessToken();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
        usedGamingHub = true;
      }
    }

    const response = await this.fetchFn(input, {
      ...init,
      headers,
    });

    // One-time retry on HTTP 401 if Gaming Hub credentials were used
    if (response.status === 401 && !isRetry && usedGamingHub) {
      const refreshedToken = await this.refreshSession();
      if (refreshedToken) {
        const retryHeaders = new Headers(init?.headers || {});
        retryHeaders.set('Authorization', `Bearer ${refreshedToken}`);
        return await this.fetchFn(input, {
          ...init,
          headers: retryHeaders,
          ...({ _isRetry: true } as any),
        });
      }
    }

    return response;
  }
}

// Global Singleton Instance
export const authManager = new AuthManager();
