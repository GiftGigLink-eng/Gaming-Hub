import { Firestore } from 'firebase-admin/firestore';
import crypto from 'crypto';
import { getAdminApp } from '../firebaseAdmin.js';
import firebaseConfig from '../../../firebase-applet-config.json';
import { getFirestore } from 'firebase-admin/firestore';
import { UserProfile, Wallet } from '../../types.js';

export interface AuthCredential {
  userId: string;
  email: string;
  passwordHash: string;
  failedLoginAttempts: number;
  lockUntil: number | null; // Milliseconds epoch timestamp
  createdAt: string;
  updatedAt: string;
}

export interface EmailIndexRecord {
  emailKey: string;
  email: string;
  userId: string;
  createdAt: string;
}

export type SessionRevocationReason =
  | 'logout'
  | 'replay_attack_detected'
  | 'expired'
  | 'admin_revocation';

export interface ConsumedTokenRecord {
  hash: string;
  consumedAt: number; // Milliseconds epoch timestamp
}

export interface RecoveryRecord {
  consumedHash: string;
  idempotencyKeyHash: string;
  consumedAt: number; // Milliseconds epoch timestamp
}

export const REFRESH_GRACE_WINDOW_MS = 25000; // 25 seconds grace window for concurrent requests / tab races

/**
 * EXACT REPLAY-DETECTION RETENTION BOUNDARY:
 * History is bounded to the 10 most recent consumed tokens (MAX_CONSUMED_TOKEN_HISTORY = 10).
 * Once a session rotates past 10 generations, the oldest consumed token hashes are permanently evicted
 * from the document to maintain bounded document size (<1KB).
 * If an evicted token hash is presented, the server CANNOT match it to any session family and rejects
 * it with HTTP 401 AUTH_TOKEN_INVALID (fail-closed against authentication), but cannot trigger
 * family revocation for that session.
 */
export const MAX_CONSUMED_TOKEN_HISTORY = 10;

export interface SessionLookupResult {
  session: AuthSession;
  isCurrent: boolean;
  isConsumed: boolean;
  consumedRecord?: ConsumedTokenRecord;
}

export interface AuthSession {
  sessionId: string;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  previousRefreshTokenHash?: string | null;
  consumedTokenHashes?: ConsumedTokenRecord[];
  consumedHashesList?: string[]; // Array of strings for indexed querying in Firestore
  recoveryRecord?: RecoveryRecord | null; // Cryptographically bound lost-response recovery state
  isRevoked: boolean;
  revokedReason?: SessionRevocationReason | null;
  expiresAt: number; // Milliseconds epoch timestamp
  createdAt: string;
  lastRotatedAt: string;
  userAgent?: string;
  ip?: string;
}



export class AuthRepository {
  private _db: Firestore | null = null;
  private _isExplicitDb = false;
  private _defaultDbPending = false;
  // In-memory fallback stores for tests or environments without Firestore connection
  private memoryCredentialsByUserId = new Map<string, AuthCredential>();
  private memoryCredentialsByEmail = new Map<string, string>(); // email -> userId
  private memoryEmailIndex = new Map<string, EmailIndexRecord>(); // emailKey -> EmailIndexRecord
  private memorySessions = new Map<string, AuthSession>(); // sessionId -> session
  private memoryUsers = new Map<string, UserProfile>();
  private memoryWallets = new Map<string, Wallet>();

