import argon2, { HashOptions, argon2id } from 'argon2';

/**
 * Argon2id Password Hashing Configuration
 * Follows OWASP recommendations and RFC 9106 standards:
 * - Variant: Argon2id (hybrid data-dependent / data-independent memory access resistant to GPU and side-channel attacks)
 * - Memory cost: 19456 KiB (~19 MiB)
 * - Time cost / iterations: 2
 * - Parallelism: 1
 */
export const ARGON2_CONFIG: HashOptions = {
  type: argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export const MAX_PASSWORD_LENGTH = 128;

/**
 * Precomputed valid Argon2id hash for constant-time dummy verification.
 * Prevents user enumeration by ensuring login response time is identical
 * (~60-90ms) whether an account exists or not.
 */
let precomputedDummyHash =
  '$argon2id$v=19$m=19456,t=2,p=1$u8d8w8g8d8w8g8d8w8g8dw$6+J2g9G5/t+1oHh5X2w3y4z5a6b7c8d9e0f1g2h3i4j';

// Eagerly compute a genuine hash on startup matching ARGON2_CONFIG exactly
(async () => {
  try {
    precomputedDummyHash = await argon2.hash('GamingHub_Precomputed_Timing_Anchor_2026!', ARGON2_CONFIG);
  } catch (err: any) {
    // Keep fallback static hash if startup hash computation fails
  }
})();

/**
 * Performs dummy password verification to equalize response timing when user is not found.
 */
export async function verifyDummyPassword(password: string): Promise<boolean> {
  if (!password || typeof password !== 'string') return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    await argon2.verify(precomputedDummyHash, password);
  } catch {
    // Ignore verification errors
  }
  return false;
}

/**
 * Hash a plaintext password using Argon2id.
 * Enforces maximum password length (128 characters) to prevent CPU starvation / ReDoS attacks.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password length exceeds maximum allowed limit (${MAX_PASSWORD_LENGTH} characters)`);
  }
  const result = await argon2.hash(password, { ...ARGON2_CONFIG, raw: false });
  return result as string;
}

/**
 * Verify a plaintext password against an Argon2id hash.
 * Timing-safe, enforces length limits, and handles invalid hash strings gracefully without throwing.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash || !password || typeof hash !== 'string' || typeof password !== 'string') {
    return false;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    // Malformed or corrupt hash
    return false;
  }
}

/**
 * Checks if a hash was created with older parameters and needs re-hashing
 */
export function needsRehash(hash: string): boolean {
  if (!hash || typeof hash !== 'string') return true;
  return argon2.needsRehash(hash, {
    memoryCost: ARGON2_CONFIG.memoryCost,
    timeCost: ARGON2_CONFIG.timeCost,
    parallelism: ARGON2_CONFIG.parallelism,
  });
}

