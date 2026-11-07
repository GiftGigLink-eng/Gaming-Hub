import { Firestore } from 'firebase-admin/firestore';
import { adminApp } from '../firebaseAdmin.js';
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
  private db: Firestore | null = null;
  private isExplicitDb = false;
  // In-memory fallback stores for tests or environments without Firestore connection
  private memoryCredentialsByUserId = new Map<string, AuthCredential>();
  private memoryCredentialsByEmail = new Map<string, string>(); // email -> userId
  private memorySessions = new Map<string, AuthSession>(); // sessionId -> session
  private memoryUsers = new Map<string, UserProfile>();
  private memoryWallets = new Map<string, Wallet>();

  constructor(customDb?: Firestore | null) {
    if (customDb !== undefined) {
      this.db = customDb;
      this.isExplicitDb = customDb !== null;
    } else {
      try {
        const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
        this.db = getFirestore(adminApp, databaseId);
        this.isExplicitDb = false;
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore Admin SDK unavailable, using resilient in-memory storage fallback:', err.message);
        this.db = null;
        this.isExplicitDb = false;
      }
    }
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
    this.db = customDb;
    this.isExplicitDb = customDb !== null;
  }

  /**
   * Reset in-memory state (useful for isolated unit tests)
   */
  public resetInMemory(): void {
    this.memoryCredentialsByUserId.clear();
    this.memoryCredentialsByEmail.clear();
    this.memorySessions.clear();
    this.memoryUsers.clear();
    this.memoryWallets.clear();
  }

  // --- Credential Operations ---

  public async getCredentialByEmail(email: string): Promise<AuthCredential | null> {
    const normalized = email.trim().toLowerCase();

    if (this.isExplicitDb && this.db) {
      const snapshot = await this.db
        .collection('auth_credentials')
        .where('email', '==', normalized)
        .limit(1)
        .get();

      if (snapshot.empty) return null;
      return snapshot.docs[0].data() as AuthCredential;
    }

    if (!this.db) {
      const userId = this.memoryCredentialsByEmail.get(normalized);
      if (!userId) return null;
      return this.memoryCredentialsByUserId.get(userId) || null;
    }

    try {
      const snapshot = await this.db
        .collection('auth_credentials')
        .where('email', '==', normalized)
        .limit(1)
        .get();

      if (snapshot.empty) {
        const userId = this.memoryCredentialsByEmail.get(normalized);
        if (userId) return this.memoryCredentialsByUserId.get(userId) || null;
        return null;
      }

      return snapshot.docs[0].data() as AuthCredential;
    } catch (err) {
      const userId = this.memoryCredentialsByEmail.get(normalized);
      if (userId) return this.memoryCredentialsByUserId.get(userId) || null;
      return null;
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

  public async createCredential(credential: AuthCredential): Promise<void> {
    const normalized = credential.email.trim().toLowerCase();
    const credToStore: AuthCredential = {
      ...credential,
      email: normalized,
    };

    if (this.isExplicitDb && this.db) {
      await this.db.collection('auth_credentials').doc(credToStore.userId).set(credToStore);
      return;
    }

    // Always mirror to memory for resilient lookup
    this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
    this.memoryCredentialsByEmail.set(normalized, credToStore.userId);

    if (this.db) {
      try {
        await this.db.collection('auth_credentials').doc(credToStore.userId).set(credToStore);
      } catch (err: any) {
        console.warn('[AuthRepository] Firestore credential set error, preserved in memory:', err.message);
      }
    }
  }

  /**
   * Atomically creates a credential ensuring uniqueness via a Firestore transaction.
   * Guarantees concurrent linking requests cannot overwrite an existing credential.
   */
  public async createCredentialAtomic(credential: AuthCredential): Promise<void> {
    const normalized = credential.email.trim().toLowerCase();
    const credToStore: AuthCredential = {
      ...credential,
      email: normalized,
    };

    if (this.isExplicitDb && this.db) {
      const docRef = this.db.collection('auth_credentials').doc(credToStore.userId);
      await this.db.runTransaction(async (transaction) => {
        const existingDoc = await transaction.get(docRef);
        if (existingDoc.exists) {
          const err: any = new Error('Credentials are already linked to this account.');
          err.code = 'CREDENTIALS_ALREADY_LINKED';
          throw err;
        }

        // Also check duplicate email in Firestore within transaction
        const emailQuery = this.db!.collection('auth_credentials').where('email', '==', normalized).limit(1);
        const emailSnap = await transaction.get(emailQuery);
        if (!emailSnap.empty) {
          const err: any = new Error('Credentials for this email address already exist.');
          err.code = 'EMAIL_ALREADY_LINKED';
          throw err;
        }

        transaction.set(docRef, credToStore);
      });
      return;
    }

    if (!this.db) {
      if (this.memoryCredentialsByUserId.has(credToStore.userId)) {
        const err: any = new Error('Credentials are already linked to this account.');
        err.code = 'CREDENTIALS_ALREADY_LINKED';
        throw err;
      }
      if (this.memoryCredentialsByEmail.has(normalized)) {
        const err: any = new Error('Credentials for this email address already exist.');
        err.code = 'EMAIL_ALREADY_LINKED';
        throw err;
      }
      this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
      this.memoryCredentialsByEmail.set(normalized, credToStore.userId);
      return;
    }

    const docRef = this.db.collection('auth_credentials').doc(credToStore.userId);

    await this.db.runTransaction(async (transaction) => {
      const existingDoc = await transaction.get(docRef);
      if (existingDoc.exists) {
        const err: any = new Error('Credentials are already linked to this account.');
        err.code = 'CREDENTIALS_ALREADY_LINKED';
        throw err;
      }

      transaction.set(docRef, credToStore);
    });

    this.memoryCredentialsByUserId.set(credToStore.userId, credToStore);
    this.memoryCredentialsByEmail.set(normalized, credToStore.userId);
  }


  public async updateCredential(userId: string, updates: Partial<AuthCredential>): Promise<void> {
    const existing = await this.getCredentialByUserId(userId);
    if (!existing) return;

    const updated: AuthCredential = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    if (this.isExplicitDb && this.db) {
      await this.db.collection('auth_credentials').doc(userId).set(updated, { merge: true });
      return;
    }

    this.memoryCredentialsByUserId.set(userId, updated);
    this.memoryCredentialsByEmail.set(updated.email, userId);

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
    const normalized = email.trim().toLowerCase();

    if (this.isExplicitDb && this.db) {
      const snapshot = await this.db
        .collection('users')
        .where('email', '==', normalized)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        return snapshot.docs[0].data() as UserProfile;
      }
      return null;
    }

    // Check memory users
    for (const u of this.memoryUsers.values()) {
      if ((u as any).email && (u as any).email.toLowerCase() === normalized) {
        return u;
      }
    }

    if (!this.db) return null;

    try {
      const snapshot = await this.db
        .collection('users')
        .where('email', '==', normalized)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        return snapshot.docs[0].data() as UserProfile;
      }
    } catch (err) {
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
}

export const authRepo = new AuthRepository();
