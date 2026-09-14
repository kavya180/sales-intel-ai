interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const isProduction = process.env.NODE_ENV === 'production';

// In-memory limiting is useful for local development/test runs only.
// It is NOT sufficient for production because multiple server instances can
// each maintain a different map.
const rateLimitMap = new Map<string, RateLimitEntry>();

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_LIMIT = 10_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeParameters(
  limit: number,
  windowMs: number
): { limit: number; windowMs: number } {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Rate-limit limit must be a positive number.');
  }

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('Rate-limit window must be a positive number.');
  }

  return {
    limit: Math.min(Math.floor(limit), MAX_LIMIT),
    windowMs: Math.min(Math.floor(windowMs), MAX_WINDOW_MS),
  };
}

function normalizeIdentifier(identifier: string): string {
  if (typeof identifier !== 'string') {
    throw new Error('Rate-limit identifier must be a string.');
  }

  const normalized = identifier.trim();

  if (!normalized) {
    throw new Error('Rate-limit identifier is required.');
  }

  return normalized.slice(0, MAX_IDENTIFIER_LENGTH);
}

// Clean up stale entries periodically in local/test environments.
// Avoid creating a persistent interval in production server processes.
if (!isProduction) {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [key, entry] of rateLimitMap.entries()) {
      if (now >= entry.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }, 5 * 60 * 1000);

  // Do not keep Node.js alive solely because of this housekeeping timer.
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

/**
 * Local/test rate limiter.
 *
 * IMPORTANT:
 * This implementation is process-local. It is intentionally disabled as an
 * authoritative production security boundary because it does not coordinate
 * across multiple application instances.
 *
 * Production API routes should use a distributed limiter (for example a
 * Redis/Upstash-backed implementation) or a database-backed atomic counter.
 */
export function checkRateLimit(
  identifier: string,
  limit = 20,
  windowMs = 60 * 1000
): { allowed: boolean; remaining: number; resetTime: number } {
  if (isProduction) {
    throw new Error(
      'Production must use a distributed rate limiter; the in-memory rate limiter is not safe across multiple instances.'
    );
  }

  const key = normalizeIdentifier(identifier);
  const params = normalizeParameters(limit, windowMs);
  const now = Date.now();

  const entry = rateLimitMap.get(key);

  if (!entry || now >= entry.resetTime) {
    const resetTime = now + params.windowMs;

    rateLimitMap.set(key, {
      count: 1,
      resetTime,
    });

    return {
      allowed: true,
      remaining: Math.max(0, params.limit - 1),
      resetTime,
    };
  }

  if (entry.count >= params.limit) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime,
    };
  }

  entry.count += 1;

  return {
    allowed: true,
    remaining: Math.max(0, params.limit - entry.count),
    resetTime: entry.resetTime,
  };
}

/**
 * Returns whether this process-local limiter can be used as the authoritative
 * limiter for the current environment.
 */
export function isDistributedRateLimitingRequired(): boolean {
  return isProduction;
}
