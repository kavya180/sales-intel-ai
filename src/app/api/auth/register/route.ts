import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { registerUserAsync } from '@/lib/auth';
import { checkRateLimit } from '@/lib/ratelimit';
import {
  dbQuery,
  isPostgresConfigured,
} from '@/lib/db';
import { createAuditLogAsync } from '@/lib/audit';

const isProduction = process.env.NODE_ENV === 'production';

const RegisterSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
    fullName: z.string().trim().min(2).max(120),
  })
  .strict();

const MAX_REGISTRATIONS_PER_MINUTE = 10;

function getClientIp(req: Request): string {
  /*
   * x-forwarded-for is only trustworthy when the application is behind a
   * trusted reverse proxy. For this deployment model, use the first forwarded
   * address and cap its size so it cannot become an unbounded rate-limit key.
   */
  const forwarded = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');

  const candidate =
    forwarded?.split(',')[0]?.trim() ||
    realIp?.trim() ||
    'unknown';

  return candidate.slice(0, 128);
}

function hashIp(ip: string): string {
  return crypto
    .createHash('sha256')
    .update(ip)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Registration-specific distributed rate limiting.
 *
 * The old checkRateLimit() uses process-local memory and therefore cannot be
 * the production security boundary. In production we count recent registration
 * attempts in PostgreSQL using the hashed client IP stored in audit_logs.
 *
 * This remains intentionally conservative: the route records the attempt
 * before attempting account creation, so failed registrations are also
 * limited.
 */
async function enforceRegistrationRateLimit(
  req: Request
): Promise<{ allowed: boolean; resetTime: number }> {
  const ip = getClientIp(req);

  if (!isProduction) {
    const rate = checkRateLimit(
      `auth_reg_${ip}`,
      MAX_REGISTRATIONS_PER_MINUTE,
      60 * 1000
    );

    return {
      allowed: rate.allowed,
      resetTime: rate.resetTime,
    };
  }

  if (!isPostgresConfigured) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production registration rate limiting requires PostgreSQL.'
    );
  }

  const ipHash = hashIp(ip);

  const result = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM audit_logs
      WHERE action = 'registration_attempt'
        AND ip_hash = $1
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
    [ipHash]
  );

  const count = Number.parseInt(result?.rows?.[0]?.count || '0', 10);

  if (!Number.isFinite(count)) {
    throw new Error('Unable to evaluate registration rate limit.');
  }

  return {
    allowed: count < MAX_REGISTRATIONS_PER_MINUTE,
    resetTime: Date.now() + 60 * 1000,
  };
}

function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: 'auth_session_token',
    value: token,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
}

export async function POST(req: Request) {
  const clientIp = getClientIp(req);
  const ipHash = hashIp(clientIp);

  try {
    // 1. Apply registration rate limiting before expensive password hashing.
    const rate = await enforceRegistrationRateLimit(req);

    if (!rate.allowed) {
      return NextResponse.json(
        {
          error:
            'Too many registration requests. Please try again shortly.',
          code: 'RATE_LIMITED',
          resetTime: rate.resetTime,
        },
        { status: 429 }
      );
    }

    // Record every registration attempt in production so failed attempts
    // participate in the durable rate limit.
    await createAuditLogAsync({
      action: 'registration_attempt',
      resource: 'auth',
      details: {
        source: 'register_api',
      },
      ip: clientIp,
      userAgent: req.headers.get('user-agent'),
    });

    // 2. Parse JSON safely.
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        {
          error:
            'Invalid request. Please provide a valid registration payload.',
          code: 'INVALID_INPUT',
        },
        { status: 400 }
      );
    }

    // 3. Validate all user-controlled fields server-side.
    const parsed = RegisterSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            'Invalid input. Please provide a valid email, a password of at least 8 characters, and a valid name.',
          code: 'INVALID_INPUT',
        },
        { status: 400 }
      );
    }

    // 4. Account creation, password hashing, initial credits and initial
    // entitlement are performed by the server-side auth service.
    const { user, token } = await registerUserAsync(
      parsed.data.email,
      parsed.data.password,
      parsed.data.fullName
    );

    const response = NextResponse.json(
      {
        success: true,
        user,
      },
      { status: 201 }
    );

    // 5. Session token is never returned in the JSON response. It is stored
    // exclusively in an HttpOnly cookie.
    setSessionCookie(response, token);

    await createAuditLogAsync({
      userId: user.id,
      action: 'registration_completed',
      resource: 'auth',
      details: {
        source: 'register_api',
      },
      ip: clientIp,
      userAgent: req.headers.get('user-agent'),
    });

    return response;
  } catch (err: unknown) {
    console.error('Registration request failed:', err);

    const message =
      err instanceof Error ? err.message : 'Registration failed.';

    if (message.startsWith('FATAL CONFIGURATION ERROR')) {
      return NextResponse.json(
        {
          error:
            'Registration is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
        },
        { status: 503 }
      );
    }

    /*
     * Do not expose whether an email is already registered. This avoids
     * turning the registration endpoint into an account-enumeration oracle.
     */
    if (
      message.toLowerCase().includes('already exists') ||
      message.toLowerCase().includes('already redeemed')
    ) {
      return NextResponse.json(
        {
          error:
            'Unable to create an account with the provided details. If you already have an account, please sign in.',
          code: 'REGISTRATION_FAILED',
        },
        { status: 400 }
      );
    }

    if (
      message.includes('database') ||
      message.includes('PostgreSQL') ||
      message.includes('GEMINI_API_KEY')
    ) {
      return NextResponse.json(
        {
          error:
            'Registration is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        error:
          'Unable to create your account. Please check your details and try again.',
        code: 'REGISTRATION_FAILED',
      },
      { status: 400 }
    );
  }
}
