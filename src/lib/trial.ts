import crypto from 'crypto';

import {
  dbGetTrialByUserId,
  dbCreateTrial,
  dbUpdateTrialStatus,
  dbUpsertEntitlement,
  dbGetUserById,
  dbGetPlanById,
  isPostgresConfigured,
  memDb,
} from '@/lib/db';
import { addCredits } from '@/lib/credits';
import { createAuditLogAsync } from '@/lib/audit';
import type { TrialRecord, Entitlement } from '@/types';

const isProduction = process.env.NODE_ENV === 'production';

const DEFAULT_TRIAL_DAYS = 30;
const DEFAULT_TRIAL_CREDITS = 25;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function requireProductionDatabase(): void {
  if (isProduction && !isPostgresConfigured) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production trial service requires PostgreSQL.'
    );
  }
}

function getPositiveIntegerEnv(
  name: string,
  fallback: number,
  max: number
): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function calculateTrialValues(plan: {
  duration_days?: number | null;
  credits?: number | null;
} | null): {
  trialDays: number;
  trialCredits: number;
} {
  const configuredDays =
    typeof plan?.duration_days === 'number'
      ? plan.duration_days
      : getPositiveIntegerEnv(
          'DEFAULT_TRIAL_DAYS',
          DEFAULT_TRIAL_DAYS,
          365
        );

  const configuredCredits =
    typeof plan?.credits === 'number'
      ? plan.credits
      : getPositiveIntegerEnv(
          'DEFAULT_TRIAL_CREDITS',
          DEFAULT_TRIAL_CREDITS,
          1_000_000
        );

  const trialDays =
    Number.isFinite(configuredDays) && configuredDays > 0
      ? Math.min(Math.floor(configuredDays), 365)
      : DEFAULT_TRIAL_DAYS;

  const trialCredits =
    Number.isFinite(configuredCredits) && configuredCredits >= 0
      ? Math.min(Math.floor(configuredCredits), 1_000_000)
      : DEFAULT_TRIAL_CREDITS;

  return { trialDays, trialCredits };
}

function buildStatus(
  trial: TrialRecord | null,
  serverNow = new Date()
): {
  hasTrial: boolean;
  isActive: boolean;
  isExpired: boolean;
  record: TrialRecord | null;
  serverUtcTime: string;
  expiresAt: string | null;
  daysRemaining: number;
} {
  const serverUtcTime = serverNow.toISOString();

  if (!trial) {
    return {
      hasTrial: false,
      isActive: false,
      isExpired: false,
      record: null,
      serverUtcTime,
      expiresAt: null,
      daysRemaining: 0,
    };
  }

  const expiresTime = new Date(trial.expires_at).getTime();

  // Treat malformed persisted timestamps as expired rather than accidentally
  // granting access indefinitely.
  if (!Number.isFinite(expiresTime)) {
    return {
      hasTrial: true,
      isActive: false,
      isExpired: true,
      record: { ...trial, status: 'expired' },
      serverUtcTime,
      expiresAt: trial.expires_at,
      daysRemaining: 0,
    };
  }

  const currentTime = serverNow.getTime();
  const isExpired =
    currentTime >= expiresTime || trial.status === 'expired';

  const diffMs = Math.max(0, expiresTime - currentTime);
  const daysRemaining = Math.ceil(diffMs / MS_PER_DAY);

  return {
    hasTrial: true,
    isActive: !isExpired && trial.status === 'active',
    isExpired,
    record: { ...trial },
    serverUtcTime,
    expiresAt: trial.expires_at,
    daysRemaining: isExpired ? 0 : daysRemaining,
  };
}

/**
 * Returns the authoritative trial state.
 *
 * Trial expiry is evaluated using server time only. In production, PostgreSQL
 * is mandatory; the in-memory adapter is never used as an authorization
 * fallback.
 */
export async function getTrialStatus(userId: string): Promise<{
  hasTrial: boolean;
  isActive: boolean;
  isExpired: boolean;
  record: TrialRecord | null;
  serverUtcTime: string;
  expiresAt: string | null;
  daysRemaining: number;
}> {
  if (!userId?.trim()) {
    throw new Error('Invalid user ID.');
  }

  requireProductionDatabase();

  const serverNow = new Date();
  const trial = await dbGetTrialByUserId(userId);
  const status = buildStatus(trial, serverNow);

  if (status.isExpired && trial && trial.status === 'active') {
    try {
      await dbUpdateTrialStatus(userId, 'expired');
    } catch (error) {
      // Fail closed. Returning an expired status is safer than continuing to
      // grant access when the status update cannot be persisted.
      console.error('Failed to persist expired trial status:', error);

      if (isProduction) {
        return {
          ...status,
          isActive: false,
          isExpired: true,
          record: { ...trial, status: 'expired' },
        };
      }
    }

    if (status.record) {
      status.record.status = 'expired';
    }

    // Memory is updated only in local/test mode for compatibility.
    if (!isProduction) {
      const entitlement = memDb.entitlements.get(`ent-${userId}-trial`);
      if (entitlement) {
        entitlement.is_active = false;
      }
    }
  }

  return status;
}

/**
 * Synchronous compatibility helper.
 *
 * Production must use getTrialStatus(), which reads PostgreSQL.
 */
