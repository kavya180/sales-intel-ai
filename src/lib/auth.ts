import jwt, { type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { cookies } from 'next/headers';
import {
  dbGetUserByEmail,
  dbGetUserById,
  dbCreateUser,
  dbUpsertEntitlement,
  memDb,
} from '@/lib/db';
import { addCredits } from '@/lib/credits';
import { createAuditLog } from '@/lib/audit';
import type { UserProfile, UserRole } from '@/types';

const isProduction = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'auth_session_token';
const JWT_ISSUER = 'sales-objection-assistant';
const JWT_AUDIENCE = 'sales-objection-users';
const JWT_EXPIRES_IN = '7d' as const;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (isProduction) {
    if (
      !secret ||
      secret.length < 32 ||
      secret.toLowerCase().includes('demo') ||
      secret.toLowerCase().includes('secret_key')
    ) {
      throw new Error(
        'FATAL CONFIGURATION ERROR: Production requires a secure JWT_SECRET of at least 32 characters.'
      );
    }
    return secret;
  }

  return secret || 'local-development-only-jwt-secret-change-me';
}

/**
 * Validate authentication configuration before signing/verifying tokens.
 */
export function validateAuthConfig(): void {
  getJwtSecret();
}

/**
 * JWT payload used for the authenticated session.
 *
 * The role is intentionally included for compatibility with existing callers,
 * but authorization must always use the role fetched from the database.
 */
export interface AuthSessionPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

/**
 * Strip password_hash and return the public user profile shape.
 */
function toPublicUser(user: UserProfile & { password_hash?: string }): UserProfile {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

/**
 * Validate credentials supplied by registration/login callers.
 */
function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();

  if (!normalized || normalized.length > 254) {
    throw new Error('Please provide a valid email address.');
  }

  // Deliberately simple validation: the database remains authoritative.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Please provide a valid email address.');
  }

  return normalized;
}

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  if (password.length > 128) {
    throw new Error('Password must not exceed 128 characters.');
  }
}

function validateFullName(fullName: string): string {
  const normalized = fullName.trim().replace(/\s+/g, ' ');

  if (!normalized) {
    throw new Error('Full name is required.');
  }

  if (normalized.length > 120) {
    throw new Error('Full name must not exceed 120 characters.');
  }

  return normalized;
}

/**
 * Sign a short, purpose-specific authentication JWT.
 */
export function signToken(payload: {
  userId: string;
  email: string;
  role: UserRole;
}): string {
  const secret = getJwtSecret();

  const options: SignOptions = {
    expiresIn: JWT_EXPIRES_IN,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
  };

  return jwt.sign(
    {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
    },
    secret,
    options
  );
}

/**
 * Verify a session JWT.
 *
 * The JWT role is never treated as authoritative for authorization; callers
 * fetch the current user from the database.
 */
export function verifyToken(token: string): AuthSessionPayload | null {
  if (!token || token.length > 4096) return null;

  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    if (!decoded || typeof decoded === 'string') return null;

    const payload = decoded as jwt.JwtPayload & {
      userId?: unknown;
      email?: unknown;
      role?: unknown;
    };

    if (
      typeof payload.userId !== 'string' ||
      !crypto.randomUUID // keeps crypto imported for compatibility and guards accidental tree-shaking changes
    ) {
      return null;
    }

    if (typeof payload.email !== 'string') return null;

    const role = payload.role;
    if (role !== 'user' && role !== 'admin') return null;

    return {
      userId: payload.userId,
      email: payload.email,
      role,
      iat: payload.iat,
      exp: payload.exp,
      iss: typeof payload.iss === 'string' ? payload.iss : undefined,
      aud: payload.aud,
    };
  } catch {
    return null;
  }
}

/**
 * Get the currently authenticated user.
 *
 * In production, authentication is database-backed and fail-closed.
 * A memory fallback is retained only for local/test compatibility.
 */
export async function getCurrentUser(): Promise<UserProfile | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  try {
    const user = await dbGetUserById(payload.userId);

    if (!user) return null;

    // Use the database's current role/email/profile data, not stale JWT claims.
    return toPublicUser(user);
  } catch (error) {
    if (isProduction) {
      console.error('Authentication database lookup failed:', error);
      return null;
    }

    const user = memDb.profiles.get(payload.userId);
    return user ? toPublicUser(user) : null;
  }
}

