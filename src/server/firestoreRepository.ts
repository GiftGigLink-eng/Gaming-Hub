if (process.env.NODE_ENV === 'test' && !process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
}

import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { adminApp } from './firebaseAdmin.js';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  GamingSession,
  MatchOpportunity,
  OpportunityStatus,
  Transaction,
  UserProfile,
  Wallet,
  MatchRoom,
  ChatMessage,
  RoomParticipant,
  RoomStatus,
  RoomStreamState,
  RoomViewer,
} from '../types.js';
import crypto from 'crypto';
import http from 'http';
import { spawn } from 'child_process';

export async function ensureFirestoreService(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    return;
  }

  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const [hostname, portStr] = host.split(':');
  const port = parseInt(portStr || '8085', 10);

  const isAlive = await new Promise<boolean>((resolve) => {
    const req = http.get(`http://${hostname}:${port}/`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });

  if (!isAlive) {
    const jarPath = '/root/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar';
    console.log(`[Firestore] Spawning Cloud Firestore service on ${host}...`);
    try {
      const proc = spawn('java', [
        '-jar',
        jarPath,
        '--host',
        hostname,
        '--port',
        port.toString(),
        '--rules',
        'firestore.rules',
      ], {
        detached: true,
        stdio: 'ignore',
      });
      proc.on('error', (err) => {
        console.warn('[Firestore] Emulator process error:', err.message);
      });
      proc.unref();

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const healthy = await new Promise<boolean>((resolve) => {
          const req = http.get(`http://${hostname}:${port}/`, (res) => resolve(res.statusCode === 200));
          req.on('error', () => resolve(false));
        });
        if (healthy) {
          console.log(`[Firestore] Cloud Firestore service ready on ${host}`);
          return;
        }
      }
    } catch (err: any) {
      console.warn('[Firestore] Could not auto-spawn emulator:', err.message);
    }
  }
}

export class InsufficientBalanceError extends Error {
  constructor(message = 'Insufficient wallet balance. Please fund your wallet with at least ₦100.') {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

export class DuplicateReferenceError extends Error {
  constructor(message = 'Payment reference has already been processed and credited.') {
    super(message);
    this.name = 'DuplicateReferenceError';
  }
}

export class ActiveSessionExistsError extends Error {
  public session: GamingSession;
  constructor(session: GamingSession, message = 'An active gaming session is already in progress.') {
    super(message);
    this.name = 'ActiveSessionExistsError';
    this.session = session;
  }
}

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

export class NoOpportunityAvailableError extends Error {
  constructor(message = 'No available match opportunity for this game. Purchase a match opportunity for ₦100 to play.') {
    super(message);
    this.name = 'NoOpportunityAvailableError';
  }
}

export class RoomNotFoundError extends Error {
  constructor(message = 'Match room not found.') {
    super(message);
    this.name = 'RoomNotFoundError';
  }
}

export class RoomEndedError extends Error {
  constructor(message = 'This match room has already ended.') {
    super(message);
    this.name = 'RoomEndedError';
  }
}

export class UnauthorizedHostActionError extends Error {
  constructor(message = 'Only the room host can perform this action.') {
    super(message);
    this.name = 'UnauthorizedHostActionError';
  }
}

export class ChatUnauthorizedError extends Error {
  constructor(message = 'Must be an active room participant to send chat messages.') {
    super(message);
    this.name = 'ChatUnauthorizedError';
  }
}

export class ChatRateLimitError extends Error {
  constructor(message = 'You are sending messages too quickly. Please wait a second before sending another.') {
    super(message);
    this.name = 'ChatRateLimitError';
  }
}

export class RoomValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomValidationError';
  }
}

export class FirestoreRepository {
  private db: Firestore;
  private userLastMessageMap = new Map<string, number>();

  constructor() {
    const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
    this.db = getFirestore(adminApp, databaseId);
  }

  public getFirestoreInstance(): Firestore {
    return this.db;
  }

  // User management (Persistent in Firestore /users collection)
  public async getUser(userId: string): Promise<UserProfile | null> {
    if (!userId) return null;
    const docRef = this.db.collection('users').doc(userId);
    const snap = await docRef.get();
    if (!snap.exists) return null;
    return snap.data() as UserProfile;
  }

  public async upsertUser(user: UserProfile): Promise<UserProfile> {
    const docRef = this.db.collection('users').doc(user.id);
    await docRef.set(user, { merge: true });
    // Ensure wallet document exists with 0 starting balance (no fake balance)
    const walletRef = this.db.collection('wallets').doc(user.id);
    const walletSnap = await walletRef.get();
    if (!walletSnap.exists) {
      await walletRef.set({
        id: user.id,
        userId: user.id,
        balance: 0,
        currency: 'NGN',
        updatedAt: new Date().toISOString(),
      });
    }
    return user;
  }

