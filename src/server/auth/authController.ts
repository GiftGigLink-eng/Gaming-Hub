import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { hashPassword, verifyPassword, needsRehash, verifyDummyPassword, MAX_PASSWORD_LENGTH } from './argon2Service.js';
import {
  generateAccessToken,
  generateRawRefreshToken,
  hashRefreshToken,
  generateSessionId,
  generateFamilyId,
  verifyAccessToken,
  ACCESS_TOKEN_EXPIRATION_SECONDS,
  REFRESH_TOKEN_EXPIRATION_MS,
  GamingHubTokenPayload,
} from './tokenService.js';
import { authRepo, AuthCredential, AuthSession, REFRESH_GRACE_WINDOW_MS } from './authRepository.js';
import { authRateLimiter } from './authRateLimiter.js';
import { verifyFirebaseIdToken } from '../firebaseAdmin.js';

export interface GamingHubAuthenticatedRequest extends Request {
  gamingHubUser?: GamingHubTokenPayload;
}

/**
 * Validates email format according to standard RFC rules
 */
export function validateEmailFormat(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed);
}

/**
 * Validates password strength:
 * - Minimum 8 characters, maximum 128 characters
 * - Contains at least one letter and one number
 */
export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  if (!password || typeof password !== 'string') {
    return { valid: false, reason: 'Password is required' };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { valid: false, reason: `Password cannot exceed ${MAX_PASSWORD_LENGTH} characters` };
  }
  if (password.length < 8) {
    return { valid: false, reason: 'Password must be at least 8 characters long' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one number' };
  }
  return { valid: true };
}

/**
 * POST /api/auth/register
 * 
 * Strict Account Ownership Policy:
 * Ordinary registration NEVER automatically attaches credentials to an existing Firebase UID
 * based solely on an email match. If an account already exists, the user must authenticate
 * through the dedicated /api/auth/link-credentials endpoint using a valid Firebase ID token.
 */