export async function requireUser(): Promise<UserProfile> {
  const user = await getCurrentUser();

  if (!user) {
    throw new Error('UNAUTHORIZED');
  }

  return user;
}

export async function requireAdmin(): Promise<UserProfile> {
  const user = await requireUser();

  // Database-backed role is authoritative.
  if (user.role !== 'admin') {
    await Promise.resolve(
      createAuditLog({
        userId: user.id,
        action: 'unauthorized_admin_access_attempt',
        resource: 'admin_panel',
        details: { email: user.email },
      })
    );

    throw new Error('FORBIDDEN_NOT_ADMIN');
  }

  return user;
}

/**
 * Create a user using the real persistence layer in production.
 *
 * Note: user creation, initial credit grant, and entitlement creation are
 * separate operations because the existing repository API does not expose a
 * single transaction encompassing all three. Each operation is idempotent
 * where applicable; a future repository transaction can make signup fully
 * atomic.
 */
export async function registerUserAsync(
  email: string,
  password: string,
  fullName: string
): Promise<{ user: UserProfile; token: string }> {
  validateAuthConfig();

  const normalizedEmail = normalizeEmail(email);
  validatePassword(password);
  const normalizedFullName = validateFullName(fullName);

  const existing = await dbGetUserByEmail(normalizedEmail);
  if (existing) {
    throw new Error('An account with this email address already exists.');
  }

  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();

  const user: UserProfile & { password_hash: string } = {
    id: userId,
    email: normalizedEmail,
    full_name: normalizedFullName,
    role: 'user',
    created_at: now,
    updated_at: now,
    password_hash: passwordHash,
  };

  const createdUser = await dbCreateUser(user);

  const configuredCredits = Number.parseInt(
    process.env.DEFAULT_FREE_CREDITS || '5',
    10
  );
  const initialFreeCredits =
    Number.isFinite(configuredCredits) && configuredCredits >= 0
      ? Math.min(configuredCredits, 1_000_000)
      : 5;

  if (initialFreeCredits > 0) {
    await addCredits({
      userId,
      amount: initialFreeCredits,
      type: 'initial_free_credit',
      reason: 'Welcome bonus: Always Free plan allocation',
      referenceId: 'plan_free',
      idempotencyKey: `init-free-${userId}`,
    });
  }

  await dbUpsertEntitlement({
    id: crypto.randomUUID(),
    user_id: userId,
    plan_id: 'free',
    type: 'free',
    valid_from: now,
    valid_until: null,
    is_active: true,
    source_reference: 'initial_signup',
    created_at: now,
  });

  await Promise.resolve(
    createAuditLog({
      userId,
      action: 'user_signup',
      resource: 'auth',
      details: {
        initialCredits: initialFreeCredits,
      },
    })
  );

  const token = signToken({
    userId,
    email: normalizedEmail,
    role: createdUser.role,
  });

  return {
    user: toPublicUser(createdUser),
    token,
  };
}

/**
 * Synchronous development/test compatibility version.
 *
 * This function intentionally remains memory-only. It must not be used by
 * production request handlers; production flows use registerUserAsync().
 */