  // Wallet management (Persistent in Firestore /wallets collection)
  public async getWallet(userId: string): Promise<Wallet> {
    if (!userId) {
      throw new Error('userId is required to get wallet');
    }
    const docRef = this.db.collection('wallets').doc(userId);
    const snap = await docRef.get();
    if (snap.exists) {
      const data = snap.data()!;
      return {
        id: data.id || userId,
        userId: data.userId || userId,
        balance: Number(data.balance || 0),
        currency: 'NGN',
        updatedAt: data.updatedAt || new Date().toISOString(),
      };
    }

    // Initialize with 0 balance (no fake / unearned credit)
    const newWallet: Wallet = {
      id: userId,
      userId,
      balance: 0,
      currency: 'NGN',
      updatedAt: new Date().toISOString(),
    };
    await docRef.set(newWallet);
    return newWallet;
  }

  // Idempotent Payment Crediting via Firestore Transaction
  public async creditWallet(
    userId: string,
    amount: number,
    reference: string,
    channel: 'paystack' | 'admin' = 'paystack',
    description?: string
  ): Promise<{ wallet: Wallet; transaction: Transaction }> {
    if (!reference) throw new Error('Payment reference is required');
    if (amount <= 0) throw new Error('Credit amount must be positive');
    if (!userId) throw new Error('User ID is required');

    const refDocRef = this.db.collection('processed_references').doc(reference);
    const walletDocRef = this.db.collection('wallets').doc(userId);
    const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const txDocRef = this.db.collection('transactions').doc(txId);

    return await this.db.runTransaction(async (t) => {
      // 1. Idempotency Check: Verify if reference was already processed
      const refSnap = await t.get(refDocRef);
      if (refSnap.exists) {
        throw new DuplicateReferenceError(
          `Reference '${reference}' has already been verified and credited.`
        );
      }

      // 2. Read Wallet Doc
      const walletSnap = await t.get(walletDocRef);
      let currentBalance = 0;
      if (walletSnap.exists) {
        currentBalance = Number(walletSnap.data()?.balance || 0);
      }

      const newBalance = currentBalance + amount;
      const nowISO = new Date().toISOString();

      const updatedWallet: Wallet = {
        id: userId,
        userId,
        balance: newBalance,
        currency: 'NGN',
        updatedAt: nowISO,
      };

      const ledgerEntry: Transaction = {
        id: txId,
        userId,
        reference,
        amount,
        type: 'credit',
        channel,
        status: 'success',
        description: description || `Wallet top-up (Ref: ${reference})`,
        createdAt: nowISO,
      };

      // 3. Atomic writes: Mark reference processed, update wallet, record ledger entry
      t.set(refDocRef, {
        reference,
        userId,
        amount,
        channel,
        status: 'success',
        processedAt: nowISO,
      });

      t.set(walletDocRef, updatedWallet);
      t.set(txDocRef, ledgerEntry);

      return {
        wallet: updatedWallet,
        transaction: ledgerEntry,
      };
    });
  }

  // Atomic Wallet Deduction
  public async deductWallet(
    userId: string,
    amount: number,
    reference: string,
    channel: 'session' | 'admin' = 'session',
    description = '1-Hour Gaming Session'
  ): Promise<{ wallet: Wallet; transaction: Transaction }> {
    if (amount <= 0) throw new Error('Deduction amount must be positive');
    if (!userId) throw new Error('User ID is required');

    const walletDocRef = this.db.collection('wallets').doc(userId);
    const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const txDocRef = this.db.collection('transactions').doc(txId);

    return await this.db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletDocRef);
      if (!walletSnap.exists) {
        throw new InsufficientBalanceError(
          `Insufficient balance (₦0). Required: ₦${amount}.`
        );
      }

      const currentBalance = Number(walletSnap.data()?.balance || 0);
      if (currentBalance < amount) {
        throw new InsufficientBalanceError(
          `Insufficient balance (₦${currentBalance}). Required: ₦${amount}.`
        );
      }

      const newBalance = currentBalance - amount;
      const nowISO = new Date().toISOString();

      const updatedWallet: Wallet = {
        id: userId,
        userId,
        balance: newBalance,
        currency: 'NGN',
        updatedAt: nowISO,
      };

      const ledgerEntry: Transaction = {
        id: txId,
        userId,
        reference,
        amount,
        type: 'debit',
        channel,
        status: 'success',
        description,
        createdAt: nowISO,
      };

      t.set(walletDocRef, updatedWallet);
      t.set(txDocRef, ledgerEntry);

