import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
  verifyFirebaseIdToken,
  getCustomTokenVerifier,
} from '../firebaseAdmin.js';
import { verifyAccessToken, AccessTokenClaims } from './tokenService.js';
import { authRepo } from './authRepository.js';

export interface DualAuthOptions {
  checkRevocation?: boolean;
}

/**
 * Result of dual token verification
 */
export interface DualAuthVerificationResult {
  user: AuthenticatedUser;
  claims?: AccessTokenClaims;
}

/**
 * Parses and verifies either a Gaming Hub access token or a Firebase ID token.
 *
 * Strict Isolation Guarantees:
 * 1. Tokens signed with HS256 are verified strictly against Gaming Hub secret and session storage.
 *    Any failure in HS256 verification NEVER falls back to Firebase Admin.
 * 2. Tokens signed with RS256 (or mock test tokens) are verified strictly against Firebase Admin SDK.
 *    Any failure in RS256 verification NEVER falls back to Gaming Hub secret.
 * 3. Any token with an unsupported algorithm (e.g. 'none', 'HS384', 'ES256') is rejected immediately.
 */
export async function verifyDualToken(
  token: string,
  checkRevocation = false
): Promise<AuthenticatedUser> {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    const error: any = new Error('Unauthorized: Bearer token is empty.');
    error.code = 'AUTH_TOKEN_EMPTY';
    error.statusCode = 401;
    throw error;
  }

  const cleanToken = token.trim();

  // Inspect the unverified JWT structure to determine algorithm
  let decodedHeader: { alg?: string; typ?: string } | null = null;
  try {
    const decoded = jwt.decode(cleanToken, { complete: true });
    if (decoded && decoded.header) {
      decodedHeader = decoded.header as { alg?: string; typ?: string };
    }
  } catch {
    // Malformed JWT syntax
  }

  // Handle test harness mock verifier if non-JWT token is passed in non-production
  if (!decodedHeader) {
    if (process.env.NODE_ENV !== 'production' && getCustomTokenVerifier()) {
      try {
        const fbUser = await verifyFirebaseIdToken(cleanToken, checkRevocation);
        return {
          uid: fbUser.uid,
          email: fbUser.email,
          emailVerified: fbUser.emailVerified,
          phoneNumber: fbUser.phoneNumber,
          role: fbUser.role || 'user',
          authProvider: fbUser.authProvider || 'firebase',
        };
      } catch (err: any) {
        const isRevoked = err.code === 'auth/id-token-revoked' || (err.message && err.message.toLowerCase().includes('revoked'));
        const error: any = new Error(
          isRevoked
            ? 'Unauthorized: Firebase ID token has been revoked.'
            : 'Unauthorized: Token verification failed or expired.'
        );
        error.code = isRevoked ? 'AUTH_TOKEN_REVOKED' : 'AUTH_TOKEN_VERIFICATION_FAILED';
        error.statusCode = 401;
        error.details = err.message;
        throw error;
      }
    }
    const error: any = new Error('Unauthorized: Malformed or unparseable authorization token.');
    error.code = 'AUTH_TOKEN_MALFORMED';
    error.statusCode = 401;
    throw error;
  }

  const alg = decodedHeader.alg;

  // 1. Independent Gaming Hub Access Token (HS256)
  if (alg === 'HS256') {
    let claims: AccessTokenClaims;
    try {
      claims = verifyAccessToken(cleanToken);
    } catch (err: any) {
      const error: any = new Error(
        err.name === 'TokenExpiredError'
          ? 'Unauthorized: Access token has expired.'
          : 'Unauthorized: Invalid access token signature or payload.'
      );
      error.code = err.name === 'TokenExpiredError' ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID';
      error.statusCode = 401;
      error.details = err.message;
      throw error;
    }

    // Verify session existence, active status, and expiry in repository
    const session = await authRepo.getSessionById(claims.sessionId);
    if (!session) {
      const error: any = new Error('Unauthorized: Session not found.');
      error.code = 'SESSION_NOT_FOUND';
      error.statusCode = 401;
      throw error;
    }

    if (session.isRevoked) {
      const error: any = new Error('Unauthorized: Session has been revoked.');
      error.code = 'SESSION_REVOKED';
      error.statusCode = 401;
      throw error;
    }

    if (session.expiresAt && session.expiresAt <= Date.now()) {
      const error: any = new Error('Unauthorized: Session has expired.');
      error.code = 'SESSION_EXPIRED';
      error.statusCode = 401;
      throw error;
    }

    if (session.userId !== claims.uid) {
      const error: any = new Error('Unauthorized: Session user mismatch.');
      error.code = 'AUTH_TOKEN_INVALID';
      error.statusCode = 401;
      throw error;
    }

    return {
      uid: claims.uid,
      email: claims.email,
      emailVerified: true,
      role: claims.role,
      authProvider: 'gaminghub',
      sessionId: claims.sessionId,
    };
  }

  // 2. Firebase ID Token (RS256)
  if (alg === 'RS256') {
    try {
      const fbUser = await verifyFirebaseIdToken(cleanToken, checkRevocation);
      return {
        uid: fbUser.uid,
        email: fbUser.email,
        emailVerified: fbUser.emailVerified,
        phoneNumber: fbUser.phoneNumber,
        role: fbUser.role || 'user',
        authProvider: 'firebase',
      };
    } catch (err: any) {
      const isRevoked = err.code === 'auth/id-token-revoked' || (err.message && err.message.toLowerCase().includes('revoked'));
      const error: any = new Error(
        isRevoked
          ? 'Unauthorized: Firebase ID token has been revoked.'
          : 'Unauthorized: Token verification failed or expired.'
      );
      error.code = isRevoked ? 'AUTH_TOKEN_REVOKED' : 'AUTH_TOKEN_VERIFICATION_FAILED';
      error.statusCode = 401;
      error.details = err.message;
      throw error;
    }
  }

  // 3. Any other algorithm is strictly rejected
  const error: any = new Error(`Unauthorized: Unsupported token algorithm '${alg}'.`);
  error.code = 'AUTH_TOKEN_ALGORITHM_UNSUPPORTED';
  error.statusCode = 401;
  throw error;
}