export function registerUser(
  email: string,
  password: string,
  fullName: string
): { user: UserProfile; token: string } {
  if (isProduction) {
    throw new Error('Production must use registerUserAsync().');
  }

  const normalizedEmail = normalizeEmail(email);
  validatePassword(password);
  const normalizedFullName = validateFullName(fullName);

  for (const existing of memDb.profiles.values()) {
    if (existing.email.toLowerCase() === normalizedEmail) {
      throw new Error('An account with this email address already exists.');
    }
  }

  const userId = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 12);
  const now = new Date().toISOString();

  const user: UserProfile & { password_hash: string } = {
    id: userId,
    email: normalizedEmail,
    full_name: normalizedFullName,
    role: 'user',
    created_at: now,
    updated_at: now,
    password_hash: passwordHash,
  };

  memDb.profiles.set(userId, user);

  const configuredCredits = Number.parseInt(
    process.env.DEFAULT_FREE_CREDITS || '5',
    10
  );
  const initialFreeCredits =
    Number.isFinite(configuredCredits) && configuredCredits >= 0
      ? Math.min(configuredCredits, 1_000_000)
      : 5;

  const accountId = crypto.randomUUID();

  memDb.creditAccounts.set(userId, {
    id: accountId,
    user_id: userId,
    balance: initialFreeCredits,
    total_earned: initialFreeCredits,
    total_consumed: 0,
    version: 1,
    updated_at: now,
  });

  if (initialFreeCredits > 0) {
    memDb.creditTransactions.push({
      id: crypto.randomUUID(),
      account_id: accountId,
      user_id: userId,
      amount: initialFreeCredits,
      balance_before: 0,
      balance_after: initialFreeCredits,
      transaction_type: 'initial_free_credit',
      reason: 'Welcome bonus: Always Free plan allocation',
      reference_id: 'plan_free',
      idempotency_key: `init-free-${userId}`,
      created_at: now,
    });
  }

  memDb.entitlements.set(`ent-${userId}-free`, {
    id: crypto.randomUUID(),
    user_id: userId,
    plan_id: 'free',
    type: 'free',
    valid_from: now,
    valid_until: null,
    is_active: true,
    source_reference: 'initial_signup',
    created_at: now,
  });

  createAuditLog({
    userId,
    action: 'user_signup',
    resource: 'auth',
    details: {
      initialCredits: initialFreeCredits,
    },
  });

  const token = signToken({
    userId,
    email: normalizedEmail,
    role: 'user',
  });

  return {
    user: toPublicUser(user),
    token,
  };
}

export async function authenticateUserAsync(
  email: string,
  password: string
): Promise<{ user: UserProfile; token: string }> {
  validateAuthConfig();

  const normalizedEmail = normalizeEmail(email);
  validatePassword(password);

  const matchedUser = await dbGetUserByEmail(normalizedEmail);

  if (!matchedUser) {
    await Promise.resolve(
      createAuditLog({
        action: 'login_failed',
        resource: 'auth',
        details: { email: normalizedEmail },
      })
    );

    // Keep the same error for unknown-user and wrong-password cases.
    throw new Error('Invalid email or password.');
  }

  const isValidPassword = await bcrypt.compare(
    password,
    matchedUser.password_hash
  );

  if (!isValidPassword) {
    await Promise.resolve(
      createAuditLog({
        userId: matchedUser.id,
        action: 'login_failed',
        resource: 'auth',
        details: { email: normalizedEmail },
      })
    );

    throw new Error('Invalid email or password.');
  }

  await Promise.resolve(
    createAuditLog({
      userId: matchedUser.id,
      action: 'user_login_success',
      resource: 'auth',
      details: {
        role: matchedUser.role,
      },
    })
  );

  const token = signToken({
    userId: matchedUser.id,
    email: matchedUser.email,
    role: matchedUser.role,
  });

  return {
    user: toPublicUser(matchedUser),
    token,
  };
}

/**
 * Synchronous development/test compatibility version.
 *
 * Production request handlers must use authenticateUserAsync().
 */
export function authenticateUser(
  email: string,
  password: string
): { user: UserProfile; token: string } {
  if (isProduction) {
    throw new Error('Production must use authenticateUserAsync().');
  }

  const normalizedEmail = normalizeEmail(email);
  validatePassword(password);

  let matchedUser: (UserProfile & { password_hash: string }) | null = null;

  for (const user of memDb.profiles.values()) {
    if (user.email.toLowerCase() === normalizedEmail) {
      matchedUser = user;
      break;
    }
  }

  if (!matchedUser) {
    createAuditLog({
      action: 'login_failed',
      resource: 'auth',
      details: { email: normalizedEmail },
    });

    throw new Error('Invalid email or password.');
  }

  const isValidPassword = bcrypt.compareSync(password, matchedUser.password_hash);

  if (!isValidPassword) {
    createAuditLog({
      userId: matchedUser.id,
      action: 'login_failed',
      resource: 'auth',
      details: { email: normalizedEmail },
    });

    throw new Error('Invalid email or password.');
  }

  createAuditLog({
    userId: matchedUser.id,
    action: 'user_login_success',
    resource: 'auth',
    details: { role: matchedUser.role },
  });

  const token = signToken({
    userId: matchedUser.id,
    email: matchedUser.email,
    role: matchedUser.role,
  });

  return {
    user: toPublicUser(matchedUser),
    token,
  };
}