      return {
        wallet: updatedWallet,
        transaction: ledgerEntry,
      };
    });
  }

  // Session: Start ₦100 1-Hour Session with atomic deduction and session registration
  public async startSession(
    userId: string,
    gameTitle = 'Free Fire',
    cost = 100,
    durationMinutes = 60
  ): Promise<{ session: GamingSession; wallet: Wallet }> {
    if (!userId) throw new Error('User ID is required to start a session');

    const activeSessionRef = this.db.collection('active_sessions').doc(userId);
    const walletDocRef = this.db.collection('wallets').doc(userId);
    const sessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const sessionDocRef = this.db.collection('sessions').doc(sessionId);
    const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const txDocRef = this.db.collection('transactions').doc(txId);
    const sessionRef = `SESS_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    return await this.db.runTransaction(async (t) => {
      // 1. Check existing active session
      const activeSnap = await t.get(activeSessionRef);
      const now = Date.now();
      if (activeSnap.exists) {
        const activeData = activeSnap.data() as GamingSession;
        const endTime = new Date(activeData.endTime).getTime();
        if (now < endTime && activeData.status === 'active') {
          const remainingSec = Math.max(0, Math.floor((endTime - now) / 1000));
          throw new ActiveSessionExistsError(
            { ...activeData, remainingSeconds: remainingSec },
            `An active ${activeData.gameTitle} session is already ongoing with ${Math.ceil(
              remainingSec / 60
            )} minutes remaining.`
          );
        }
      }

      // 2. Read Wallet balance
      const walletSnap = await t.get(walletDocRef);
      const currentBalance = walletSnap.exists ? Number(walletSnap.data()?.balance || 0) : 0;
      if (currentBalance < cost) {
        throw new InsufficientBalanceError(
          `Insufficient balance (₦${currentBalance}). Required: ₦${cost}.`
        );
      }

      const newBalance = currentBalance - cost;
      const nowISO = new Date(now).toISOString();
      const endTimeISO = new Date(now + durationMinutes * 60 * 1000).toISOString();

      const updatedWallet: Wallet = {
        id: userId,
        userId,
        balance: newBalance,
        currency: 'NGN',
        updatedAt: nowISO,
      };

      const ledgerEntry: Transaction = {
        id: txId,
        userId,
        reference: sessionRef,
        amount: cost,
        type: 'debit',
        channel: 'session',
        status: 'success',
        description: `1-Hour Gaming Session: ${gameTitle}`,
        createdAt: nowISO,
      };

      const newSession: GamingSession = {
        id: sessionId,
        userId,
        gameTitle,
        cost,
        durationMinutes,
        startTime: nowISO,
        endTime: endTimeISO,
        status: 'active',
        createdAt: nowISO,
        remainingSeconds: durationMinutes * 60,
      };

      // 3. Atomically commit deduction, transaction ledger, and session docs
      t.set(walletDocRef, updatedWallet);
      t.set(txDocRef, ledgerEntry);
      t.set(sessionDocRef, newSession);
      t.set(activeSessionRef, newSession);

      return {
        session: newSession,
        wallet: updatedWallet,
      };
    });
  }

  // Get active session with server-calculated expiration
  public async getActiveSession(userId: string): Promise<GamingSession | null> {
    if (!userId) return null;
    const activeRef = this.db.collection('active_sessions').doc(userId);
    const snap = await activeRef.get();
    if (!snap.exists) return null;

    const data = snap.data() as GamingSession;
    if (data.status !== 'active') return null;

    const now = Date.now();
    const endTime = new Date(data.endTime).getTime();

    if (now >= endTime) {
      // Server-authoritative expiration transition
      await this.db.runTransaction(async (t) => {
        t.update(activeRef, { status: 'expired', remainingSeconds: 0 });
        const sessionRef = this.db.collection('sessions').doc(data.id);
        t.update(sessionRef, { status: 'expired', remainingSeconds: 0 });
      });
      return null;
    }

    const remainingSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
    return {
      ...data,
      remainingSeconds,
    };
  }

  // End active session early
  public async endSession(userId: string, sessionId: string): Promise<GamingSession | null> {
    if (!userId || !sessionId) return null;
    const sessionRef = this.db.collection('sessions').doc(sessionId);
    const activeRef = this.db.collection('active_sessions').doc(userId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(sessionRef);
      if (!snap.exists) return null;

      const data = snap.data() as GamingSession;
      if (data.userId !== userId) {
        return null;
      }

      const terminated: GamingSession = {
        ...data,
        status: 'terminated',
        remainingSeconds: 0,
      };

      t.update(sessionRef, { status: 'terminated', remainingSeconds: 0 });
      t.delete(activeRef);

      return terminated;
    });
  }

  // List transactions ledger
  public async getTransactions(userId: string): Promise<Transaction[]> {
    if (!userId) return [];
    const snap = await this.db
      .collection('transactions')
      .where('userId', '==', userId)
      .get();

    const list: Transaction[] = [];
    snap.forEach((doc) => {
      list.push(doc.data() as Transaction);
    });

    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // List past sessions
  public async getSessions(userId: string): Promise<GamingSession[]> {
    if (!userId) return [];
    const snap = await this.db
      .collection('sessions')
      .where('userId', '==', userId)
      .get();

    const list: GamingSession[] = [];
    snap.forEach((doc) => {
      list.push(doc.data() as GamingSession);
    });

    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Check if reference is processed
  public async isReferenceProcessed(reference: string): Promise<boolean> {
    if (!reference) return false;
    const snap = await this.db.collection('processed_references').doc(reference).get();
    return snap.exists;
  }

  // Stage 3: Match Opportunities Engine (₦100/Match)
  public async purchaseOpportunity(
    userId: string,
    gameId: string,
    idempotencyKey?: string,
    gameTitle?: string
  ): Promise<{ opportunity: MatchOpportunity; wallet: Wallet; transaction: Transaction; alreadyProcessed: boolean }> {
    if (!userId) throw new Error('User ID is required to purchase an opportunity');
    if (!gameId) throw new Error('Game ID is required to purchase an opportunity');

    const cost = 100; // Business rule: exactly ₦100 per match opportunity
    const key = idempotencyKey || `purch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const idempDocRef = this.db.collection('processed_purchases').doc(key);
    const walletDocRef = this.db.collection('wallets').doc(userId);

    return await this.db.runTransaction(async (t) => {
      // 1. Idempotency Check: repeated requests / retries with same idempotency key
      const idempSnap = await t.get(idempDocRef);
      if (idempSnap.exists) {
        const idempData = idempSnap.data()!;
        const oppSnap = await t.get(this.db.collection('match_opportunities').doc(idempData.opportunityId));
        const walletSnap = await t.get(walletDocRef);
        const txSnap = await t.get(this.db.collection('transactions').doc(idempData.transactionId));

        if (oppSnap.exists && walletSnap.exists && txSnap.exists) {
          return {
            opportunity: oppSnap.data() as MatchOpportunity,
            wallet: walletSnap.data() as Wallet,
            transaction: txSnap.data() as Transaction,
            alreadyProcessed: true,
          };
        }
      }

      // 2. Read Wallet balance
      const walletSnap = await t.get(walletDocRef);
      const currentBalance = walletSnap.exists ? Number(walletSnap.data()?.balance || 0) : 0;
      if (currentBalance < cost) {
        throw new InsufficientBalanceError(
          `Insufficient balance (₦${currentBalance}). ₦${cost} required to purchase a match opportunity.`
        );
      }

      const nowISO = new Date().toISOString();
      const newBalance = currentBalance - cost;
      const oppId = `opp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const txId = `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

      const oppDocRef = this.db.collection('match_opportunities').doc(oppId);
      const txDocRef = this.db.collection('transactions').doc(txId);

      const updatedWallet: Wallet = {
        id: userId,
        userId,
        balance: newBalance,
        currency: 'NGN',
        updatedAt: nowISO,
      };

      const opportunity: MatchOpportunity = {
        id: oppId,
        userId,
        gameId,
        gameTitle: gameTitle || gameId,
        price: cost,
        status: 'available',
        idempotencyKey: key,
        createdAt: nowISO,
        updatedAt: nowISO,
      };

      const ledgerEntry: Transaction = {
        id: txId,
        userId,
        reference: key,
        amount: cost,
        type: 'debit',
        channel: 'match_opportunity',
        status: 'success',
        description: `Match Opportunity: ${gameTitle || gameId}`,
        createdAt: nowISO,
        metadata: { opportunityId: oppId, gameId },
      };

      // Atomic writes: deduct wallet, create opportunity, record transaction, write idempotency record
      t.set(walletDocRef, updatedWallet);
      t.set(oppDocRef, opportunity);
      t.set(txDocRef, ledgerEntry);
      t.set(idempDocRef, {
        idempotencyKey: key,
        userId,
        gameId,
        opportunityId: oppId,
        transactionId: txId,
        createdAt: nowISO,
      });

      return {
        opportunity,
        wallet: updatedWallet,
        transaction: ledgerEntry,
        alreadyProcessed: false,
      };
    });
  }

  // Get all opportunities for a user
  public async getOpportunities(userId: string, status?: OpportunityStatus): Promise<MatchOpportunity[]> {
    if (!userId) return [];
    let query: FirebaseFirestore.Query = this.db.collection('match_opportunities').where('userId', '==', userId);
    if (status) {
      query = query.where('status', '==', status);
    }
    const snap = await query.get();
    const list: MatchOpportunity[] = [];
    snap.forEach((doc) => {
      list.push(doc.data() as MatchOpportunity);
    });
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // Get opportunity by ID (Enforces privacy: returns null if not owner)
  public async getOpportunityById(userId: string, opportunityId: string): Promise<MatchOpportunity | null> {
    if (!userId || !opportunityId) return null;
    const snap = await this.db.collection('match_opportunities').doc(opportunityId).get();
    if (!snap.exists) return null;
    const opp = snap.data() as MatchOpportunity;
    if (opp.userId !== userId) return null; // Private to owner
    return opp;
  }

  // Find available opportunity for a specific game
  public async getAvailableOpportunityForGame(userId: string, gameId: string): Promise<MatchOpportunity | null> {
    if (!userId || !gameId) return null;
    const snap = await this.db
      .collection('match_opportunities')
      .where('userId', '==', userId)
      .where('gameId', '==', gameId)
      .get();

    const list: MatchOpportunity[] = [];
    snap.forEach((doc) => list.push(doc.data() as MatchOpportunity));
    const available = list.find((o) => o.status === 'available');
    if (available) return available;
    const launched = list.find((o) => o.status === 'launched');
    return launched || null;
  }

  // Launch game: uses existing opportunity without creating a second debit!
  public async launchOpportunity(
    userId: string,
    gameId: string,
    opportunityId?: string
  ): Promise<{ opportunity: MatchOpportunity; alreadyLaunched: boolean }> {
    if (!userId) throw new Error('User ID is required to launch');
    if (!gameId) throw new Error('Game ID is required to launch');

    if (opportunityId) {
      const oppRef = this.db.collection('match_opportunities').doc(opportunityId);
      return await this.db.runTransaction(async (t) => {
        const snap = await t.get(oppRef);
        if (!snap.exists) {
          throw new Error(`Match opportunity '${opportunityId}' not found`);
        }
        const opp = snap.data() as MatchOpportunity;
        if (opp.userId !== userId) {
          throw new Error('Access denied: Match opportunity belongs to another gamer');
        }
        if (opp.gameId !== gameId) {
          throw new Error(`Opportunity is for game '${opp.gameTitle || opp.gameId}', not '${gameId}'`);
        }

        if (opp.status === 'launched') {
          return { opportunity: opp, alreadyLaunched: true };
        }

        if (opp.status !== 'available') {
          throw new InvalidTransitionError(
            `Cannot launch match opportunity in status '${opp.status}'. Valid transition is available -> launched.`
          );
        }

        const nowISO = new Date().toISOString();
        const updated: MatchOpportunity = {
          ...opp,
          status: 'launched',
          launchedAt: nowISO,
          updatedAt: nowISO,
        };
        t.set(oppRef, updated);
        return { opportunity: updated, alreadyLaunched: false };
      });
    }

    // If opportunityId not specified: find available opportunity for this user & game
    const opps = await this.getOpportunities(userId);
    const existing = opps.find((o) => o.gameId === gameId && (o.status === 'available' || o.status === 'launched'));

    if (!existing) {
      throw new NoOpportunityAvailableError(
        `No available match opportunity found for game '${gameId}'. Purchase a ₦100 match opportunity to launch.`
      );
    }

    if (existing.status === 'launched') {
      return { opportunity: existing, alreadyLaunched: true };
    }

    const oppRef = this.db.collection('match_opportunities').doc(existing.id);
    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(oppRef);
      const current = snap.data() as MatchOpportunity;
      if (current.status !== 'available') {
        throw new InvalidTransitionError(`Opportunity status changed to '${current.status}'`);
      }
      const nowISO = new Date().toISOString();
      const updated: MatchOpportunity = {
        ...current,
        status: 'launched',
        launchedAt: nowISO,
        updatedAt: nowISO,
      };
      t.set(oppRef, updated);
      return { opportunity: updated, alreadyLaunched: false };
    });
  }

  // Pre-launch cancellation / refund (Restores ₦100 if cancelled BEFORE launch)
  public async refundOpportunity(
    userId: string,
    opportunityId: string,
    reason = 'Cancelled by user before launch'
  ): Promise<{ opportunity: MatchOpportunity; wallet: Wallet; transaction?: Transaction | null; alreadyRefunded?: boolean }> {
    if (!userId || !opportunityId) throw new Error('userId and opportunityId are required for refund');

    const oppRef = this.db.collection('match_opportunities').doc(opportunityId);
    const walletDocRef = this.db.collection('wallets').doc(userId);
    const txId = `tx_rf_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const txDocRef = this.db.collection('transactions').doc(txId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(oppRef);
      if (!snap.exists) {
        throw new Error(`Match opportunity '${opportunityId}' not found`);
      }
      const opp = snap.data() as MatchOpportunity;
      if (opp.userId !== userId) {
        throw new Error('Access denied: Match opportunity belongs to another gamer');
      }

      // Idempotent cancellation: if already refunded, return existing state without duplicate credit
      if (opp.status === 'refunded') {
        const walletSnap = await t.get(walletDocRef);
        const currentWallet: Wallet = walletSnap.exists
          ? (walletSnap.data() as Wallet)
          : { id: userId, userId, balance: 0, currency: 'NGN', updatedAt: new Date().toISOString() };
        return {
          opportunity: opp,
          wallet: currentWallet,
          transaction: null,
          alreadyRefunded: true,
        };
      }

      // Enforce cancellation rule:
      if (opp.status === 'launched') {
        throw new InvalidTransitionError(
          'Cannot refund an opportunity that has already been launched. Once launched, matches cannot be automatically refunded upon disconnect or app closure.'
        );
      }
      if (opp.status === 'completed') {
        throw new InvalidTransitionError('Cannot refund a completed match opportunity.');
      }
      if (opp.status !== 'available') {
        throw new InvalidTransitionError(`Cannot refund match opportunity in status '${opp.status}'.`);
      }

      // Read current wallet
      const walletSnap = await t.get(walletDocRef);
      const currentBalance = walletSnap.exists ? Number(walletSnap.data()?.balance || 0) : 0;
      const newBalance = currentBalance + opp.price;
      const nowISO = new Date().toISOString();

      const updatedWallet: Wallet = {
        id: userId,
        userId,
        balance: newBalance,
        currency: 'NGN',
        updatedAt: nowISO,
      };

      const updatedOpp: MatchOpportunity = {
        ...opp,
        status: 'refunded',
        refundedAt: nowISO,
        updatedAt: nowISO,
      };

      const refundTx: Transaction = {
        id: txId,
        userId,
        reference: `REFUND_${opportunityId}`,
        amount: opp.price,
        type: 'credit',
        channel: 'match_opportunity',
        status: 'success',
        description: `Refund: Pre-launch match cancellation (${opp.gameTitle || opp.gameId})`,
        createdAt: nowISO,
        metadata: { opportunityId, reason },
      };

      t.set(oppRef, updatedOpp);
      t.set(walletDocRef, updatedWallet);
      t.set(txDocRef, refundTx);

      return {
        opportunity: updatedOpp,
        wallet: updatedWallet,
        transaction: refundTx,
        alreadyRefunded: false,
      };
    });
  }

  // Complete opportunity when match finishes
  public async completeOpportunity(userId: string, opportunityId: string): Promise<MatchOpportunity> {
    if (!userId || !opportunityId) throw new Error('userId and opportunityId are required');

    const oppRef = this.db.collection('match_opportunities').doc(opportunityId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(oppRef);
      if (!snap.exists) {
        throw new Error(`Match opportunity '${opportunityId}' not found`);
      }
      const opp = snap.data() as MatchOpportunity;
      if (opp.userId !== userId) {
        throw new Error('Access denied: Match opportunity belongs to another gamer');
      }

      if (opp.status === 'completed') {
        return opp; // idempotent
      }

      if (opp.status === 'available') {
        throw new InvalidTransitionError('Cannot complete a match opportunity that has not been launched.');
      }

      if (opp.status === 'refunded') {
        throw new InvalidTransitionError('Cannot complete a refunded match opportunity.');
      }

      if (opp.status !== 'launched') {
        throw new InvalidTransitionError(`Cannot complete match opportunity in status '${opp.status}'.`);
      }

      const nowISO = new Date().toISOString();
      const updatedOpp: MatchOpportunity = {
        ...opp,
        status: 'completed',
        completedAt: nowISO,
        updatedAt: nowISO,
      };

      t.set(oppRef, updatedOpp);
      return updatedOpp;
    });
  }

  // Clean test documents (isolated test isolation)
  public async clearTestUser(userId: string): Promise<void> {
    if (!userId) return;
    const batch = this.db.batch();
    batch.delete(this.db.collection('wallets').doc(userId));
    batch.delete(this.db.collection('users').doc(userId));
    batch.delete(this.db.collection('active_sessions').doc(userId));
    await batch.commit();

    const txSnap = await this.db.collection('transactions').where('userId', '==', userId).get();
    const txBatch = this.db.batch();
    txSnap.forEach((doc) => txBatch.delete(doc.ref));
    await txBatch.commit();

    const sessSnap = await this.db.collection('sessions').where('userId', '==', userId).get();
    const sessBatch = this.db.batch();
    sessSnap.forEach((doc) => sessBatch.delete(doc.ref));
    await sessBatch.commit();

    const oppSnap = await this.db.collection('match_opportunities').where('userId', '==', userId).get();
    const oppBatch = this.db.batch();
    oppSnap.forEach((doc) => oppBatch.delete(doc.ref));
    await oppBatch.commit();

    const idempSnap = await this.db.collection('processed_purchases').where('userId', '==', userId).get();
    const idempBatch = this.db.batch();
    idempSnap.forEach((doc) => idempBatch.delete(doc.ref));
    await idempBatch.commit();
  }

  // ==========================================
  // PHASE 4.1: LIVE ROOMS & REAL-TIME CHAT
  // ==========================================

  public async createRoom(
    hostId: string,
    hostName: string,
    gameId: string,
    gameTitle: string,
    rawTitle: string
  ): Promise<MatchRoom> {
    if (!hostId) throw new RoomValidationError('Host ID is required to create a room.');
    if (!gameId) throw new RoomValidationError('Game ID is required to create a room.');

    const title = (rawTitle || '').trim();
    if (title.length < 3 || title.length > 60) {
      throw new RoomValidationError('Room title must be between 3 and 60 characters.');
    }

    const roomId = `rm_${crypto.randomBytes(3).toString('hex').toLowerCase()}`;
    const nowISO = new Date().toISOString();

    const initialParticipants: Record<string, RoomParticipant> = {
      [hostId]: {
        userId: hostId,
        displayName: hostName || 'Host',
        joinedAt: nowISO,
        isHost: true,
      },
    };

    const newRoom: MatchRoom = {
      id: roomId,
      hostId,
      hostName: hostName || 'Host',
      gameId,
      gameTitle: gameTitle || gameId,
      title,
      status: 'waiting',
      participantCount: 1,
      participants: initialParticipants,
      stream: {
        isLive: false,
        streamUrl: null,
        startedAt: null,
        protocol: 'hls',
      },
      activeViewers: {},
      viewerCount: 0,
      createdAt: nowISO,
      updatedAt: nowISO,
    };

    await this.db.collection('rooms').doc(roomId).set(newRoom);
    return newRoom;
  }

  public async getRoom(roomId: string): Promise<MatchRoom | null> {
    if (!roomId) return null;
    const snap = await this.db.collection('rooms').doc(roomId).get();
    if (!snap.exists) return null;
    return snap.data() as MatchRoom;
  }

  public async listRooms(gameId?: string, status?: RoomStatus): Promise<MatchRoom[]> {
    let query: FirebaseFirestore.Query = this.db.collection('rooms');

    if (status) {
      query = query.where('status', '==', status);
    } else {
      query = query.where('status', 'in', ['waiting', 'live']);
    }

    if (gameId && gameId !== 'all') {
      query = query.where('gameId', '==', gameId);
    }

    const snap = await query.get();
    const rooms: MatchRoom[] = [];
    snap.forEach((doc) => {
      rooms.push(doc.data() as MatchRoom);
    });

    rooms.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return rooms;
  }

  public async joinRoom(
    roomId: string,
    userId: string,
    userName: string
  ): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!userId) throw new RoomValidationError('User ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) {
        throw new RoomNotFoundError(`Room '${roomId}' not found.`);
      }

      const room = snap.data() as MatchRoom;
      if (room.status === 'ended') {
        throw new RoomEndedError(`Room '${roomId}' has already ended.`);
      }

      const nowISO = new Date().toISOString();
      const participants = { ...(room.participants || {}) };

      participants[userId] = {
        userId,
        displayName: userName || 'Player',
        joinedAt: participants[userId]?.joinedAt || nowISO,
        isHost: (room.hostId === userId),
      };

      const updatedRoom: MatchRoom = {
        ...room,
        participants,
        participantCount: Object.keys(participants).length,
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public async leaveRoom(roomId: string, userId: string): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!userId) throw new RoomValidationError('User ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) {
        throw new RoomNotFoundError(`Room '${roomId}' not found.`);
      }

      const room = snap.data() as MatchRoom;
      const participants = { ...(room.participants || {}) };
      delete participants[userId];

      const nowISO = new Date().toISOString();
      const updatedRoom: MatchRoom = {
        ...room,
        participants,
        participantCount: Object.keys(participants).length,
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public async closeRoom(roomId: string, hostId: string): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!hostId) throw new RoomValidationError('Host ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) {
        throw new RoomNotFoundError(`Room '${roomId}' not found.`);
      }

      const room = snap.data() as MatchRoom;
      if (room.hostId !== hostId) {
        throw new UnauthorizedHostActionError('Only the room host can close this room.');
      }

      const nowISO = new Date().toISOString();
      const updatedRoom: MatchRoom = {
        ...room,
        status: 'ended',
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public async updateRoomStatus(
    roomId: string,
    hostId: string,
    newStatus: RoomStatus
  ): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!hostId) throw new RoomValidationError('Host ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) throw new RoomNotFoundError(`Room '${roomId}' not found.`);

      const room = snap.data() as MatchRoom;
      if (room.hostId !== hostId) {
        throw new UnauthorizedHostActionError('Only the room host can update room status.');
      }

      const nowISO = new Date().toISOString();
      const updatedRoom: MatchRoom = {
        ...room,
        status: newStatus,
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public pruneStaleViewers(
    activeViewers?: Record<string, RoomViewer>,
    cutoffMs = 30000
  ): Record<string, RoomViewer> {
    if (!activeViewers) return {};
    const now = Date.now();
    const result: Record<string, RoomViewer> = {};
    for (const [uid, viewer] of Object.entries(activeViewers)) {
      const lastSeen = new Date(viewer.lastSeenAt).getTime();
      if (!isNaN(lastSeen) && now - lastSeen <= cutoffMs) {
        result[uid] = viewer;
      }
    }
    return result;
  }

  public async heartbeatViewer(
    roomId: string,
    uid: string,
    displayName: string
  ): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!uid) throw new RoomValidationError('User ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) {
        throw new RoomNotFoundError(`Room '${roomId}' not found.`);
      }

      const room = snap.data() as MatchRoom;
      if (room.status === 'ended') {
        throw new RoomEndedError(`Room '${roomId}' has already ended.`);
      }

      const nowISO = new Date().toISOString();
      const viewers = this.pruneStaleViewers(room.activeViewers);

      viewers[uid] = {
        uid,
        displayName: displayName || 'Player',
        joinedAt: viewers[uid]?.joinedAt || nowISO,
        lastSeenAt: nowISO,
      };

      const updatedRoom: MatchRoom = {
        ...room,
        activeViewers: viewers,
        viewerCount: Object.keys(viewers).length,
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public async leaveRoomViewer(roomId: string, uid: string): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!uid) throw new RoomValidationError('User ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) {
        throw new RoomNotFoundError(`Room '${roomId}' not found.`);
      }

      const room = snap.data() as MatchRoom;
      const viewers = this.pruneStaleViewers(room.activeViewers);
      delete viewers[uid];

      const nowISO = new Date().toISOString();
      const updatedRoom: MatchRoom = {
        ...room,
        activeViewers: viewers,
        viewerCount: Object.keys(viewers).length,
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public async updateBroadcastStatus(
    roomId: string,
    hostId: string,
    isLive: boolean,
    streamUrl?: string | null,
    protocol: 'hls' | 'webrtc' | 'custom' = 'hls'
  ): Promise<MatchRoom> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!hostId) throw new RoomValidationError('Host ID is required.');

    const roomRef = this.db.collection('rooms').doc(roomId);

    return await this.db.runTransaction(async (t) => {
      const snap = await t.get(roomRef);
      if (!snap.exists) throw new RoomNotFoundError(`Room '${roomId}' not found.`);

      const room = snap.data() as MatchRoom;
      if (room.hostId !== hostId) {
        throw new UnauthorizedHostActionError('Only the room host can update broadcast settings.');
      }
      if (room.status === 'ended') {
        throw new RoomEndedError(`Cannot broadcast: room '${roomId}' has already ended.`);
      }

      const nowISO = new Date().toISOString();
      const sanitizedUrl = streamUrl ? streamUrl.trim() : null;

      if (isLive && sanitizedUrl) {
        if (
          !sanitizedUrl.startsWith('https://') &&
          !sanitizedUrl.startsWith('rtmp://') &&
          !sanitizedUrl.startsWith('wss://')
        ) {
          throw new RoomValidationError('Stream URL must use a secure protocol (https://, wss://, or rtmp://).');
        }
      }

      const streamState: RoomStreamState = {
        isLive,
        streamUrl: isLive ? sanitizedUrl : null,
        startedAt: isLive ? (room.stream?.startedAt || nowISO) : null,
        protocol: protocol || 'hls',
      };

      const updatedRoom: MatchRoom = {
        ...room,
        status: isLive ? 'live' : room.status,
        stream: streamState,
        updatedAt: nowISO,
      };

      t.set(roomRef, updatedRoom);
      return updatedRoom;
    });
  }

  public async sendMessage(
    roomId: string,
    senderId: string,
    senderName: string,
    rawText: string
  ): Promise<ChatMessage> {
    if (!roomId) throw new RoomValidationError('Room ID is required.');
    if (!senderId) throw new RoomValidationError('Sender ID is required.');

    const text = (rawText || '').trim();
    if (text.length < 1 || text.length > 300) {
      throw new RoomValidationError('Message length must be between 1 and 300 characters.');
    }

    const now = Date.now();
    const lastTime = this.userLastMessageMap.get(senderId) || 0;
    if (now - lastTime < 1000) {
      throw new ChatRateLimitError('You are sending messages too quickly. Please wait a second.');
    }
    this.userLastMessageMap.set(senderId, now);

    const roomSnap = await this.db.collection('rooms').doc(roomId).get();
    if (!roomSnap.exists) {
      throw new RoomNotFoundError(`Room '${roomId}' not found.`);
    }

    const room = roomSnap.data() as MatchRoom;
    if (room.status === 'ended') {
      throw new RoomEndedError('Cannot send message: this match room has ended.');
    }

    if (!room.participants || !room.participants[senderId]) {
      throw new ChatUnauthorizedError('You must join this room before sending chat messages.');
    }

    const msgId = `msg_${now}_${crypto.randomBytes(3).toString('hex')}`;
    const nowISO = new Date().toISOString();

    const chatMsg: ChatMessage = {
      id: msgId,
      roomId,
      senderId,
      senderName: senderName || 'Player',
      text,
      createdAt: nowISO,
    };

    await this.db
      .collection('rooms')
      .doc(roomId)
      .collection('messages')
      .doc(msgId)
      .set(chatMsg);

    return chatMsg;
  }

  public async getMessages(roomId: string, limitCount = 50): Promise<ChatMessage[]> {
    if (!roomId) return [];
    const snap = await this.db
      .collection('rooms')
      .doc(roomId)
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(limitCount)
      .get();

    const messages: ChatMessage[] = [];
    snap.forEach((doc) => {
      messages.push(doc.data() as ChatMessage);
    });

    messages.reverse();
    return messages;
  }
}

export const firestoreRepo = new FirestoreRepository();