/**
 * Express Middleware Factory: createDualAuthMiddleware
 *
 * Verifies either Gaming Hub access tokens (HS256) or Firebase ID tokens (RS256).
 * Enforces cross-user resource protection (HTTP 403 FORBIDDEN_USER_MISMATCH).
 * Allows passing options like checkRevocation.
 */
export function createDualAuthMiddleware(options?: DualAuthOptions) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or malformed Authorization header. Expected Bearer <token>.',
        code: 'AUTH_HEADER_MISSING',
      });
    }

    const token = authHeader.substring(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Bearer token is empty.',
        code: 'AUTH_TOKEN_EMPTY',
      });
    }

    try {
      const verifiedUser = await verifyDualToken(token, options?.checkRevocation);

      if (!verifiedUser || !verifiedUser.uid) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized: Invalid token payload.',
          code: 'AUTH_TOKEN_INVALID',
        });
      }

      req.user = verifiedUser;

      // Strict Cross-User Authorization Check:
      // If the client submitted a target userId in body, query, or params,
      // verify that it strictly matches the authenticated user's verified UID.
      const requestedUserId = req.query.userId || req.body?.userId || req.params?.userId;
      if (requestedUserId && typeof requestedUserId === 'string' && requestedUserId !== verifiedUser.uid) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: You cannot access or modify another user's resources.",
          code: 'FORBIDDEN_USER_MISMATCH',
          authenticatedUid: verifiedUser.uid,
        });
      }

      next();
    } catch (err: any) {
      const statusCode = err.statusCode || 401;
      const code = err.code || 'AUTH_TOKEN_VERIFICATION_FAILED';
      return res.status(statusCode).json({
        success: false,
        error: err.message || 'Unauthorized: Token verification failed.',
        code,
        details: err.details,
      });
    }
  };
}

export const authenticateDualAuth = createDualAuthMiddleware();
export const authenticateDualAuthStrict = createDualAuthMiddleware({ checkRevocation: true });
export const authenticateDualAuthWithRevocation = authenticateDualAuthStrict;

// Aliases for seamless migration and integration
export const authenticateUser = authenticateDualAuth;
export const authenticateDualUser = authenticateDualAuth;
