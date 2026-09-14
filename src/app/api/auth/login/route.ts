import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authenticateUserAsync } from '@/lib/auth';
import { checkRateLimit } from '@/lib/ratelimit';
import { createAuditLogAsync } from '@/lib/audit';
import { dbQuery, isPostgresConfigured } from '@/lib/db';

const isProduction = process.env.NODE_ENV === 'production';

const LoginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

const MAX_LOGIN_ATTEMPTS_PER_MINUTE = 15;
const MAX_EMAIL_ATTEMPTS_PER_MINUTE = 8;

function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');

  const candidate =
    forwarded?.split(',')[0]?.trim() ||
    realIp?.trim() ||
    'unknown';

  return candidate.slice(0, 128);
}

function hashValue(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 16);
}

async function enforceLoginRateLimit(
  req: Request,
  email?: string
): Promise<{ allowed: boolean; resetTime: number }> {
  const ip = getClientIp(req);

  if (!isProduction) {
    const rate = checkRateLimit(
      `auth_login_${ip}`,
      MAX_LOGIN_ATTEMPTS_PER_MINUTE,
      60 * 1000
    );

    return {
      allowed: rate.allowed,
      resetTime: rate.resetTime,
    };
  }

  if (!isPostgresConfigured) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production login rate limiting requires PostgreSQL.'
    );
  }

  const ipHash = hashValue(ip);

  const ipResult = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM audit_logs
      WHERE action = 'login_attempt'
        AND ip_hash = $1
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
    [ipHash]
  );

  const ipCount = Number.parseInt(ipResult?.rows?.[0]?.count || '0', 10);

  if (!Number.isFinite(ipCount)) {
    throw new Error('Unable to evaluate login rate limit.');
  }

  if (ipCount >= MAX_LOGIN_ATTEMPTS_PER_MINUTE) {
    return {
      allowed: false,
      resetTime: Date.now() + 60 * 1000,
    };
  }

  // A second limit protects a single account from distributed attempts across
  // many source IPs. The email itself is hashed and never stored as plaintext.
  if (email) {
    const emailHash = hashValue(email.trim().toLowerCase());

    const emailResult = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_logs
        WHERE action = 'login_attempt'
          AND details_json->>'email_hash' = $1
          AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
      [emailHash]
    );

    const emailCount = Number.parseInt(
      emailResult?.rows?.[0]?.count || '0',
      10
    );

    if (!Number.isFinite(emailCount)) {
      throw new Error('Unable to evaluate account login rate limit.');
    }

    if (emailCount >= MAX_EMAIL_ATTEMPTS_PER_MINUTE) {
      return {
        allowed: false,
        resetTime: Date.now() + 60 * 1000,
      };
    }
  }

  return {
    allowed: true,
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

function invalidCredentialsResponse() {
  return NextResponse.json(
    {
      error: 'Invalid email or password.',
      code: 'INVALID_CREDENTIALS',
    },
    { status: 401 }
  );
}

export async function POST(req: Request) {
  const clientIp = getClientIp(req);
  const ipHash = hashValue(clientIp);
  let emailHash: string | null = null;

  try {
    // Parse first so the account-specific rate-limit key is available, but do
    // not perform password hashing or database authentication until limits pass.
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        {
          error: 'Invalid request. Please provide a valid login payload.',
          code: 'INVALID_INPUT',
        },
        { status: 400 }
      );
    }

    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Valid email and password are required.',
          code: 'INVALID_INPUT',
        },
        { status: 400 }
      );
    }

    emailHash = hashValue(parsed.data.email);

    // 1. Durable production rate limiting.
    const rate = await enforceLoginRateLimit(req, parsed.data.email);

    if (!rate.allowed) {
      return NextResponse.json(
        {
          error: 'Too many login attempts. Please try again shortly.',
          code: 'RATE_LIMITED',
          resetTime: rate.resetTime,
        },
        { status: 429 }
      );
    }

    // 2. Record the attempt before authentication so both successful and
    // unsuccessful attempts consume the rate-limit budget.
    await createAuditLogAsync({
      action: 'login_attempt',
      resource: 'auth',
      details: {
        email_hash: emailHash,
      },
      ip: clientIp,
      userAgent: req.headers.get('user-agent'),
    });

    // 3. Authenticate against the server-side database.
    const { user, token } = await authenticateUserAsync(
      parsed.data.email,
      parsed.data.password
    );

    // 4. Never return the session JWT in JSON. Keep it HttpOnly.
    const response = NextResponse.json({
      success: true,
      user,
    });

    setSessionCookie(response, token);

    await createAuditLogAsync({
      userId: user.id,
      action: 'login_completed',
      resource: 'auth',
      details: {
        source: 'login_api',
      },
      ip: clientIp,
      userAgent: req.headers.get('user-agent'),
    });

    return response;
  } catch (err: unknown) {
    console.error('Login request failed:', err);

    const message =
      err instanceof Error ? err.message : 'Authentication failed.';

    if (message.startsWith('FATAL CONFIGURATION ERROR')) {
      return NextResponse.json(
        {
          error:
            'Login is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
        },
        { status: 503 }
      );
    }

    if (
      message.includes('PostgreSQL') ||
      message.toLowerCase().includes('database') ||
      message.includes('GEMINI_API_KEY')
    ) {
      return NextResponse.json(
        {
          error:
            'Login is temporarily unavailable. Please try again later.',
          code: 'SERVICE_UNAVAILABLE',
        },
        { status: 503 }
      );
    }

    // Do not reveal whether the email exists or whether a specific password
    // check failed. The auth service already uses the same message for both.
    return invalidCredentialsResponse();
  }
}