export async function handleRegister(req: Request, res: Response) {
  try {
    const { email, password, displayName } = req.body || {};

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
        code: 'VALIDATION_ERROR',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!validateEmailFormat(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid email address (e.g. player@gaminghub.ng)',
        code: 'INVALID_EMAIL_FORMAT',
      });
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        error: passwordValidation.reason,
        code: 'WEAK_PASSWORD',
      });
    }

    // 1. Check if independent credentials already exist for this email
    const existingCred = await authRepo.getCredentialByEmail(normalizedEmail);
    if (existingCred) {
      return res.status(409).json({
        success: false,
        error: 'An account with this email address already exists. Please sign in instead.',
        code: 'EMAIL_ALREADY_IN_USE',
      });
    }

    // 2. Check if an existing Firebase player profile exists for this email without independent credentials
    const existingUser = await authRepo.findExistingUserByEmail(normalizedEmail);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'An account with this email already exists in Gaming Hub. Please authenticate with your existing account to link credentials.',
        code: 'FIREBASE_ACCOUNT_EXISTS_LINKING_REQUIRED',
      });
    }

    // New independent registration: generate fresh gaming hub UID

    const userId = `gh_${crypto.randomBytes(14).toString('hex')}`;

    // Hash password with Argon2id

    const passwordHash = await hashPassword(password);

    const nowIso = new Date().toISOString();
    const newCredential: AuthCredential = {
      userId,
      email: normalizedEmail,
      passwordHash,
      failedLoginAttempts: 0,
      lockUntil: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await authRepo.createCredential(newCredential);

    // Ensure user profile & wallet exist for new user
    const finalDisplayName = (displayName && typeof displayName === 'string' && displayName.trim().length >= 2)
      ? displayName.trim()
      : normalizedEmail.split('@')[0];

    const userProfile = await authRepo.ensureUserProfile({
      id: userId,
      email: normalizedEmail,
      phoneNumber: '',
      displayName: finalDisplayName,
      role: 'user',
      createdAt: nowIso,
    });


    // Create session and issue tokens
    const sessionId = generateSessionId();
    const familyId = generateFamilyId();
    const rawRefreshToken = generateRawRefreshToken();
    const refreshTokenHash = hashRefreshToken(rawRefreshToken);
    const clientIp = authRateLimiter.getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';

    const session: AuthSession = {
      sessionId,
      userId,
      familyId,
      refreshTokenHash,
      previousRefreshTokenHash: null,
      consumedTokenHashes: [],
      isRevoked: false,
      revokedReason: null,
      expiresAt: Date.now() + REFRESH_TOKEN_EXPIRATION_MS,
      createdAt: nowIso,
      lastRotatedAt: nowIso,
      userAgent,
      ip: clientIp,
    };

    await authRepo.createSession(session);

    const accessToken = generateAccessToken({
      sub: userId,
      uid: userId,
      email: normalizedEmail,
      sessionId,
      role: userProfile.role || 'user',
    });

    // Note: NEVER return passwordHash or refreshTokenHash
    return res.status(201).json({
      success: true,
      user: {
        id: userId,
        email: normalizedEmail,
        displayName: userProfile.displayName,
        role: userProfile.role,
        createdAt: userProfile.createdAt,
      },
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRATION_SECONDS,
        tokenType: 'Bearer',
      },
    });
  } catch (err: any) {
    console.error('[AuthController] Registration error:', err);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred during registration. Please try again.',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}

/**
 * POST /api/auth/link-credentials
 * 
 * Secure Credential Linking Endpoint:
 * Allows an existing authenticated Firebase user to create independent Gaming Hub credentials.
 * Strict Requirements:
 * - Requires Authorization: Bearer <firebaseIdToken>
 * - Verifies token with Firebase Admin Auth
 * - Identity (UID and Email) is derived exclusively from verified token claims (client-supplied IDs ignored)
 * - Prevents duplicate linking if credentials already exist
 * - Preserves existing Firebase UID, player record, wallet balance, and transaction history
 */
export async function handleLinkCredentials(req: Request, res: Response) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or malformed Authorization header. Firebase ID token required.',
        code: 'AUTH_HEADER_MISSING',
      });
    }

    const firebaseToken = authHeader.substring(7).trim();
    if (!firebaseToken) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Bearer token is empty.',
        code: 'AUTH_TOKEN_EMPTY',
      });
    }

    let authenticatedFirebaseUser;
    try {
      // Enforce revocation checking for sensitive credential linking operation
      authenticatedFirebaseUser = await verifyFirebaseIdToken(firebaseToken, true);
    } catch (err: any) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid, expired, or revoked Firebase authentication token.',
        code: 'FIREBASE_TOKEN_INVALID',
      });
    }

    const tokenUid = authenticatedFirebaseUser.uid;
    const tokenEmail = authenticatedFirebaseUser.email;

    if (!tokenUid || !tokenEmail) {
      return res.status(400).json({
        success: false,
        error: 'The authenticated Firebase session must have an associated email address to link credentials.',
        code: 'FIREBASE_EMAIL_REQUIRED',
      });
    }

    // Require verified email status on the Firebase account before linking independent credentials
    if (!authenticatedFirebaseUser.emailVerified) {
      return res.status(403).json({
        success: false,
        error: 'Firebase email address must be verified before linking independent credentials.',
        code: 'FIREBASE_EMAIL_UNVERIFIED',
      });
    }

    const normalizedTokenEmail = tokenEmail.trim().toLowerCase();

    // If client supplied an email in request body, it MUST match the token's email
    if (req.body?.email) {
      const bodyEmail = String(req.body.email).trim().toLowerCase();
      if (bodyEmail !== normalizedTokenEmail) {
        return res.status(400).json({
          success: false,
          error: 'The provided email does not match the authenticated Firebase account email.',
          code: 'EMAIL_MISMATCH',
        });
      }
    }

    const { password } = req.body || {};
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        error: passwordValidation.reason,
        code: 'WEAK_PASSWORD',
      });
    }

    // Check if credentials are already linked to this UID
    const existingCredByUid = await authRepo.getCredentialByUserId(tokenUid);
    if (existingCredByUid) {
      return res.status(409).json({
        success: false,
        error: 'Independent credentials are already linked to this account.',
        code: 'CREDENTIALS_ALREADY_LINKED',
      });
    }

    // Check if credentials already exist for this email
    const existingCredByEmail = await authRepo.getCredentialByEmail(normalizedTokenEmail);
    if (existingCredByEmail) {
      return res.status(409).json({
        success: false,
        error: 'Credentials for this email address already exist.',
        code: 'EMAIL_ALREADY_LINKED',
      });
    }

    // Hash password with Argon2id
    const passwordHash = await hashPassword(password);
    const nowIso = new Date().toISOString();

    const credential: AuthCredential = {
      userId: tokenUid,
      email: normalizedTokenEmail,
      passwordHash,
      failedLoginAttempts: 0,
      lockUntil: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    // Atomic transaction: prevents concurrent linking requests from overwriting an existing credential
    try {
      await authRepo.createCredentialAtomic(credential);
    } catch (atomicErr: any) {
      if (atomicErr.code === 'CREDENTIALS_ALREADY_LINKED' || atomicErr.code === 'EMAIL_ALREADY_LINKED') {
        return res.status(409).json({
          success: false,
          error: atomicErr.message || 'Credentials already linked.',
          code: atomicErr.code,
        });
      }
      throw atomicErr;
    }


    // Ensure user profile & wallet exist for this verified UID
    let existingProfile = await authRepo.getUserProfile(tokenUid);
    if (!existingProfile) {
      existingProfile = await authRepo.ensureUserProfile({
        id: tokenUid,
        email: normalizedTokenEmail,
        phoneNumber: authenticatedFirebaseUser.phoneNumber || '',
        displayName: req.body?.displayName?.trim() || normalizedTokenEmail.split('@')[0],
        role: 'user',
        createdAt: nowIso,
      });
    }

    // Create session and issue tokens
    const sessionId = generateSessionId();
    const familyId = generateFamilyId();
    const rawRefreshToken = generateRawRefreshToken();
    const refreshTokenHash = hashRefreshToken(rawRefreshToken);
    const clientIp = authRateLimiter.getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';

    const session: AuthSession = {
      sessionId,
      userId: tokenUid,
      familyId,
      refreshTokenHash,
      previousRefreshTokenHash: null,
      consumedTokenHashes: [],
      isRevoked: false,
      revokedReason: null,
      expiresAt: Date.now() + REFRESH_TOKEN_EXPIRATION_MS,
      createdAt: nowIso,
      lastRotatedAt: nowIso,
      userAgent,
      ip: clientIp,
    };

    await authRepo.createSession(session);

    const accessToken = generateAccessToken({
      sub: tokenUid,
      uid: tokenUid,
      email: normalizedTokenEmail,
      sessionId,
      role: existingProfile.role || 'user',
    });

    return res.status(201).json({
      success: true,
      message: 'Credentials successfully linked to existing Firebase account.',
      user: {
        id: tokenUid,
        email: normalizedTokenEmail,
        displayName: existingProfile.displayName,
        role: existingProfile.role,
        createdAt: existingProfile.createdAt,
      },
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRATION_SECONDS,
        tokenType: 'Bearer',
      },
    });
  } catch (err: any) {
    console.error('[AuthController] Link credentials error:', err);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred while linking credentials.',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}


/**
 * POST /api/auth/login
 */
export async function handleLogin(req: Request, res: Response) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required',
        code: 'VALIDATION_ERROR',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const clientIp = authRateLimiter.getClientIp(req);

    // Generic error message to prevent user enumeration
    const invalidCredentialsResponse = () =>
      res.status(401).json({
        success: false,
        error: 'Incorrect email or password. Please verify your credentials or reset your password.',
        code: 'INVALID_CREDENTIALS',
      });

    // Enforce 128-character limit early
    if (password.length > MAX_PASSWORD_LENGTH) {
      return invalidCredentialsResponse();
    }

    // IP-scoped and composite (email, ip) rate-limiting to prevent global account lockout DoS
    const attemptCheck = authRateLimiter.checkFailedLoginAllowed(normalizedEmail, clientIp);
    if (!attemptCheck.allowed) {
      res.setHeader('Retry-After', attemptCheck.retryAfterSeconds.toString());
      return res.status(429).json({
        success: false,
        error: `Too many failed login attempts. Please wait ${attemptCheck.retryAfterSeconds} seconds before trying again.`,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: attemptCheck.retryAfterSeconds,
      });
    }

    const cred = await authRepo.getCredentialByEmail(normalizedEmail);

    if (!cred) {
      // User does not exist: run dummy Argon2 verification to equalize timing (~60-90ms)
      await verifyDummyPassword(password);
      authRateLimiter.recordFailedLogin(normalizedEmail, clientIp);
      return invalidCredentialsResponse();
    }

    // Verify Argon2id password hash
    const isValid = await verifyPassword(cred.passwordHash, password);

    if (!isValid) {
      const recordResult = authRateLimiter.recordFailedLogin(normalizedEmail, clientIp);
      if (!recordResult.allowed) {
        res.setHeader('Retry-After', recordResult.retryAfterSeconds.toString());
        return res.status(429).json({
          success: false,
          error: `Too many failed login attempts. Please wait ${recordResult.retryAfterSeconds} seconds before trying again.`,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: recordResult.retryAfterSeconds,
        });
      }
      return invalidCredentialsResponse();
    }

    // Successful login: reset failed attempts for this (email, ip) pair
    authRateLimiter.resetFailedLogin(normalizedEmail, clientIp);

    // Check if Argon2 hash needs rehash due to upgraded parameters
    if (needsRehash(cred.passwordHash)) {
      hashPassword(password)
        .then((newHash) => authRepo.updateCredential(cred.userId, { passwordHash: newHash }))
        .catch((e) => console.warn('[AuthController] Background rehash error:', e.message));
    }

    // Fetch user profile
    const userProfile = await authRepo.getUserProfile(cred.userId);
    const nowIso = new Date().toISOString();

    // Create new session
    const sessionId = generateSessionId();
    const familyId = generateFamilyId();
    const rawRefreshToken = generateRawRefreshToken();
    const refreshTokenHash = hashRefreshToken(rawRefreshToken);
    const userAgent = req.headers['user-agent'] || 'unknown';

    const session: AuthSession = {
      sessionId,
      userId: cred.userId,
      familyId,
      refreshTokenHash,
      previousRefreshTokenHash: null,
      consumedTokenHashes: [],
      isRevoked: false,
      revokedReason: null,
      expiresAt: Date.now() + REFRESH_TOKEN_EXPIRATION_MS,
      createdAt: nowIso,
      lastRotatedAt: nowIso,
      userAgent,
      ip: clientIp,
    };

    await authRepo.createSession(session);

    const accessToken = generateAccessToken({
      sub: cred.userId,
      uid: cred.userId,
      email: cred.email,
      sessionId,
      role: userProfile?.role || 'user',
    });

    return res.json({
      success: true,
      user: {
        id: cred.userId,
        email: cred.email,
        displayName: userProfile?.displayName || cred.email.split('@')[0],
        role: userProfile?.role || 'user',
        createdAt: userProfile?.createdAt || cred.createdAt,
      },
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRATION_SECONDS,
        tokenType: 'Bearer',
      },
    });
  } catch (err: any) {
    console.error('[AuthController] Login error:', err);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred during login. Please try again.',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}

/**
 * POST /api/auth/refresh
 * 
 * Secure Refresh-Token Rotation with Concurrency Grace Window:
 * - Current valid token: Rotates atomically, adds previous token to bounded history.
 * - Consumed token within grace window (25s): Recognizes multi-tab race / network retry;
 *   returns 409 CONCURRENT_REFRESH without revoking the session family.
 * - Consumed token outside grace window (>25s): Confirmed token theft/replay attack;
 *   immediately revokes entire token family and returns 401 AUTH_REPLAY_ATTACK_DETECTED.
 */
export async function handleRefresh(req: Request, res: Response) {
  try {
    const { refreshToken } = req.body || {};

    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Refresh token is required',
        code: 'MISSING_REFRESH_TOKEN',
      });
    }

    const providedTokenHash = hashRefreshToken(refreshToken);

    // Look up session by either current active token or consumed token history
    const sessionResult = await authRepo.findSessionByTokenHash(providedTokenHash);

    if (!sessionResult || sessionResult.session.isRevoked) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or revoked refresh token. Please sign in again.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    const { session, isCurrent, isConsumed, consumedRecord } = sessionResult;

    // Optional cryptographic idempotency key for safe lost-response retry recovery
    const clientKey = req.body?.idempotencyKey || req.headers['x-idempotency-key'];
    const effectiveIdempotencyKey = (typeof clientKey === 'string' && clientKey.trim().length >= 8)
      ? clientKey.trim()
      : null;

    // Case 1: Consumed token presented
    if (isConsumed) {
      const consumedAt = consumedRecord?.consumedAt || new Date(session.lastRotatedAt).getTime() || 0;
      const elapsedMs = Date.now() - consumedAt;

      if (elapsedMs <= REFRESH_GRACE_WINDOW_MS) {
        // Safe Lost-Response Recovery:
        // If the client supplies the identical idempotency key bound to the rotation whose response was dropped,
        // safely re-rotate the session to a fresh token generation, invalidating the unacknowledged token.
        if (effectiveIdempotencyKey) {
          const idempotencyKeyHash = hashRefreshToken(effectiveIdempotencyKey);
          const newRawRefreshToken = generateRawRefreshToken();
          const newRefreshTokenHash = hashRefreshToken(newRawRefreshToken);

          const recoveredSession = await authRepo.recoverLostSessionResponse(
            session.sessionId,
            providedTokenHash,
            idempotencyKeyHash,
            newRefreshTokenHash
          );

          if (recoveredSession) {
            const userProfile = await authRepo.getUserProfile(recoveredSession.userId);
            const cred = await authRepo.getCredentialByUserId(recoveredSession.userId);

            const accessToken = generateAccessToken({
              sub: recoveredSession.userId,
              uid: recoveredSession.userId,
              email: cred?.email || '',
              sessionId: recoveredSession.sessionId,
              role: userProfile?.role || 'user',
            });

            return res.json({
              success: true,
              recovered: true,
              tokens: {
                accessToken,
                refreshToken: newRawRefreshToken,
                expiresIn: ACCESS_TOKEN_EXPIRATION_SECONDS,
                tokenType: 'Bearer',
              },
            });
          }
        }

        // Fail-Closed: If no matching idempotency key was supplied or recovery failed,
        // do NOT return active tokens to an untrusted requester possessing only a consumed token hash.
        return res.status(409).json({
          success: false,
          error: 'A token refresh operation is currently in progress or recently completed. If you did not receive new tokens, please retry with your matching idempotency key.',
          code: 'CONCURRENT_REFRESH',
          retryable: true,
          graceWindowActive: true,
        });
      }

      // Outside grace window: Confirmed replay attack!
      console.warn(
        `[AuthController] SECURITY ALERT: Refresh token reuse detected outside grace window (${elapsedMs}ms elapsed) for session ${session.sessionId}, user ${session.userId}! Revoking token family ${session.familyId}.`
      );
      await authRepo.revokeFamily(session.familyId, 'replay_attack_detected');
      return res.status(401).json({
        success: false,
        error: 'Refresh token reuse detected. Your session has been revoked for security. Please sign in again.',
        code: 'AUTH_REPLAY_ATTACK_DETECTED',
      });
    }

    // Case 2: Active current token presented
    if (isCurrent) {
      if (session.expiresAt <= Date.now()) {
        await authRepo.revokeSession(session.sessionId, 'expired');
        return res.status(401).json({
          success: false,
          error: 'Refresh token has expired. Please sign in again.',
          code: 'AUTH_TOKEN_EXPIRED',
        });
      }

      // Atomically rotate refresh token
      const newRawRefreshToken = generateRawRefreshToken();
      const newRefreshTokenHash = hashRefreshToken(newRawRefreshToken);
      const idempotencyKeyHash = effectiveIdempotencyKey ? hashRefreshToken(effectiveIdempotencyKey) : null;

      try {
        await authRepo.rotateSessionToken(
          session.sessionId,
          providedTokenHash,
          newRefreshTokenHash,
          idempotencyKeyHash
        );
      } catch (rotationErr: any) {
        if (rotationErr.code === 'CONCURRENT_ROTATION_CONFLICT') {
          return res.status(409).json({
            success: false,
            error: 'A token refresh operation is currently in progress. If you did not receive new tokens, please retry shortly with your matching idempotency key.',
            code: 'CONCURRENT_REFRESH',
            retryable: true,
            graceWindowActive: true,
          });
        }
        throw rotationErr;
      }

      const userProfile = await authRepo.getUserProfile(session.userId);
      const cred = await authRepo.getCredentialByUserId(session.userId);

      const accessToken = generateAccessToken({
        sub: session.userId,
        uid: session.userId,
        email: cred?.email || '',
        sessionId: session.sessionId,
        role: userProfile?.role || 'user',
      });

      return res.json({
        success: true,
        tokens: {
          accessToken,
          refreshToken: newRawRefreshToken,
          expiresIn: ACCESS_TOKEN_EXPIRATION_SECONDS,
          tokenType: 'Bearer',
        },
      });
    }


    return res.status(401).json({
      success: false,
      error: 'Invalid or unrecognized refresh token.',
      code: 'AUTH_TOKEN_INVALID',
    });
  } catch (err: any) {
    console.error('[AuthController] Token refresh error:', err);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred while refreshing authentication token.',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}


/**
 * POST /api/auth/logout
 */
export async function handleLogout(req: Request, res: Response) {
  try {
    const { refreshToken } = req.body || {};
    let revoked = false;

    if (refreshToken && typeof refreshToken === 'string') {
      const hash = hashRefreshToken(refreshToken);
      const session = await authRepo.findSessionByRefreshTokenHash(hash);
      if (session) {
        await authRepo.revokeSession(session.sessionId, 'logout');
        revoked = true;
      }
    }

    // Also check Bearer access token if provided
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      try {
        const claims = verifyAccessToken(token);
        if (claims.sessionId) {
          await authRepo.revokeSession(claims.sessionId, 'logout');
          revoked = true;
        }
      } catch {
        // Ignore token verification errors during logout
      }
    }

    return res.json({
      success: true,
      message: 'Logged out successfully',
      sessionRevoked: revoked,
    });
  } catch (err: any) {
    console.error('[AuthController] Logout error:', err);
    return res.status(500).json({
      success: false,
      error: 'An unexpected error occurred during logout.',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}

/**
 * Middleware: authenticateGamingHubToken
 * Optional middleware for routes that wish to authenticate via Gaming Hub JWT access tokens.
 * Validates the JWT signature and verifies that the session is still active and not revoked.
 */
export async function authenticateGamingHubToken(
  req: GamingHubAuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing or malformed Authorization header.',
      code: 'AUTH_HEADER_MISSING',
    });
  }

  const token = authHeader.substring(7).trim();
  try {
    const decoded = verifyAccessToken(token);

    // Verify session has not been revoked
    if (decoded.sessionId) {
      const session = await authRepo.getSessionById(decoded.sessionId);
      if (!session || session.isRevoked) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized: Session has been revoked or expired.',
          code: 'SESSION_REVOKED',
        });
      }
    }

    req.gamingHubUser = decoded;
    next();
  } catch (err: any) {
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      error: isExpired ? 'Unauthorized: Token has expired.' : 'Unauthorized: Invalid token.',
      code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }
}
