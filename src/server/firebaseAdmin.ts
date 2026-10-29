import { initializeApp, getApps, App } from 'firebase-admin/app';
import { getAuth, DecodedIdToken } from 'firebase-admin/auth';
import { Request, Response, NextFunction } from 'express';
import firebaseConfig from '../../firebase-applet-config.json';

// Verify the intended Firebase project ID from verified configuration
const EXPECTED_PROJECT_ID = 'gen-lang-client-0739137370';

if (firebaseConfig.projectId !== EXPECTED_PROJECT_ID) {
  console.error(`[FirebaseAdmin] CRITICAL MISMATCH: Expected project ${EXPECTED_PROJECT_ID}, got ${firebaseConfig.projectId}`);
}

// Initialize Firebase Admin SDK safely
let adminApp: App;
const existingApps = getApps();
if (existingApps.length === 0) {
  try {
    adminApp = initializeApp({
      projectId: firebaseConfig.projectId || EXPECTED_PROJECT_ID,
    });
    console.log(`[FirebaseAdmin] Initialized Firebase Admin for project: ${firebaseConfig.projectId}`);
  } catch (err: any) {
    console.warn('[FirebaseAdmin] Admin initialize notice:', err.message);
    adminApp = initializeApp({ projectId: EXPECTED_PROJECT_ID }, 'fallback');
  }
} else {
  adminApp = existingApps[0]!;
}

export { adminApp };

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  phoneNumber?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

// Custom token verifier interface to support test mocking without exposing production keys
type TokenVerifierFn = (token: string) => Promise<AuthenticatedUser>;

let customTokenVerifier: TokenVerifierFn | null = null;

export function setCustomTokenVerifier(verifier: TokenVerifierFn | null) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Custom token verifiers are strictly forbidden in production');
  }
  customTokenVerifier = verifier;
}

/**
 * Verifies a Firebase ID token using Firebase Admin Auth
 */
export async function verifyFirebaseIdToken(token: string): Promise<AuthenticatedUser> {
  // If a test harness verifier is registered (for automated unit testing in non-production), use it
  if (process.env.NODE_ENV !== 'production' && customTokenVerifier) {
    return await customTokenVerifier(token);
  }

  // Real Firebase Admin SDK verification
  const auth = getAuth(adminApp);
  const decoded: DecodedIdToken = await auth.verifyIdToken(token);
  return {
    uid: decoded.uid,
    email: decoded.email,
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
