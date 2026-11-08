import { initializeApp, getApps, App, cert } from 'firebase-admin/app';
import { getAuth, DecodedIdToken } from 'firebase-admin/auth';
import { Request, Response, NextFunction } from 'express';
import firebaseConfig from '../../firebase-applet-config.json';

// Verify the intended Firebase project ID from verified configuration
export const EXPECTED_PROJECT_ID = 'gen-lang-client-0739137370';

export interface FirebaseAdminInitOptions {
  serviceAccountKeyJson?: string;
  projectId?: string;
  googleAppCreds?: string;
  isProduction?: boolean;
  isExternalHosting?: boolean;
}

/**
 * Initializes or retrieves the Firebase Admin App instance.
 * Fails fast with clear, safe error messages in production if credentials are missing or invalid.
 */
export function createFirebaseAdminApp(options?: FirebaseAdminInitOptions): App {
  const existingApps = getApps();
  if (existingApps.length > 0) {
    return existingApps[0]!;
  }

  const isProd = options?.isProduction !== undefined
    ? options.isProduction
    : process.env.NODE_ENV === 'production';

  const configProjectId = options?.projectId ?? firebaseConfig.projectId;
  const targetProjectId = configProjectId || EXPECTED_PROJECT_ID;

  if (configProjectId !== EXPECTED_PROJECT_ID) {
    const mismatchMsg = `Firebase project ID mismatch. Expected ${EXPECTED_PROJECT_ID}, got ${configProjectId}.`;
    console.error(`[FirebaseAdmin] CRITICAL MISMATCH: ${mismatchMsg}`);
    if (isProd) {
      throw new Error(mismatchMsg);
    }
  }

  const rawKeyJson = options?.serviceAccountKeyJson !== undefined
    ? options.serviceAccountKeyJson
    : process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  const googleAppCreds = options?.googleAppCreds !== undefined
    ? options.googleAppCreds
    : process.env.GOOGLE_APPLICATION_CREDENTIALS;

  // Detect whether running in a Google Cloud native environment (Cloud Run, GAE, Cloud Functions)
  const isGcpEnvironment = Boolean(
    process.env.K_SERVICE ||
    process.env.GOOGLE_RUNTIME ||
    process.env.K_REVISION ||
    process.env.CLOUD_RUN_JOB ||
    process.env.GAE_ENV
  );

  // External hosting (e.g. Render, Railway, AWS, or explicit non-GCP production) where GCP metadata credentials are unavailable
  const isExternalHosting = options?.isExternalHosting !== undefined
    ? options.isExternalHosting
    : (options?.isProduction !== undefined ? true : (Boolean(process.env.RENDER) || !isGcpEnvironment));

  let credential;
  if (rawKeyJson) {
    try {
      const keyData = JSON.parse(rawKeyJson);
      if (typeof keyData !== 'object' || keyData === null || Array.isArray(keyData)) {
        throw new Error('Malformed object');
      }
      if (keyData.project_id && keyData.project_id !== EXPECTED_PROJECT_ID) {
        throw new Error(`Firebase service account project ID mismatch. Expected ${EXPECTED_PROJECT_ID}, got ${keyData.project_id}.`);
      }
      credential = cert(keyData);
    } catch (err: any) {
      if (err.message && err.message.includes('mismatch')) {
        throw err;
      }
      if (isProd) {
        throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_KEY format.');
      }
      console.warn('[FirebaseAdmin] Could not parse FIREBASE_SERVICE_ACCOUNT_KEY JSON in non-production.');
    }
  } else if (isProd && isExternalHosting && !googleAppCreds) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_KEY or GOOGLE_APPLICATION_CREDENTIALS in production.');
  }

  if (isProd) {
    return initializeApp({
      projectId: targetProjectId,
      ...(credential ? { credential } : {}),
    });
  }

  try {
    const app = initializeApp({
      projectId: targetProjectId,
      ...(credential ? { credential } : {}),
    });
    console.log(`[FirebaseAdmin] Initialized Firebase Admin for project: ${targetProjectId}`);
    return app;
  } catch (err: any) {
    console.warn('[FirebaseAdmin] Development fallback initialize:', err.message);
    return initializeApp({ projectId: EXPECTED_PROJECT_ID }, 'fallback');
  }
}

// Initialize Firebase Admin SDK safely
let adminApp: App;
const existingApps = getApps();
if (existingApps.length === 0) {
  adminApp = createFirebaseAdminApp();
} else {
  adminApp = existingApps[0]!;
}

export { adminApp };

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  role?: string;
  authProvider?: 'firebase' | 'gaminghub';
  sessionId?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

// Custom token verifier interface to support test mocking without exposing production keys
type TokenVerifierFn = (token: string, checkRevocation?: boolean) => Promise<AuthenticatedUser>;

let customTokenVerifier: TokenVerifierFn | null = null;

export function setCustomTokenVerifier(verifier: TokenVerifierFn | null) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Custom token verifiers are strictly forbidden in production');
  }
  customTokenVerifier = verifier;
}

export function getCustomTokenVerifier(): TokenVerifierFn | null {
  return customTokenVerifier;
}

/**
 * Verifies a Firebase ID token using Firebase Admin Auth.
 * When checkRevocation is true, checks whether the token has been revoked in Firebase Auth.
 */
export async function verifyFirebaseIdToken(token: string, checkRevocation = false): Promise<AuthenticatedUser> {
  // If a test harness verifier is registered (for automated unit testing in non-production), use it
  if (process.env.NODE_ENV !== 'production' && customTokenVerifier) {
    return await customTokenVerifier(token, checkRevocation);
  }

  // Real Firebase Admin SDK verification
  const auth = getAuth(adminApp);
  const decoded: DecodedIdToken = await auth.verifyIdToken(token, checkRevocation);
  return {
    uid: decoded.uid,
    email: decoded.email,
    emailVerified: Boolean(decoded.email_verified),
    phoneNumber: decoded.phone_number,
  };
}


/**
 * Express Middleware: authenticateFirebaseUser
 * 
 * Strict requirements:
 * 1. Checks Authorization header for 'Bearer <token>'.
 * 2. Returns HTTP 401 if missing, invalid, or expired.
 * 3. Derives authenticated identity strictly from token uid.
 * 4. Rejects attempts to access another user's data (HTTP 403).
 */
export async function authenticateFirebaseUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing or malformed Authorization header. Expected Bearer <token>.',
      code: 'AUTH_HEADER_MISSING',
    });
  }

  const idToken = authHeader.substring(7).trim();

  if (!idToken) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Bearer token is empty.',
      code: 'AUTH_TOKEN_EMPTY',
    });
  }

  try {
    const verifiedUser = await verifyFirebaseIdToken(idToken);

    if (!verifiedUser || !verifiedUser.uid) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid token payload.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    req.user = verifiedUser;

    // Strict Authorization Check:
    // If the client submitted a target userId in the body, query, or params,
    // verify that it strictly matches the authenticated user's verified UID.
    const requestedUserId = req.query.userId || req.body?.userId || req.params?.userId;
    if (requestedUserId && typeof requestedUserId === 'string' && requestedUserId !== verifiedUser.uid) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You cannot access or modify another user\'s resources.',
        code: 'FORBIDDEN_USER_MISMATCH',
        authenticatedUid: verifiedUser.uid,
      });
    }

    next();
  } catch (err: any) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Token verification failed or expired.',
      details: err.message || 'Invalid token',
      code: 'AUTH_TOKEN_VERIFICATION_FAILED',
    });
  }
}
