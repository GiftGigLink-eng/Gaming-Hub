import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export class AuthRateLimiter {
  private ipLimits = new Map<string, RateLimitRecord>();
  private failedLoginAttempts = new Map<string, RateLimitRecord>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup every 2 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 2 * 60 * 1000);
    // Unref so process can cleanly exit if needed
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  public resetAll(): void {
    this.ipLimits.clear();
    this.failedLoginAttempts.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.ipLimits.entries()) {
      if (record.resetTime <= now) {
        this.ipLimits.delete(key);
      }
    }
    for (const [key, record] of this.failedLoginAttempts.entries()) {
      if (record.resetTime <= now) {
        this.failedLoginAttempts.delete(key);
      }
    }
  }

  /**
   * Checks if an action is permitted within a rate limit window
   */

  public checkLimit(
    key: string,
    maxRequests: number,
    windowMs: number
  ): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    let record = this.ipLimits.get(key);

    if (!record || record.resetTime <= now) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      this.ipLimits.set(key, record);
      return {
        allowed: true,
        remaining: maxRequests - 1,
        retryAfterSeconds: 0,
      };
    }

    if (record.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    record.count++;
    return {
      allowed: true,
      remaining: maxRequests - record.count,
      retryAfterSeconds: 0,
    };
  }

  public getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || req.ip || 'unknown-ip';
  }

  /**
   * Checks if login attempts for an (email, ip) composite key are permitted.
   * Scoped to (email, ip) to completely prevent account lockout DoS attacks across different IPs.
   */
  public checkFailedLoginAllowed(
    email: string,
    ip: string,
    maxAttempts = 5
  ): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const key = `failed_login:${email.trim().toLowerCase()}:${ip}`;
    const now = Date.now();
    const record = this.failedLoginAttempts.get(key);

    if (!record || record.resetTime <= now) {
      return { allowed: true, remaining: maxAttempts, retryAfterSeconds: 0 };
    }

    if (record.count >= maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return { allowed: true, remaining: maxAttempts - record.count, retryAfterSeconds: 0 };
  }

  /**
   * Records a failed login attempt against the (email, ip) pair.
   */
  public recordFailedLogin(
    email: string,
    ip: string,
    maxAttempts = 5,
    windowMs = 15 * 60 * 1000
  ): { allowed: boolean; retryAfterSeconds: number } {
    const key = `failed_login:${email.trim().toLowerCase()}:${ip}`;
    const now = Date.now();
    let record = this.failedLoginAttempts.get(key);

    if (!record || record.resetTime <= now) {
      record = {
        count: 1,
        resetTime: now + windowMs,
      };
      this.failedLoginAttempts.set(key, record);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    record.count++;
    if (record.count >= maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Resets failed login attempts for the (email, ip) pair after successful login.
   */
  public resetFailedLogin(email: string, ip: string): void {
    const key = `failed_login:${email.trim().toLowerCase()}:${ip}`;
    this.failedLoginAttempts.delete(key);
  }


  /**
   * Express middleware for Login route (max 10 attempts per 15 min per IP)
   */
  public loginRateLimitMiddleware(maxRequests = 10, windowMs = 15 * 60 * 1000) {
    return (req: Request, res: Response, next: NextFunction) => {
      const ip = this.getClientIp(req);
      const key = `login:${ip}`;
      const status = this.checkLimit(key, maxRequests, windowMs);

      if (!status.allowed) {
        res.setHeader('Retry-After', status.retryAfterSeconds.toString());
        return res.status(429).json({
          success: false,
          error: `Too many login attempts. Please wait ${status.retryAfterSeconds} seconds before trying again.`,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: status.retryAfterSeconds,
        });
      }

      next();
    };
  }

  /**
   * Express middleware for Registration route (max 5 per 15 min per IP)
   */
  public registerRateLimitMiddleware(maxRequests = 5, windowMs = 15 * 60 * 1000) {
    return (req: Request, res: Response, next: NextFunction) => {
      const ip = this.getClientIp(req);
      const key = `register:${ip}`;
      const status = this.checkLimit(key, maxRequests, windowMs);

      if (!status.allowed) {
        res.setHeader('Retry-After', status.retryAfterSeconds.toString());
        return res.status(429).json({
          success: false,
          error: `Too many registration attempts. Please wait ${status.retryAfterSeconds} seconds before trying again.`,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: status.retryAfterSeconds,
        });
      }

      next();
    };
  }

  /**
   * Express middleware for Refresh route (max 60 per 1 min per IP)
   */
  public refreshRateLimitMiddleware(maxRequests = 60, windowMs = 60 * 1000) {
    return (req: Request, res: Response, next: NextFunction) => {
      const ip = this.getClientIp(req);
      const key = `refresh:${ip}`;
      const status = this.checkLimit(key, maxRequests, windowMs);

      if (!status.allowed) {
        res.setHeader('Retry-After', status.retryAfterSeconds.toString());
        return res.status(429).json({
          success: false,
          error: `Too many token refresh requests. Please wait ${status.retryAfterSeconds} seconds.`,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: status.retryAfterSeconds,
        });
      }

      next();
    };
  }
}

export const authRateLimiter = new AuthRateLimiter();
