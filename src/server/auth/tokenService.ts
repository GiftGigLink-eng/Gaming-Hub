import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export interface GamingHubTokenPayload {
  sub: string; // User ID (immutable UID)
  uid: string;
  email: string;
  sessionId: string;
  role: 'user' | 'admin';
  type: 'access';
}

export interface AccessTokenClaims extends GamingHubTokenPayload {
  iat: number;
  exp: number;
}

export interface GeneratedTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // in seconds (e.g. 900)
  tokenType: 'Bearer';
}

export const ACCESS_TOKEN_EXPIRATION_SECONDS = 900; // 15 minutes
export const REFRESH_TOKEN_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const PRODUCTION_JWT_SECRET_HEX_LENGTH = 64; // 32 bytes represented as 64 hexadecimal characters
export const MIN_JWT_SECRET_LENGTH = 32; // Backward-compatible minimum byte size for HS256

const HEX_REGEX = /^[0-9a-fA-F]{64}$/;

const INSECURE_DEFAULTS = new Set([
  'secret',
  '123456',
  'password',
  'jwt_secret',
  'dev_secret',
  'test',
  'generate_using_crypto_randombytes_32_hex',
]);

/**
 * Computes Shannon entropy of an ASCII string: H = - sum(p * log2(p))
 * For uniformly distributed 16 hexadecimal symbols, theoretical maximum entropy is log2(16) = 4.0.
 * A truly random 32-byte (64 hex char) secret typically has entropy between 3.6 and 3.95 bits/symbol.
 */
export function computeShannonEntropy(str: string): number {
  if (!str) return 0;
  const counts = new Map<string, number>();
  for (const ch of str.toLowerCase()) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Detects obvious repeating block patterns (e.g. repeated blocks of size 1 to 16 characters).
 */
export function hasRepeatingPattern(str: string): boolean {
  const lower = str.toLowerCase();
  for (let blockSize = 1; blockSize <= 16; blockSize++) {
    if (lower.length % blockSize === 0) {
      const block = lower.slice(0, blockSize);
      if (block.repeat(lower.length / blockSize) === lower) {
        return true;
      }
    }
  }
  return false;
}

// Ephemeral in-memory fallback secret strictly for non-production environments
let ephemeralDevSecret: string | null = null;
function getEphemeralDevSecret(): string {
  if (!ephemeralDevSecret) {
    ephemeralDevSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralDevSecret;
}

/**
 * Validates the JWT secret configuration eagerly on system boot.
 * 
 * Strict Production Requirements:
 * 1. Must be explicitly defined (rejects missing or empty values).
 * 2. Must be exactly 64 hexadecimal characters representing 32 cryptographically random bytes.
 * 3. Rejects invalid hexadecimal encoding.
 * 4. Rejects known placeholders.
 * 5. Rejects predictable or repeated patterns (e.g., repeated characters, repeating blocks, low character diversity / low entropy).
 * 
 * Note: While validation strictly enforces correct 256-bit hexadecimal representation and rejects
 * structured/predictable patterns, mathematical true randomness cannot be proven from a static string alone.
 * Secure generation using a CSPRNG (e.g. `crypto.randomBytes(32).toString('hex')`) remains an operational requirement.
 */
export function validateJwtSecretOnStartup(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const secret = process.env.GAMING_HUB_JWT_SECRET;

  if (isProd) {
    if (!secret || secret.trim().length === 0) {
      throw new Error('[TokenService] FATAL: GAMING_HUB_JWT_SECRET must be explicitly defined in production environment!');
    }

    const trimmed = secret.trim();

    if (INSECURE_DEFAULTS.has(trimmed.toLowerCase())) {
      throw new Error('[TokenService] FATAL: GAMING_HUB_JWT_SECRET is configured to a known insecure placeholder.');
    }

    if (trimmed.length !== PRODUCTION_JWT_SECRET_HEX_LENGTH) {
      throw new Error(
        `[TokenService] FATAL: GAMING_HUB_JWT_SECRET must be exactly 64 hexadecimal characters (32 bytes). Received ${trimmed.length} characters.`
      );
    }

    if (!HEX_REGEX.test(trimmed)) {
      throw new Error('[TokenService] FATAL: GAMING_HUB_JWT_SECRET contains invalid hexadecimal characters.');
    }

    // Check for obvious repeated patterns (e.g., 'a'.repeat(64) or '0123456789abcdef'.repeat(4))
    if (hasRepeatingPattern(trimmed)) {
      throw new Error('[TokenService] FATAL: GAMING_HUB_JWT_SECRET contains an insecure repeating character pattern.');
    }

    // Check minimum character diversity: random 64-hex string has >= 10 distinct hex digits
    const uniqueChars = new Set(trimmed.toLowerCase()).size;
    if (uniqueChars < 8) {
      throw new Error(
        `[TokenService] FATAL: GAMING_HUB_JWT_SECRET has insufficient character diversity (${uniqueChars} unique hex characters).`
      );
    }

    // Check Shannon entropy: threshold 3.0 bits/symbol (uniform random 64-hex is ~3.8)
    const entropy = computeShannonEntropy(trimmed);
    if (entropy < 3.0) {
      throw new Error(
        `[TokenService] FATAL: GAMING_HUB_JWT_SECRET has insufficient entropy (${entropy.toFixed(2)} bits/symbol).`
      );
    }
  } else {
    if (secret) {
      const trimmed = secret.trim();
      if (INSECURE_DEFAULTS.has(trimmed.toLowerCase())) {
        console.warn('[TokenService] WARNING: GAMING_HUB_JWT_SECRET is set to a placeholder.');
      }
      if (trimmed.length < 32) {
        console.warn(`[TokenService] WARNING: GAMING_HUB_JWT_SECRET is shorter than recommended 64 hex characters (${trimmed.length} chars).`);
      }
    }
  }
}

/**
 * Resolves the JWT signing secret securely.
 * Never logs or prints the secret.
 */
export function getJwtSecret(): string {
  const secret = process.env.GAMING_HUB_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[TokenService] FATAL: GAMING_HUB_JWT_SECRET must be explicitly defined in production environment!');
    }
    return getEphemeralDevSecret();
  }
  if (process.env.NODE_ENV === 'production') {
    const trimmed = secret.trim();
    if (trimmed.length !== PRODUCTION_JWT_SECRET_HEX_LENGTH || !HEX_REGEX.test(trimmed)) {
      throw new Error('[TokenService] FATAL: GAMING_HUB_JWT_SECRET must be exactly 64 hexadecimal characters in production.');
    }
  }
  return secret.trim();
}