  public static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  public static computeEmailKey(email: string): string {
    const normalized = AuthRepository.normalizeEmail(email);
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  constructor(customDb?: Firestore | null) {
    if (customDb !== undefined) {
      this._db = customDb;
      this._isExplicitDb = customDb !== null;
      this._defaultDbPending = false;
    } else if (process.env.NODE_ENV === 'production') {
      this._defaultDbPending = true;
      this.ensureDbInitialized();
    } else {
      this._defaultDbPending = true;
    }
  }

  private ensureDbInitialized(): void {
    if (!this._defaultDbPending) {
      return;
    }
    this._defaultDbPending = false;
    try {
      const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
      this._db = getFirestore(getAdminApp(), databaseId);
      this._isExplicitDb = this._db !== null;
    } catch (err: any) {
      console.warn('[AuthRepository] Firestore Admin SDK unavailable, using resilient in-memory storage fallback:', err.message);
      this._db = null;
      this._isExplicitDb = false;
    }
  }

  private get db(): Firestore | null {
    this.ensureDbInitialized();
    return this._db;
  }

  private get isExplicitDb(): boolean {
    this.ensureDbInitialized();
    return this._isExplicitDb;
  }

  public getFirestoreInstance(): Firestore | null {
    return this.db;
  }

  /**
   * Test-only configuration hook to attach or detach Firestore from the repository instance.
   * Passing `null` forces the repository to operate strictly in-memory without contacting Google Cloud.
   * Strictly prohibited outside of explicit test environments (NODE_ENV must be 'test').
   */
  public setTestFirestoreInstance(customDb: Firestore | null): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        `setTestFirestoreInstance is only permitted when NODE_ENV === 'test'. Current environment: '${process.env.NODE_ENV || 'undefined'}'.`
      );
    }
    this._db = customDb;
    this._isExplicitDb = customDb !== null;
    this._defaultDbPending = false;
  }

  /**
   * Reset in-memory state (useful for isolated unit tests)
   */
  public resetInMemory(): void {
    this.memoryCredentialsByUserId.clear();
    this.memoryCredentialsByEmail.clear();
    this.memoryEmailIndex.clear();
    this.memorySessions.clear();
    this.memoryUsers.clear();
    this.memoryWallets.clear();
    this.testFaultInjection = {};
  }

  private testFaultInjection: {
    failOnProfile?: boolean;
    failOnWallet?: boolean;
  } = {};

  /**
   * Test-only fault injection hook for verifying transactional rollback under partial failures.
   */
  public setTestFaultInjection(faults: { failOnProfile?: boolean; failOnWallet?: boolean }): void {
    if (process.env.NODE_ENV !== 'test') return;
    this.testFaultInjection = { ...faults };
  }

  /**
   * Reads the deterministic auth_email_index/{emailKey} document for a normalized email.
   */
  public async getEmailIndex(email: string): Promise<EmailIndexRecord | null> {
    const emailKey = AuthRepository.computeEmailKey(email);

    if (this.isExplicitDb && this.db) {
      const doc = await this.db.collection('auth_email_index').doc(emailKey).get();
      if (!doc.exists) return null;
      return doc.data() as EmailIndexRecord;
    }

    if (!this.db) {
      return this.memoryEmailIndex.get(emailKey) || null;
    }

    try {
      const doc = await this.db.collection('auth_email_index').doc(emailKey).get();
      if (doc.exists) return doc.data() as EmailIndexRecord;
    } catch {
      // Fallback to memory mirror
    }
    return this.memoryEmailIndex.get(emailKey) || null;
  }

  /**
   * Test-only helper to remove an email index entry (simulating legacy pre-index records).
   */
  public deleteEmailIndexForTest(email: string): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('deleteEmailIndexForTest is only permitted when NODE_ENV === "test".');
    }
    const emailKey = AuthRepository.computeEmailKey(email);
    this.memoryEmailIndex.delete(emailKey);
  }

  /**
   * Test-only helper to seed a deterministic email index entry (simulating pre-existing index collision).
   */
  public seedEmailIndexForTest(email: string, userId: string, createdAt = new Date().toISOString()): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('seedEmailIndexForTest is only permitted when NODE_ENV === "test".');
    }
    const normalized = email.trim().toLowerCase();
    const emailKey = AuthRepository.computeEmailKey(normalized);
    this.memoryEmailIndex.set(emailKey, {
      emailKey,
      email: normalized,
      userId,
      createdAt,
    });
  }

  /**
   * Test/Emulator-only helper to seed a legacy credential directly without creating
   * auth_email_index or forcing normalization (for simulating pre-index / mixed-case records).
   * Strictly prohibited in production environments.
   */
  public async seedLegacyCredentialForTest(
    credential: AuthCredential,
    options: { skipIndex?: boolean; preserveRawEmail?: boolean } = {}
  ): Promise<void> {
    if (process.env.NODE_ENV !== 'test' && !process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('seedLegacyCredentialForTest is only permitted in test or emulator environments.');
    }

    const emailToStore = options.preserveRawEmail
      ? credential.email
      : AuthRepository.normalizeEmail(credential.email);
    const credToStore: AuthCredential = {
      ...credential,
      email: emailToStore,
    };

    if (this.isExplicitDb && this.db) {
      await this.db.collection('auth_credentials').doc(credToStore.userId).set(credToStore);
      if (options.skipIndex === false) {
        const normalized = AuthRepository.normalizeEmail(emailToStore);
        const emailKey = AuthRepository.computeEmailKey(normalized);
        await this.db.collection('auth_email_index').doc(emailKey).set({
          emailKey,
          email: normalized,
          userId: credToStore.userId,
          createdAt: credToStore.createdAt,
        });
      }
      return;
    }

    this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
    this.memoryCredentialsByEmail.set(emailToStore, credToStore.userId);
    if (options.skipIndex === false) {
      const normalized = AuthRepository.normalizeEmail(emailToStore);
      const emailKey = AuthRepository.computeEmailKey(normalized);
      this.memoryEmailIndex.set(emailKey, {
        emailKey,
        email: normalized,
        userId: credToStore.userId,
        createdAt: credToStore.createdAt,
      });
    }
  }

  /**
   * Safely backfills auth_email_index/{emailKey} for legacy credentials created before
   * the deterministic email index existed.
   *
   * Rules:
   * - Never overwrites an existing auth_email_index document.
   * - Verifies the credential for userId exists and matches the normalized email.
   * - If an index already exists for another UID, leaves it intact and returns 'conflict'.
   */
  public async ensureEmailIndex(
    userId: string,
    email: string,
    createdAt?: string
  ): Promise<'created' | 'exists' | 'conflict' | 'not_found'> {
    const normalized = email.trim().toLowerCase();
    const emailKey = AuthRepository.computeEmailKey(normalized);

    if (this.db) {
      const emailIndexRef = this.db.collection('auth_email_index').doc(emailKey);
      const credRef = this.db.collection('auth_credentials').doc(userId);

      const outcome = await this.db.runTransaction(async (transaction) => {
        const [credSnap, indexSnap] = await Promise.all([
          transaction.get(credRef),
          transaction.get(emailIndexRef),
        ]);

        if (!credSnap.exists) {
          return { status: 'not_found' as const, record: null };
        }
        const credData = credSnap.data() as AuthCredential;
        if (credData.email.trim().toLowerCase() !== normalized) {
          return { status: 'conflict' as const, record: null };
        }

        if (indexSnap.exists) {
          const existingIndex = indexSnap.data() as EmailIndexRecord;
          if (existingIndex.userId === userId) {
            return { status: 'exists' as const, record: existingIndex };
          }
          return { status: 'conflict' as const, record: existingIndex };
        }

        const record: EmailIndexRecord = {
          emailKey,
          email: normalized,
          userId,
          createdAt: createdAt || credData.createdAt || new Date().toISOString(),
        };
        transaction.set(emailIndexRef, record);
        return { status: 'created' as const, record };
      });

      if (outcome.record && !this.isExplicitDb) {
        this.memoryEmailIndex.set(emailKey, outcome.record);
      }
      if (outcome.status === 'conflict') {
        console.warn(`[AuthRepository] Lazy email index backfill skipped due to ownership mismatch for emailKey=${emailKey}`);
      }
      return outcome.status;
    }

    // In-memory atomic check
    const cred = this.memoryCredentialsByUserId.get(userId);
    if (!cred) return 'not_found';
    if (cred.email.trim().toLowerCase() !== normalized) return 'conflict';

    const existingIndex = this.memoryEmailIndex.get(emailKey);
    if (existingIndex) {
      if (existingIndex.userId === userId) return 'exists';
      console.warn(`[AuthRepository] Lazy email index backfill skipped due to ownership mismatch for emailKey=${emailKey}`);
      return 'conflict';
    }

    const record: EmailIndexRecord = {
      emailKey,
      email: normalized,
      userId,
      createdAt: createdAt || cred.createdAt || new Date().toISOString(),
    };
    this.memoryEmailIndex.set(emailKey, record);
    return 'created';
  }

  // --- Credential Operations ---

  public async getCredentialByEmail(email: string): Promise<AuthCredential | null> {
    const normalized = AuthRepository.normalizeEmail(email);
    const emailKey = AuthRepository.computeEmailKey(normalized);

    const findLegacyInMemory = (): AuthCredential | null => {
      for (const cred of this.memoryCredentialsByUserId.values()) {
        if (AuthRepository.normalizeEmail(cred.email) === normalized) {
          return cred;
        }
      }
      const mappedUid = this.memoryCredentialsByEmail.get(normalized);
      if (mappedUid) {
        return this.memoryCredentialsByUserId.get(mappedUid) || null;
      }
      return null;
    };

    const findInFirestore = async (): Promise<AuthCredential | null> => {
      if (!this.db) return null;

      // 1. O(1) deterministic index lookup (works even if legacy cred doc has unnormalized email)
      const indexDoc = await this.db.collection('auth_email_index').doc(emailKey).get();
      if (indexDoc.exists) {
        const indexData = indexDoc.data() as EmailIndexRecord;
        const credDoc = await this.db.collection('auth_credentials').doc(indexData.userId).get();
        if (credDoc.exists) {
          const cred = credDoc.data() as AuthCredential;
          if (AuthRepository.normalizeEmail(cred.email) === normalized) {
            return cred;
          }
        }
      }

      // 2. Indexed exact match query for normalized credentials
      const snapshot = await this.db
        .collection('auth_credentials')
        .where('email', '==', normalized)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        return snapshot.docs[0].data() as AuthCredential;
      }

      // 3. Read-only legacy fallback for pre-index records stored with mixed-case or whitespace
      const emailScan = await this.db.collection('auth_credentials').select('email').get();
      for (const docSnap of emailScan.docs) {
        const rawEmail = String(docSnap.data()?.email || '');
        if (AuthRepository.normalizeEmail(rawEmail) === normalized) {
          const fullDoc = await docSnap.ref.get();
          if (fullDoc.exists) {
            return fullDoc.data() as AuthCredential;
          }
        }
      }

      return null;
    };

    if (this.isExplicitDb && this.db) {
      return await findInFirestore();
    }

    if (!this.db) {
      return findLegacyInMemory();
    }

    try {
      const firestoreMatch = await findInFirestore();
      if (firestoreMatch) return firestoreMatch;
      return findLegacyInMemory();
    } catch {
      return findLegacyInMemory();
    }
  }

  public async getCredentialByUserId(userId: string): Promise<AuthCredential | null> {
    if (this.isExplicitDb && this.db) {
      const doc = await this.db.collection('auth_credentials').doc(userId).get();
      if (!doc.exists) return null;
      return doc.data() as AuthCredential;
    }

    if (!this.db) {
      return this.memoryCredentialsByUserId.get(userId) || null;
    }

    try {
      const doc = await this.db.collection('auth_credentials').doc(userId).get();
      if (!doc.exists) {
        return this.memoryCredentialsByUserId.get(userId) || null;
      }
      return doc.data() as AuthCredential;
    } catch (err) {
      return this.memoryCredentialsByUserId.get(userId) || null;
    }
  }

  /**
   * Enforces atomic email uniqueness and deterministic auth_email_index creation/validation
   * by delegating directly to createCredentialAtomic(). No unindexed credential bypass is allowed.
   */
  public async createCredential(credential: AuthCredential): Promise<void> {
    await this.createCredentialAtomic(credential);
  }

  /**
   * Atomically creates a credential and its deterministic auth_email_index/{emailKey}
   * record inside a single Firestore transaction.
   *
   * Guarantees:
   * - Reads deterministic email index doc inside the transaction (preventing phantom-write races).
   * - Falls back to querying legacy auth_credentials when the index doc is absent (never assumes availability).
   * - Never overwrites an existing credential or email index document.
   */
  public async createCredentialAtomic(credential: AuthCredential): Promise<void> {
    const normalized = credential.email.trim().toLowerCase();
    const emailKey = AuthRepository.computeEmailKey(normalized);
    const credToStore: AuthCredential = {
      ...credential,
      email: normalized,
    };
    const emailIndexToStore: EmailIndexRecord = {
      emailKey,
      email: normalized,
      userId: credToStore.userId,
      createdAt: credToStore.createdAt,
    };

    if (this.db) {
      const docRef = this.db.collection('auth_credentials').doc(credToStore.userId);
      const emailIndexRef = this.db.collection('auth_email_index').doc(emailKey);

      await this.db.runTransaction(async (transaction) => {
        const existingDoc = await transaction.get(docRef);
        if (existingDoc.exists) {
          const err: any = new Error('Credentials are already linked to this account.');
          err.code = 'CREDENTIALS_ALREADY_LINKED';
          throw err;
        }

        // 1. Deterministic email uniqueness index check inside transaction
        const emailIndexSnap = await transaction.get(emailIndexRef);
        if (emailIndexSnap.exists) {
          const indexData = emailIndexSnap.data() as EmailIndexRecord;
          if (indexData.userId !== credToStore.userId) {
            const err: any = new Error('Credentials for this email address already exist.');
            err.code = 'EMAIL_ALREADY_LINKED';
            throw err;
          }
        } else {
          // 2. Legacy compatibility fallback: check normalized equality + unnormalized legacy emails inside transaction
          const emailQuery = this.db!.collection('auth_credentials').where('email', '==', normalized).limit(1);
          const emailSnap = await transaction.get(emailQuery);
          if (!emailSnap.empty && emailSnap.docs[0].id !== credToStore.userId) {
            const err: any = new Error('Credentials for this email address already exist.');
            err.code = 'EMAIL_ALREADY_LINKED';
            throw err;
          }

          if (emailSnap.empty) {
            const legacyEmailScan = await transaction.get(this.db!.collection('auth_credentials').select('email'));
            for (const legacyDoc of legacyEmailScan.docs) {
              const rawEmail = String(legacyDoc.data()?.email || '');
              if (AuthRepository.normalizeEmail(rawEmail) === normalized && legacyDoc.id !== credToStore.userId) {
                const err: any = new Error('Credentials for this email address already exist.');
                err.code = 'EMAIL_ALREADY_LINKED';
                throw err;
              }
            }
          }
        }

        transaction.set(docRef, credToStore);
        if (!emailIndexSnap.exists) {
          transaction.set(emailIndexRef, emailIndexToStore);
        }
      });

      this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
      this.memoryCredentialsByEmail.set(normalized, credToStore.userId);
      if (!this.memoryEmailIndex.has(emailKey)) {
        this.memoryEmailIndex.set(emailKey, emailIndexToStore);
      }
      return;
    }

    if (this.memoryCredentialsByUserId.has(credToStore.userId)) {
      const err: any = new Error('Credentials are already linked to this account.');
      err.code = 'CREDENTIALS_ALREADY_LINKED';
      throw err;
    }

    const existingIndex = this.memoryEmailIndex.get(emailKey);
    if (existingIndex) {
      if (existingIndex.userId !== credToStore.userId) {
        const err: any = new Error('Credentials for this email address already exist.');
        err.code = 'EMAIL_ALREADY_LINKED';
        throw err;
      }
    } else {
      // Legacy fallback: check pre-index credentials in memory (including unnormalized mixed-case/whitespace)
      const legacyUid = this.memoryCredentialsByEmail.get(normalized);
      if (legacyUid && legacyUid !== credToStore.userId) {
        const err: any = new Error('Credentials for this email address already exist.');
        err.code = 'EMAIL_ALREADY_LINKED';
        throw err;
      }
      for (const [rawKey, uid] of this.memoryCredentialsByEmail.entries()) {
        if (AuthRepository.normalizeEmail(rawKey) === normalized && uid !== credToStore.userId) {
          const err: any = new Error('Credentials for this email address already exist.');
          err.code = 'EMAIL_ALREADY_LINKED';
          throw err;
        }
      }
      for (const cred of this.memoryCredentialsByUserId.values()) {
        if (AuthRepository.normalizeEmail(cred.email) === normalized && cred.userId !== credToStore.userId) {
          const err: any = new Error('Credentials for this email address already exist.');
          err.code = 'EMAIL_ALREADY_LINKED';
          throw err;
        }
      }
    }

    this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
    this.memoryCredentialsByEmail.set(normalized, credToStore.userId);
    if (!existingIndex) {
      this.memoryEmailIndex.set(emailKey, emailIndexToStore);
    }
  }

  /**
   * Atomically registers a new member: creates deterministic email index, credential,
   * user profile, and ₦0 wallet within a single atomic Firestore transaction.
   *
   * Guarantees:
   * 1. Deterministic document read on auth_email_index/{emailKey} inside the transaction
   *    eliminates phantom-write email races across distinct user IDs.
   * 2. Legacy compatibility fallback queries auth_credentials if index doc is absent.
   * 3. All 4 documents (auth_email_index, auth_credentials, users, wallets) are committed together atomically.
   * 4. If any write or validation fails, entire operation rolls back—no orphaned credentials or index left behind.
   * 5. Pre-existing email indexes, credentials, profiles, or wallets are never overwritten.
   */
  public async registerMemberAtomic(params: {
    credential: AuthCredential;
    profile: UserProfile & { email?: string };
    initialBalance?: number;
  }): Promise<{ user: UserProfile; wallet: Wallet }> {
    const { credential, profile, initialBalance = 0 } = params;
    const normalized = credential.email.trim().toLowerCase();
    const emailKey = AuthRepository.computeEmailKey(normalized);
    const credToStore: AuthCredential = {
      ...credential,
      email: normalized,
    };
    const emailIndexToStore: EmailIndexRecord = {
      emailKey,
      email: normalized,
      userId: credToStore.userId,
      createdAt: credToStore.createdAt,
    };

    const walletToStore: Wallet = {
      id: credToStore.userId,
      userId: credToStore.userId,
      balance: initialBalance,
      currency: 'NGN',
      updatedAt: new Date().toISOString(),
    };

    if (this.db) {
      const emailIndexRef = this.db.collection('auth_email_index').doc(emailKey);
      const credDocRef = this.db.collection('auth_credentials').doc(credToStore.userId);
      const userDocRef = this.db.collection('users').doc(credToStore.userId);
      const walletDocRef = this.db.collection('wallets').doc(credToStore.userId);

      await this.db.runTransaction(async (transaction) => {
        // 1. Transactional Reads First (required by Firestore)
        const existingCredDoc = await transaction.get(credDocRef);
        if (existingCredDoc.exists) {
          const err: any = new Error('Credentials already exist for this user ID.');
          err.code = 'CREDENTIALS_ALREADY_LINKED';
          throw err;
        }

        // Deterministic email uniqueness index check
        const emailIndexSnap = await transaction.get(emailIndexRef);
        if (emailIndexSnap.exists) {
          const err: any = new Error('An account with this email already exists.');
          err.code = 'EMAIL_ALREADY_IN_USE';
          throw err;
        }

        // Legacy fallback check: do not assume absent index means email is available
        const emailQuery = this.db!.collection('auth_credentials').where('email', '==', normalized).limit(1);
        const emailSnap = await transaction.get(emailQuery);
        if (!emailSnap.empty) {
          const err: any = new Error('An account with this email already exists.');
          err.code = 'EMAIL_ALREADY_IN_USE';
          throw err;
        }

        const legacyCredScan = await transaction.get(this.db!.collection('auth_credentials').select('email'));
        for (const legacyDoc of legacyCredScan.docs) {
          const rawEmail = String(legacyDoc.data()?.email || '');
          if (AuthRepository.normalizeEmail(rawEmail) === normalized) {
            const err: any = new Error('An account with this email already exists.');
            err.code = 'EMAIL_ALREADY_IN_USE';
            throw err;
          }
        }

        // Also guard against racing with an existing Firebase user profile that lacks credentials yet
        const userEmailQuery = this.db!.collection('users').where('email', '==', normalized).limit(1);
        const userEmailSnap = await transaction.get(userEmailQuery);
        if (!userEmailSnap.empty) {
          const err: any = new Error('An account with this email already exists.');
          err.code = 'EMAIL_ALREADY_IN_USE';
          throw err;
        }

        const legacyUserScan = await transaction.get(this.db!.collection('users').select('email'));
        for (const legacyUserDoc of legacyUserScan.docs) {
          const rawUserEmail = String(legacyUserDoc.data()?.email || '');
          if (rawUserEmail && AuthRepository.normalizeEmail(rawUserEmail) === normalized) {
            const err: any = new Error('An account with this email already exists.');
            err.code = 'EMAIL_ALREADY_IN_USE';
            throw err;
          }
        }

        const existingUserDoc = await transaction.get(userDocRef);
        if (existingUserDoc.exists) {
          const err: any = new Error('User profile already exists for this ID.');
          err.code = 'USER_ALREADY_EXISTS';
          throw err;
        }

        const existingWalletDoc = await transaction.get(walletDocRef);
        if (existingWalletDoc.exists) {
          const err: any = new Error('Wallet already exists for this ID.');
          err.code = 'WALLET_ALREADY_EXISTS';
          throw err;
        }

        // Test fault injection simulation
        if (this.testFaultInjection.failOnProfile) {
          throw new Error('[SimulatedFault] Profile creation failure in transaction');
        }
        if (this.testFaultInjection.failOnWallet) {
          throw new Error('[SimulatedFault] Wallet creation failure in transaction');
        }

        // 2. Transactional Writes together
        transaction.set(emailIndexRef, emailIndexToStore);
        transaction.set(credDocRef, credToStore);
        transaction.set(userDocRef, profile);
        transaction.set(walletDocRef, walletToStore);
      });

      this.memoryEmailIndex.set(emailKey, emailIndexToStore);
      this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
      this.memoryCredentialsByEmail.set(normalized, credToStore.userId);
      this.memoryUsers.set(profile.id, profile);
      this.memoryWallets.set(walletToStore.userId, walletToStore);

      return { user: profile, wallet: walletToStore };
    }

    // In-memory test/fallback implementation: strictly enforce identical atomic guarantees
    if (this.memoryCredentialsByUserId.has(credToStore.userId)) {
      const err: any = new Error('Credentials already exist for this user ID.');
      err.code = 'CREDENTIALS_ALREADY_LINKED';
      throw err;
    }
    if (this.memoryEmailIndex.has(emailKey)) {
      const err: any = new Error('An account with this email already exists.');
      err.code = 'EMAIL_ALREADY_IN_USE';
      throw err;
    }
    if (this.memoryCredentialsByEmail.has(normalized)) {
      const err: any = new Error('An account with this email already exists.');
      err.code = 'EMAIL_ALREADY_IN_USE';
      throw err;
    }
    for (const cred of this.memoryCredentialsByUserId.values()) {
      if (cred.email.trim().toLowerCase() === normalized) {
        const err: any = new Error('An account with this email already exists.');
        err.code = 'EMAIL_ALREADY_IN_USE';
        throw err;
      }
    }
    for (const u of this.memoryUsers.values()) {
      if ((u as any).email && String((u as any).email).trim().toLowerCase() === normalized) {
        const err: any = new Error('An account with this email already exists.');
        err.code = 'EMAIL_ALREADY_IN_USE';
        throw err;
      }
    }
    if (this.memoryUsers.has(profile.id)) {
      const err: any = new Error('User profile already exists for this ID.');
      err.code = 'USER_ALREADY_EXISTS';
      throw err;
    }
    if (this.memoryWallets.has(walletToStore.userId)) {
      const err: any = new Error('Wallet already exists for this ID.');
      err.code = 'WALLET_ALREADY_EXISTS';
      throw err;
    }

    // Test fault injection simulation
    if (this.testFaultInjection.failOnProfile) {
      throw new Error('[SimulatedFault] Profile creation failure in transaction');
    }
    if (this.testFaultInjection.failOnWallet) {
      throw new Error('[SimulatedFault] Wallet creation failure in transaction');
    }

    // All checks passed: atomically commit together
    this.memoryEmailIndex.set(emailKey, emailIndexToStore);
    this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
    this.memoryCredentialsByEmail.set(normalized, credToStore.userId);
    this.memoryUsers.set(profile.id, profile);
    this.memoryWallets.set(walletToStore.userId, walletToStore);

    return { user: profile, wallet: walletToStore };
  }


  public async updateCredential(
    userId: string,
    updates: Partial<Omit<AuthCredential, 'email'>> & { email?: never }
  ): Promise<void> {
    if ('email' in (updates as any) && (updates as any).email !== undefined) {
      const err: any = new Error(
        'Email updates via updateCredential() are rejected because atomic auth_email_index synchronization is not supported by this method.'
      );
      err.code = 'EMAIL_UPDATE_NOT_SUPPORTED';
      throw err;
    }

    const existing = await this.getCredentialByUserId(userId);
    if (!existing) return;

    const updated: AuthCredential = {
      ...existing,
      ...updates,
      email: existing.email, // Preserve existing email field without silent mutation
      updatedAt: new Date().toISOString(),
    };

    if (this.isExplicitDb && this.db) {
      await this.db.collection('auth_credentials').doc(userId).set(updated, { merge: true });
      return;
    }

    this.memoryCredentialsByUserId.set(userId, updated);

    if (this.db) {
      try {
        await this.db.collection('auth_credentials').doc(userId).set(updated, { merge: true });
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore credential update error:', err.message);
      }
    }
  }

  /**
   * Increments failed login count and triggers lockout if threshold reached
   */
  public async incrementFailedLoginAttempts(
    userId: string,
    maxAttempts = 5,
    lockDurationMs = 15 * 60 * 1000 // 15 minutes lockout
  ): Promise<{ locked: boolean; lockUntil: number | null }> {
    const cred = await this.getCredentialByUserId(userId);
    if (!cred) {
      return { locked: false, lockUntil: null };
    }

    const newAttempts = (cred.failedLoginAttempts || 0) + 1;
    let lockUntil: number | null = cred.lockUntil;

    if (newAttempts >= maxAttempts) {
      lockUntil = Date.now() + lockDurationMs;
    }

    await this.updateCredential(userId, {
      failedLoginAttempts: newAttempts,
      lockUntil,
    });

    return {
      locked: lockUntil !== null && lockUntil > Date.now(),
      lockUntil,
    };
  }

  /**
   * Resets failed login attempts after successful authentication
   */
  public async resetFailedLoginAttempts(userId: string): Promise<void> {
    await this.updateCredential(userId, {
      failedLoginAttempts: 0,
      lockUntil: null,
    });
  }

  // --- Session Operations ---

  public async createSession(session: AuthSession): Promise<void> {
    if (this.isExplicitDb && this.db) {
      await this.db.collection('auth_sessions').doc(session.sessionId).set(session);
      return;
    }

    this.memorySessions.set(session.sessionId, { ...session });

    if (this.db) {
      try {
        await this.db.collection('auth_sessions').doc(session.sessionId).set(session);
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore session create error:', err.message);
      }
    }
  }

  public async getSessionById(sessionId: string): Promise<AuthSession | null> {
    if (this.isExplicitDb && this.db) {
      const doc = await this.db.collection('auth_sessions').doc(sessionId).get();
      if (!doc.exists) return null;
      return doc.data() as AuthSession;
    }

    if (!this.db) {
      return this.memorySessions.get(sessionId) || null;
    }

    try {
      const doc = await this.db.collection('auth_sessions').doc(sessionId).get();
      if (!doc.exists) {
        return this.memorySessions.get(sessionId) || null;
      }
      return doc.data() as AuthSession;
    } catch (err) {
      return this.memorySessions.get(sessionId) || null;
    }
  }

  /**
   * Look up a session by either current refresh token hash OR consumed token history.
   * Distinguishes active generation from consumed generations with precise timestamps.
   */
  public async findSessionByTokenHash(hash: string): Promise<SessionLookupResult | null> {
    if (this.isExplicitDb && this.db) {
      // 1. Query Firestore by current refreshTokenHash
      const currentSnap = await this.db
        .collection('auth_sessions')
        .where('refreshTokenHash', '==', hash)
        .limit(1)
        .get();

      if (!currentSnap.empty) {
        const session = currentSnap.docs[0].data() as AuthSession;
        return { session, isCurrent: true, isConsumed: false };
      }

      // 2. Query Firestore by consumedHashesList array
      const consumedSnap = await this.db
        .collection('auth_sessions')
        .where('consumedHashesList', 'array-contains', hash)
        .limit(1)
        .get();

      if (!consumedSnap.empty) {
        const session = consumedSnap.docs[0].data() as AuthSession;
        const consumed = session.consumedTokenHashes?.find((c) => c.hash === hash) || {
          hash,
          consumedAt: new Date(session.lastRotatedAt).getTime() || Date.now(),
        };
        return { session, isCurrent: false, isConsumed: true, consumedRecord: consumed };
      }

      // 3. Legacy fallback: query by previousRefreshTokenHash
      const legacySnap = await this.db
        .collection('auth_sessions')
        .where('previousRefreshTokenHash', '==', hash)
        .limit(1)
        .get();

      if (!legacySnap.empty) {
        const session = legacySnap.docs[0].data() as AuthSession;
        return {
          session,
          isCurrent: false,
          isConsumed: true,
          consumedRecord: {
            hash,
            consumedAt: new Date(session.lastRotatedAt).getTime() || Date.now(),
          },
        };
      }

      return null;
    }

    // 1. Search in-memory state
    for (const session of this.memorySessions.values()) {
      if (session.refreshTokenHash === hash) {
        return { session, isCurrent: true, isConsumed: false };
      }
      const consumed = session.consumedTokenHashes?.find((c) => c.hash === hash);
      if (consumed) {
        return { session, isCurrent: false, isConsumed: true, consumedRecord: consumed };
      }
      if (session.previousRefreshTokenHash === hash) {
        return {
          session,
          isCurrent: false,
          isConsumed: true,
          consumedRecord: {
            hash,
            consumedAt: new Date(session.lastRotatedAt).getTime() || Date.now(),
          },
        };
      }
    }

    if (!this.db) return null;

    try {
      // 2. Query Firestore by current refreshTokenHash
      const currentSnap = await this.db
        .collection('auth_sessions')
        .where('refreshTokenHash', '==', hash)
        .limit(1)
        .get();

      if (!currentSnap.empty) {
        const session = currentSnap.docs[0].data() as AuthSession;
        return { session, isCurrent: true, isConsumed: false };
      }

      // 3. Query Firestore by consumedHashesList array
      const consumedSnap = await this.db
        .collection('auth_sessions')
        .where('consumedHashesList', 'array-contains', hash)
        .limit(1)
        .get();

      if (!consumedSnap.empty) {
        const session = consumedSnap.docs[0].data() as AuthSession;
        const consumed = session.consumedTokenHashes?.find((c) => c.hash === hash) || {
          hash,
          consumedAt: new Date(session.lastRotatedAt).getTime() || Date.now(),
        };
        return { session, isCurrent: false, isConsumed: true, consumedRecord: consumed };
      }

      // 4. Legacy fallback: query by previousRefreshTokenHash
      const legacySnap = await this.db
        .collection('auth_sessions')
        .where('previousRefreshTokenHash', '==', hash)
        .limit(1)
        .get();

      if (!legacySnap.empty) {
        const session = legacySnap.docs[0].data() as AuthSession;
        return {
          session,
          isCurrent: false,
          isConsumed: true,
          consumedRecord: {
            hash,
            consumedAt: new Date(session.lastRotatedAt).getTime() || Date.now(),
          },
        };
      }
    } catch (err: any) {
      console.warn('[AuthRepository] Firestore findSessionByTokenHash query error:', err.message);
    }

    return null;
  }

  /**
   * Atomically rotates a session token using a Firestore transaction (or in-memory atomic CAS).
   * Ensures two simultaneous requests cannot independently rotate the same token.
   * If a concurrent request already rotated the token, throws CONCURRENT_ROTATION_CONFLICT.
   */
  public async rotateSessionToken(
    sessionId: string,
    consumedTokenHash: string,
    newTokenHash: string,
    idempotencyKeyHash?: string | null
  ): Promise<AuthSession | null> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const consumedRecord: ConsumedTokenRecord = {
      hash: consumedTokenHash,
      consumedAt: now,
    };

    const recoveryRecord: RecoveryRecord | null = idempotencyKeyHash
      ? {
          consumedHash: consumedTokenHash,
          idempotencyKeyHash,
          consumedAt: now,
        }
      : null;

    if (this.isExplicitDb && this.db) {
      return await this.db.runTransaction(async (transaction) => {
        const sessionRef = this.db!.collection('auth_sessions').doc(sessionId);
        const doc = await transaction.get(sessionRef);
        if (!doc.exists) return null;
        const session = doc.data() as AuthSession;

        if (session.isRevoked) {
          const err: any = new Error('Session is revoked');
          err.code = 'SESSION_REVOKED';
          throw err;
        }

        // Concurrency check within transaction lock
        if (session.refreshTokenHash !== consumedTokenHash) {
          const err: any = new Error('Concurrent rotation detected; token was already rotated');
          err.code = 'CONCURRENT_ROTATION_CONFLICT';
          throw err;
        }

        const existingConsumed = session.consumedTokenHashes || [];
        const updatedConsumed = [...existingConsumed, consumedRecord].slice(-MAX_CONSUMED_TOKEN_HISTORY);
        const consumedHashesList = updatedConsumed.map((c) => c.hash);

        const updated: AuthSession = {
          ...session,
          refreshTokenHash: newTokenHash,
          previousRefreshTokenHash: consumedTokenHash,
          consumedTokenHashes: updatedConsumed,
          consumedHashesList,
          recoveryRecord,
          lastRotatedAt: nowIso,
        };

        transaction.set(sessionRef, updated, { merge: true });
        return updated;
      });
    }

    if (!this.db) {
      const existing = this.memorySessions.get(sessionId);
      if (!existing) return null;
      if (existing.isRevoked) {
        const err: any = new Error('Session is revoked');
        err.code = 'SESSION_REVOKED';
        throw err;
      }
      if (existing.refreshTokenHash !== consumedTokenHash) {
        const err: any = new Error('Concurrent rotation detected; token was already rotated');
        err.code = 'CONCURRENT_ROTATION_CONFLICT';
        throw err;
      }

      const existingConsumed = existing.consumedTokenHashes || [];
      const updatedConsumed = [...existingConsumed, consumedRecord].slice(-MAX_CONSUMED_TOKEN_HISTORY);
      const consumedHashesList = updatedConsumed.map((c) => c.hash);

      const updated: AuthSession = {
        ...existing,
        refreshTokenHash: newTokenHash,
        previousRefreshTokenHash: consumedTokenHash,
        consumedTokenHashes: updatedConsumed,
        consumedHashesList,
        recoveryRecord,
        lastRotatedAt: nowIso,
      };

      this.memorySessions.set(sessionId, updated);
      return updated;
    }

    return await this.db.runTransaction(async (transaction) => {
      const sessionRef = this.db!.collection('auth_sessions').doc(sessionId);
      const doc = await transaction.get(sessionRef);
      if (!doc.exists) return null;
      const session = doc.data() as AuthSession;

      if (session.isRevoked) {
        const err: any = new Error('Session is revoked');
        err.code = 'SESSION_REVOKED';
        throw err;
      }

      // Concurrency check within transaction lock
      if (session.refreshTokenHash !== consumedTokenHash) {
        const err: any = new Error('Concurrent rotation detected; token was already rotated');
        err.code = 'CONCURRENT_ROTATION_CONFLICT';
        throw err;
      }

      const existingConsumed = session.consumedTokenHashes || [];
      const updatedConsumed = [...existingConsumed, consumedRecord].slice(-MAX_CONSUMED_TOKEN_HISTORY);
      const consumedHashesList = updatedConsumed.map((c) => c.hash);

      const updated: AuthSession = {
        ...session,
        refreshTokenHash: newTokenHash,
        previousRefreshTokenHash: consumedTokenHash,
        consumedTokenHashes: updatedConsumed,
        consumedHashesList,
        recoveryRecord,
        lastRotatedAt: nowIso,
      };

      transaction.set(sessionRef, updated, { merge: true });
      this.memorySessions.set(sessionId, updated);
      return updated;
    });
  }

  /**
   * Safe Lost-Response Recovery:
   * When a client retries with a consumed token whose response was dropped in transit,
   * this method verifies that the request includes the matching idempotency key bound to the rotation.
   * If verified, it atomically invalidates the unacknowledged generation, rotates to a fresh token pair,
   * clears the recovery record, and returns the newly active session.
   * If the idempotency key is missing or mismatched, returns null (fails closed).
   */
  public async recoverLostSessionResponse(
    sessionId: string,
    consumedTokenHash: string,
    idempotencyKeyHash: string,
    newReplacementTokenHash: string
  ): Promise<AuthSession | null> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const doRecovery = (existing: AuthSession): AuthSession | null => {
      if (existing.isRevoked) return null;
      if (!existing.recoveryRecord) return null;
      if (existing.recoveryRecord.consumedHash !== consumedTokenHash) return null;
      if (existing.recoveryRecord.idempotencyKeyHash !== idempotencyKeyHash) return null;
      if (now - existing.recoveryRecord.consumedAt > REFRESH_GRACE_WINDOW_MS) return null;

      // Legitimate recovery match: re-rotate session to newReplacementTokenHash and clear recoveryRecord
      const consumedRecord: ConsumedTokenRecord = {
        hash: existing.refreshTokenHash, // Invalidate the unacknowledged token
        consumedAt: now,
      };
      const existingConsumed = existing.consumedTokenHashes || [];
      const updatedConsumed = [...existingConsumed, consumedRecord].slice(-MAX_CONSUMED_TOKEN_HISTORY);
      const consumedHashesList = updatedConsumed.map((c) => c.hash);

      return {
        ...existing,
        refreshTokenHash: newReplacementTokenHash,
        previousRefreshTokenHash: existing.refreshTokenHash,
        consumedTokenHashes: updatedConsumed,
        consumedHashesList,
        recoveryRecord: null, // Clear recovery record to prevent duplicate recovery
        lastRotatedAt: nowIso,
      };
    };

    if (this.isExplicitDb && this.db) {
      return await this.db.runTransaction(async (transaction) => {
        const sessionRef = this.db!.collection('auth_sessions').doc(sessionId);
        const doc = await transaction.get(sessionRef);
        if (!doc.exists) return null;
        const session = doc.data() as AuthSession;
        const updated = doRecovery(session);
        if (!updated) return null;
        transaction.set(sessionRef, updated, { merge: true });
        return updated;
      });
    }

    if (!this.db) {
      const existing = this.memorySessions.get(sessionId);
      if (!existing) return null;
      const updated = doRecovery(existing);
      if (!updated) return null;
      this.memorySessions.set(sessionId, updated);
      return updated;
    }

    return await this.db.runTransaction(async (transaction) => {
      const sessionRef = this.db!.collection('auth_sessions').doc(sessionId);
      const doc = await transaction.get(sessionRef);
      if (!doc.exists) return null;
      const session = doc.data() as AuthSession;
      const updated = doRecovery(session);
      if (!updated) return null;
      transaction.set(sessionRef, updated, { merge: true });
      this.memorySessions.set(sessionId, updated);
      return updated;
    });
  }

  /**
   * Look up an active session by current refresh token hash (backward compatible)
   */
  public async findSessionByRefreshTokenHash(hash: string): Promise<AuthSession | null> {
    const result = await this.findSessionByTokenHash(hash);
    if (result && result.isCurrent) {
      return result.session;
    }
    return null;
  }

  /**
   * Look up a session where this token hash was already consumed as previous token (backward compatible)
   */
  public async findSessionByPreviousTokenHash(hash: string): Promise<AuthSession | null> {
    const result = await this.findSessionByTokenHash(hash);
    if (result && result.isConsumed) {
      return result.session;
    }
    return null;
  }

  public async updateSession(sessionId: string, updates: Partial<AuthSession>): Promise<void> {
    const existing = await this.getSessionById(sessionId);
    if (!existing) return;

    const updated: AuthSession = {
      ...existing,
      ...updates,
    };

    if (this.isExplicitDb && this.db) {
      await this.db.collection('auth_sessions').doc(sessionId).set(updated, { merge: true });
      return;
    }

    this.memorySessions.set(sessionId, updated);

    if (this.db) {
      try {
        await this.db.collection('auth_sessions').doc(sessionId).set(updated, { merge: true });
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore session update error:', err.message);
      }
    }
  }

  /**
   * Revoke a single session
   */
  public async revokeSession(sessionId: string, reason: SessionRevocationReason = 'logout'): Promise<void> {
    await this.updateSession(sessionId, {
      isRevoked: true,
      revokedReason: reason,
    });
  }

  /**
   * Revoke an entire family of sessions upon replay attack detection
   */
  public async revokeFamily(familyId: string, reason: SessionRevocationReason = 'replay_attack_detected'): Promise<void> {
    if (this.isExplicitDb && this.db) {
      const snapshot = await this.db
        .collection('auth_sessions')
        .where('familyId', '==', familyId)
        .get();

      const batch = this.db.batch();
      snapshot.docs.forEach((doc) => {
        batch.update(doc.ref, {
          isRevoked: true,
          revokedReason: reason,
        });
      });
      await batch.commit();
      return;
    }

    // Revoke memory sessions matching family
    for (const [sId, session] of this.memorySessions.entries()) {
      if (session.familyId === familyId) {
        this.memorySessions.set(sId, {
          ...session,
          isRevoked: true,
          revokedReason: reason,
        });
      }
    }

    if (!this.db) return;

    try {
      const snapshot = await this.db
        .collection('auth_sessions')
        .where('familyId', '==', familyId)
        .get();

      const batch = this.db.batch();
      snapshot.docs.forEach((doc) => {
        batch.update(doc.ref, {
          isRevoked: true,
          revokedReason: reason,
        });
      });
      await batch.commit();
    } catch (err: any) {
      console.warn('[AuthRepository] Firestore family revocation batch error:', err.message);
    }
  }

  // --- User Profile & Account Integration ---

  /**
   * Checks if an existing player profile exists by email or UID.
   * Guarantees that existing Firebase UIDs are preserved and never duplicated.
   */
  public async findExistingUserByEmail(email: string): Promise<UserProfile | null> {
    const normalized = AuthRepository.normalizeEmail(email);

    const findInMemory = (): UserProfile | null => {
      for (const u of this.memoryUsers.values()) {
        const rawEmail = (u as any).email;
        if (rawEmail && AuthRepository.normalizeEmail(String(rawEmail)) === normalized) {
          return u;
        }
      }
      return null;
    };

    const findInFirestore = async (): Promise<UserProfile | null> => {
      if (!this.db) return null;

      const snapshot = await this.db
        .collection('users')
        .where('email', '==', normalized)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        return snapshot.docs[0].data() as UserProfile;
      }

      // Read-only legacy fallback for unnormalized emails in users collection
      const userEmailScan = await this.db.collection('users').select('email').get();
      for (const docSnap of userEmailScan.docs) {
        const rawEmail = docSnap.data()?.email;
        if (rawEmail && AuthRepository.normalizeEmail(String(rawEmail)) === normalized) {
          const fullDoc = await docSnap.ref.get();
          if (fullDoc.exists) {
            return fullDoc.data() as UserProfile;
          }
        }
      }

      return null;
    };

    if (this.isExplicitDb && this.db) {
      return await findInFirestore();
    }

    const memMatch = findInMemory();
    if (memMatch) return memMatch;

    if (!this.db) return null;

    try {
      return await findInFirestore();
    } catch {
      // Ignore query error
    }

    return null;
  }

  public async getUserProfile(userId: string): Promise<UserProfile | null> {
    if (this.isExplicitDb && this.db) {
      const doc = await this.db.collection('users').doc(userId).get();
      if (doc.exists) {
        return doc.data() as UserProfile;
      }
      return null;
    }

    if (this.memoryUsers.has(userId)) {
      return this.memoryUsers.get(userId)!;
    }

    if (!this.db) return null;

    try {
      const doc = await this.db.collection('users').doc(userId).get();
      if (doc.exists) {
        return doc.data() as UserProfile;
      }
    } catch (err) {
      // Ignore error
    }

    return null;
  }

  /**
   * Creates a user profile if one does not already exist
   */
  public async ensureUserProfile(profile: UserProfile & { email?: string }): Promise<UserProfile> {
    if (this.isExplicitDb && this.db) {
      const userRef = this.db.collection('users').doc(profile.id);
      const existing = await userRef.get();
      if (!existing.exists) {
        await userRef.set(profile);
      }
      await this.ensureUserWallet(profile.id);
      return profile;
    }

    this.memoryUsers.set(profile.id, profile);

    if (this.db) {
      try {
        const userRef = this.db.collection('users').doc(profile.id);
        const existing = await userRef.get();
        if (!existing.exists) {
          await userRef.set(profile);
        }
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore user profile creation error:', err.message);
      }
    }

    // Ensure wallet exists
    await this.ensureUserWallet(profile.id);

    return profile;
  }

  public async ensureUserWallet(userId: string): Promise<Wallet> {
    const defaultWallet: Wallet = {
      id: userId,
      userId,
      balance: 0,
      currency: 'NGN',
      updatedAt: new Date().toISOString(),
    };

    if (this.isExplicitDb && this.db) {
      const walletRef = this.db.collection('wallets').doc(userId);
      const existing = await walletRef.get();
      if (!existing.exists) {
        await walletRef.set(defaultWallet);
        return defaultWallet;
      }
      return existing.data() as Wallet;
    }

    if (this.memoryWallets.has(userId)) {
      return this.memoryWallets.get(userId)!;
    }

    this.memoryWallets.set(userId, defaultWallet);

    if (this.db) {
      try {
        const walletRef = this.db.collection('wallets').doc(userId);
        const existing = await walletRef.get();
        if (!existing.exists) {
          await walletRef.set(defaultWallet);
        } else {
          return existing.data() as Wallet;
        }
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore wallet creation error:', err.message);
      }
    }

    return defaultWallet;
  }

  /**
   * Read-Only Legacy Migration Inspection Report (Zero Writes / Zero Mutations).
   *
   * Groups credentials, profiles, and email indexes by deterministic emailKey = SHA-256(normalizedEmail).
   * Never logs raw email addresses or secrets, and never modifies existing accounts, wallets,
   * balances, or transactions.
   */
  public async generateLegacyMigrationReport(options?: {
    resolveFirebaseVerification?: (uid: string) => Promise<boolean | 'unavailable'>;
    resolveTransactionSummary?: (uid: string) => Promise<{ count: number; hasHistory: boolean }>;
  }): Promise<{
    generatedAt: string;
    totalGroups: number;
    manualReviewCount: number;
    groups: Array<{
      emailKey: string;
      existingIndexOwnerUid: string | null;
      conflictingUids: string[];
      requiresManualReview: boolean;
      reviewReasons: string[];
      accounts: Array<{
        uid: string;
        hasCredential: boolean;
        hasProfile: boolean;
        hasUnnormalizedEmail: boolean;
        firebaseEmailVerified: boolean | 'unavailable';
        walletBalance: number | null;
        transactionCount: number;
        hasTransactionHistory: boolean;
      }>;
    }>;
  }> {
    type RawAcc = {
      uid: string;
      emailKey: string;
      hasCredential: boolean;
      hasProfile: boolean;
      hasUnnormalizedEmail: boolean;
    };

    const grouped = new Map<string, Map<string, RawAcc>>();
    const indexOwnerByKey = new Map<string, string>();
    const walletBalanceByUid = new Map<string, number | null>();
    const txCountByUid = new Map<string, number>();

    const upsertAcc = (emailRaw: string, uid: string, patch: Partial<RawAcc>) => {
      const normalized = AuthRepository.normalizeEmail(emailRaw);
      if (!normalized) return;
      const emailKey = AuthRepository.computeEmailKey(normalized);
      if (!grouped.has(emailKey)) grouped.set(emailKey, new Map());
      const byUid = grouped.get(emailKey)!;
      const existing = byUid.get(uid) || {
        uid,
        emailKey,
        hasCredential: false,
        hasProfile: false,
        hasUnnormalizedEmail: false,
      };
      byUid.set(uid, {
        ...existing,
        ...patch,
        hasUnnormalizedEmail: existing.hasUnnormalizedEmail || emailRaw !== normalized,
      });
    };

    if (this.db) {
      const [credSnap, idxSnap, userSnap, walletSnap, txSnap] = await Promise.all([
        this.db.collection('auth_credentials').select('userId', 'email').get(),
        this.db.collection('auth_email_index').select('emailKey', 'userId').get(),
        this.db.collection('users').select('id', 'email').get(),
        this.db.collection('wallets').select('userId', 'balance').get(),
        this.db.collection('transactions').select('userId').get(),
      ]);

      for (const doc of idxSnap.docs) {
        const d = doc.data() as Partial<EmailIndexRecord>;
        if (d.userId) indexOwnerByKey.set(doc.id, d.userId);
      }
      for (const doc of walletSnap.docs) {
        const d = doc.data() as Partial<Wallet>;
        walletBalanceByUid.set(d.userId || doc.id, typeof d.balance === 'number' ? d.balance : null);
      }
      for (const doc of txSnap.docs) {
        const uid = String(doc.data()?.userId || '');
        if (uid) txCountByUid.set(uid, (txCountByUid.get(uid) || 0) + 1);
      }
      for (const doc of credSnap.docs) {
        const d = doc.data() as Partial<AuthCredential>;
        if (d.email) upsertAcc(String(d.email), d.userId || doc.id, { hasCredential: true });
      }
      for (const doc of userSnap.docs) {
        const d = doc.data() as any;
        if (d.email) upsertAcc(String(d.email), d.id || doc.id, { hasProfile: true });
      }
    } else {
      for (const idx of this.memoryEmailIndex.values()) {
        indexOwnerByKey.set(idx.emailKey, idx.userId);
      }
      for (const [uid, wallet] of this.memoryWallets.entries()) {
        walletBalanceByUid.set(uid, wallet.balance);
      }
      for (const cred of this.memoryCredentialsByUserId.values()) {
        upsertAcc(cred.email, cred.userId, { hasCredential: true });
      }
      for (const user of this.memoryUsers.values()) {
        const rawEmail = (user as any).email;
        if (rawEmail) upsertAcc(String(rawEmail), user.id, { hasProfile: true });
      }
    }

    const groups: Array<{
      emailKey: string;
      existingIndexOwnerUid: string | null;
      conflictingUids: string[];
      requiresManualReview: boolean;
      reviewReasons: string[];
      accounts: Array<{
        uid: string;
        hasCredential: boolean;
        hasProfile: boolean;
        hasUnnormalizedEmail: boolean;
        firebaseEmailVerified: boolean | 'unavailable';
        walletBalance: number | null;
        transactionCount: number;
        hasTransactionHistory: boolean;
      }>;
    }> = [];

    for (const [emailKey, byUid] of grouped.entries()) {
      const uids = Array.from(byUid.keys());
      const existingIndexOwnerUid = indexOwnerByKey.get(emailKey) || null;
      const reviewReasons: string[] = [];

      if (uids.length > 1) reviewReasons.push('MULTIPLE_UIDS_FOR_EMAIL');
      if (existingIndexOwnerUid && !byUid.has(existingIndexOwnerUid)) {
        reviewReasons.push('INDEX_POINTS_TO_MISSING_ACCOUNT');
      }
      if (existingIndexOwnerUid && uids.some((uid) => uid !== existingIndexOwnerUid)) {
        reviewReasons.push('INDEX_OWNER_MISMATCH');
      }
      if (!existingIndexOwnerUid && Array.from(byUid.values()).some((a) => a.hasCredential)) {
        reviewReasons.push('MISSING_EMAIL_INDEX');
      }
      if (Array.from(byUid.values()).some((a) => a.hasUnnormalizedEmail)) {
        reviewReasons.push('UNNORMALIZED_LEGACY_EMAIL');
      }

      const accounts = await Promise.all(
        Array.from(byUid.values()).map(async (acc) => {
          const firebaseEmailVerified = options?.resolveFirebaseVerification
            ? await options.resolveFirebaseVerification(acc.uid)
            : 'unavailable';
          const txSummary = options?.resolveTransactionSummary
            ? await options.resolveTransactionSummary(acc.uid)
            : {
                count: txCountByUid.get(acc.uid) || 0,
                hasHistory: (txCountByUid.get(acc.uid) || 0) > 0,
              };
          return {
            uid: acc.uid,
            hasCredential: acc.hasCredential,
            hasProfile: acc.hasProfile,
            hasUnnormalizedEmail: acc.hasUnnormalizedEmail,
            firebaseEmailVerified,
            walletBalance: walletBalanceByUid.has(acc.uid) ? walletBalanceByUid.get(acc.uid)! : null,
            transactionCount: txSummary.count,
            hasTransactionHistory: txSummary.hasHistory,
          };
        })
      );

      groups.push({
        emailKey,
        existingIndexOwnerUid,
        conflictingUids: uids.length > 1 ? uids : [],
        requiresManualReview: reviewReasons.length > 0,
        reviewReasons,
        accounts,
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      totalGroups: groups.length,
      manualReviewCount: groups.filter((g) => g.requiresManualReview).length,
      groups,
    };
  }
}

export const authRepo = new AuthRepository();