export function getTrialStatusSync(userId: string): {
  hasTrial: boolean;
  isActive: boolean;
  isExpired: boolean;
  record: TrialRecord | null;
  serverUtcTime: string;
  expiresAt: string | null;
  daysRemaining: number;
} {
  if (isProduction) {
    throw new Error('Production must use getTrialStatus().');
  }

  if (!userId?.trim()) {
    throw new Error('Invalid user ID.');
  }

  const trial = memDb.trials.get(userId) || null;
  const status = buildStatus(trial);

  if (status.isExpired && trial && trial.status === 'active') {
    trial.status = 'expired';

    const entitlement = memDb.entitlements.get(`ent-${userId}-trial`);
    if (entitlement) {
      entitlement.is_active = false;
    }

    if (status.record) {
      status.record.status = 'expired';
    }
  }

  return status;
}

/**
 * Activates the one-time 30-day free trial.
 *
 * Production uses the database as the source of truth. The unique
 * user_id constraint on the trials table is required to prevent concurrent
 * requests from activating two trials for the same account.
 */
const memoryTrialLocks = new Map<string, Promise<void>>();

async function withMemoryTrialLock<T>(
  userId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = memoryTrialLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  memoryTrialLocks.set(userId, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (memoryTrialLocks.get(userId) === current) {
      memoryTrialLocks.delete(userId);
    }
  }
}

async function startFreeTrialInternal(userId: string): Promise<TrialRecord> {
  if (!userId?.trim()) {
    throw new Error('Invalid user ID.');
  }

  requireProductionDatabase();

  const user = await dbGetUserById(userId);

  if (!user) {
    throw new Error('User does not exist.');
  }

  // Check the authoritative database first. A previous trial must remain
  // consumed even after it expires.
  const existingTrial = await dbGetTrialByUserId(userId);

  if (existingTrial) {
    await createAuditLogAsync({
      userId,
      action: 'trial_activation_rejected_already_used',
      resource: 'trial_system',
      details: {
        trialId: existingTrial.id,
        status: existingTrial.status,
      },
    });

    throw new Error(
      'You have already redeemed your 1-Month Free Trial. Only one trial is allowed per account.'
    );
  }

  // In local/test mode, retain compatibility with the memory adapter.
  if (!isProduction && memDb.trials.has(userId)) {
    await createAuditLogAsync({
      userId,
      action: 'trial_activation_rejected_already_used',
      resource: 'trial_system',
      details: { source: 'memory_adapter' },
    });

    throw new Error(
      'You have already redeemed your 1-Month Free Trial. Only one trial is allowed per account.'
    );
  }

  // Do not read plan configuration from memDb in production.
  const plan = await dbGetPlanById('trial_30d');
  const { trialDays, trialCredits } = calculateTrialValues(plan);

  const now = new Date();
  const startedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + trialDays * MS_PER_DAY
  ).toISOString();

  const trialRecord: TrialRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    plan_id: 'trial_30d',
    status: 'active',
    started_at: startedAt,
    expires_at: expiresAt,
    created_at: startedAt,
  };

  try {
    /*
     * The database's unique constraint on trials.user_id is the concurrency
     * boundary. If two requests race, only one INSERT can succeed.
     */
    await dbCreateTrial(trialRecord);
  } catch (error) {
    // Normalize the most common race/duplicate outcome without hiding other
    // database failures.
    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (
      message.includes('duplicate') ||
      message.includes('unique') ||
      message.includes('uq_trials_user_id')
    ) {
      throw new Error(
        'You have already redeemed your 1-Month Free Trial. Only one trial is allowed per account.'
      );
    }

    throw error;
  }

  try {
    const entitlement: Entitlement = {
      id: crypto.randomUUID(),
      user_id: userId,
      plan_id: 'trial_30d',
      type: 'trial',
      valid_from: startedAt,
      valid_until: expiresAt,
      is_active: true,
      source_reference: trialRecord.id,
      created_at: startedAt,
    };

    await dbUpsertEntitlement(entitlement);

    if (trialCredits > 0) {
      await addCredits({
        userId,
        amount: trialCredits,
        type: 'trial_credit',
        reason: `Free 1-Month Trial (${trialDays} days) activation`,
        referenceId: trialRecord.id,
        idempotencyKey: `trial-grant-${userId}`,
      });
    }

    await createAuditLogAsync({
      userId,
      action: 'trial_activated_successfully',
      resource: 'trial_system',
      details: {
        trialId: trialRecord.id,
        expiresAt,
        trialCredits,
        trialDays,
      },
    });

    return trialRecord;
  } catch (error) {
    /*
     * The current repository API does not expose a transaction that combines
     * trial + entitlement + credit grant. Do not delete/retry the trial here:
     * the trial must remain single-use. Credits are idempotent, so a retried
     * provisioning operation can safely complete the remaining work.
     */
    console.error('Trial provisioning failed after trial creation:', error);

    throw new Error(
      'Trial activation could not be completed. Please try again or contact support.'
    );
  }
}


export async function startFreeTrial(userId: string): Promise<TrialRecord> {
  if (!userId?.trim()) {
    throw new Error('Invalid user ID.');
  }

  if (!isProduction) {
    return withMemoryTrialLock(userId, () => startFreeTrialInternal(userId));
  }

  return startFreeTrialInternal(userId);
}