/**
 * Generates a short-lived signed JWT access token (15 minutes)
 */
export function generateAccessToken(
  payload: Omit<GamingHubTokenPayload, 'type'>,
  customSecret?: string,
  expiresInSeconds: number = ACCESS_TOKEN_EXPIRATION_SECONDS
): string {
  const secret = customSecret || getJwtSecret();
  const tokenPayload: GamingHubTokenPayload = {
    ...payload,
    type: 'access',
  };

  return jwt.sign(tokenPayload, secret, {
    expiresIn: expiresInSeconds,
    algorithm: 'HS256',
  });
}

/**
 * Verifies a Gaming Hub JWT access token.
 * Throws specific errors if expired or invalid.
 */
export function verifyAccessToken(token: string, customSecret?: string): AccessTokenClaims {
  if (!token || typeof token !== 'string') {
    throw new Error('Token must be a non-empty string');
  }
  const secret = customSecret || getJwtSecret();
  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
  }) as AccessTokenClaims;

  if (decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }

  return decoded;
}

/**
 * Generates a cryptographically strong random refresh token (40 bytes / 80 hex chars = 320 bits entropy)
 */
export function generateRawRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

/**
 * Securely hashes an opaque refresh token using SHA-256 before database storage.
 * Prevents token database leaks from allowing session hijacking.
 */
export function hashRefreshToken(rawToken: string): string {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('Raw refresh token must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Creates a unique session identifier
 */
export function generateSessionId(): string {
  return `sess_${crypto.randomUUID()}`;
}

/**
 * Creates a unique token family identifier for rotation tracking
 */
export function generateFamilyId(): string {
  return `fam_${crypto.randomUUID()}`;
}
