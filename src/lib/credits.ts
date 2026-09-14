import crypto from 'crypto';
import { memDb, pgPool, dbQuery } from '@/lib/db';
import { createAuditLog } from '@/lib/audit';
import type { CreditAccount, CreditTransaction, TransactionType } from '@/types';

const isProduction = process.env.NODE_ENV === 'production';

// Development/test-only in-process serialization. It is NEVER used for production
// correctness; production deductions/grants must go through PostgreSQL functions.
const accountLocks = new Map<string, Promise<void>>();

async function acquireLock(userId: string): Promise<() => void> {
  while (accountLocks.has(userId)) {
    await accountLocks.get(userId);
  }

  let release: () => void = () => {};
  const lockPromise = new Promise<void>((resolve) => {
    release = () => {
      accountLocks.delete(userId);
      resolve();
    };
  });

  accountLocks.set(userId, lockPromise);
  return release;
}

function requireProductionPostgres(): void {
  if (isProduction && !pgPool) {
    throw new Error(
      'CRITICAL: PostgreSQL is required for credit operations in production.'
    );
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    return 50;
  }
  return Math.min(limit, 500);
}

function validateAmount(amount: number): void {
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      'Transaction amount must be a positive, finite number strictly greater than 0.'
    );
  }

  if (!Number.isInteger(amount)) {
    throw new Error('Transaction amount must be an integer number of credits.');
  }

  if (amount > 1_000_000) {
    throw new Error(
      'Amount exceeds maximum allowable single transaction limit (1,000,000).'
    );
  }
}

function validateUserId(userId: string): void {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('A valid user ID is required.');
  }
}

function validateReason(reason: string): void {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('A transaction reason is required.');
  }

  if (reason.length > 500) {
    throw new Error('Transaction reason is too long.');
  }
}

function validateIdempotencyKey(key?: string): void {
  if (key !== undefined && (typeof key !== 'string' || key.length > 255)) {
    throw new Error('Invalid idempotency key.');
  }
}

export async function getCreditAccount(userId: string): Promise<CreditAccount> {
  validateUserId(userId);

  if (pgPool) {
    const res = await dbQuery<{
      id: string;
      user_id: string;
      balance: number;
      total_earned: number;
      total_consumed: number;
      version: number;
      updated_at: string;
    }>(
      `SELECT id, user_id, balance, total_earned, total_consumed, version, updated_at
       FROM credit_accounts
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (res && res.rows.length > 0) {
      const r = res.rows[0];
      return {
        id: r.id,
        user_id: r.user_id,
        balance: Number(r.balance),
        total_earned: Number(r.total_earned),
        total_consumed: Number(r.total_consumed),
        version: Number(r.version),
        updated_at: r.updated_at,
      };
    }

    // A production account should exist if the application is correctly
    // provisioned. Do not silently create it here.
    throw new Error('Credit account not found.');
  }

  requireProductionPostgres();

  let account = memDb.creditAccounts.get(userId);
  if (!account) {
    account = {
      id: crypto.randomUUID(),
      user_id: userId,
      balance: 0,
      total_earned: 0,
      total_consumed: 0,
      version: 1,
      updated_at: new Date().toISOString(),
    };
    memDb.creditAccounts.set(userId, account);
  }

  return { ...account };
}

export async function getTransactions(
  userId: string,
  limit = 50
): Promise<CreditTransaction[]> {
  validateUserId(userId);
  const safeLimit = normalizeLimit(limit);

  if (pgPool) {
    const res = await dbQuery<CreditTransaction>(
      `SELECT id, account_id, user_id, amount, balance_before, balance_after,
              transaction_type, reason, reference_id, idempotency_key, created_at
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    );

    if (res) {
      return res.rows.map((r) => ({
        ...r,
        amount: Number(r.amount),
        balance_before: Number(r.balance_before),
        balance_after: Number(r.balance_after),
      }));
    }

    return [];
  }

  requireProductionPostgres();

  return memDb.creditTransactions
    .filter((tx) => tx.user_id === userId)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() -
        new Date(a.created_at).getTime()
    )
    .slice(0, safeLimit);
}

/**
 * Atomically deducts credits.
 *
 * Production correctness depends on the PostgreSQL atomic_deduct_credits()
 * function, which must perform the balance check, row lock, transaction insert,
 * and balance update in one database transaction.
 */
export async function deductCredits(params: {
  userId: string;
  amount: number;
  reason: string;
  referenceId?: string;
  idempotencyKey?: string;
}): Promise<{
  success: boolean;
  balance: number;
  transaction: CreditTransaction;
}> {
  validateUserId(params.userId);
  validateAmount(params.amount);
  validateReason(params.reason);
  validateIdempotencyKey(params.idempotencyKey);

  if (pgPool) {
    const result = await dbQuery<{
      success: boolean;
      balance: number;
      transaction_id: string;
      error_message: string | null;
      balance_before?: number;
      created_at?: string;
    }>(
      `SELECT * FROM atomic_deduct_credits($1, $2, $3, $4, $5)`,
      [
        params.userId,
        params.amount,
        params.reason,
        params.referenceId || null,
        params.idempotencyKey || null,
      ]
    );

    if (!result || result.rows.length === 0) {
      throw new Error('Database deduction returned no result.');
    }

    const row = result.rows[0];

    if (!row.success) {
      throw new Error(row.error_message || 'Database deduction failed.');
    }

    const balance = Number(row.balance);
    const transaction: CreditTransaction = {
      id: row.transaction_id,
      account_id: params.userId,
      user_id: params.userId,
      amount: -params.amount,
      balance_before:
        row.balance_before !== undefined
          ? Number(row.balance_before)
          : balance + params.amount,
      balance_after: balance,
      transaction_type: 'usage',
      reason: params.reason,
      reference_id: params.referenceId || null,
      idempotency_key: params.idempotencyKey || null,
      created_at: row.created_at || new Date().toISOString(),
    };

    return {
      success: true,
      balance,
      transaction,
    };
  }

  requireProductionPostgres();

  // Development/test fallback only.
  const releaseLock = await acquireLock(params.userId);

  try {
    // Idempotency is checked only in the isolated memory adapter.
    if (params.idempotencyKey) {
      const existingTx = memDb.creditTransactions.find(
        (tx) =>
          tx.user_id === params.userId &&
          tx.idempotency_key === params.idempotencyKey
      );

      if (existingTx) {
        const account = await getCreditAccount(params.userId);
        return {
          success: true,
          balance: account.balance,
          transaction: { ...existingTx },
        };
      }
    }

    const account = memDb.creditAccounts.get(params.userId);

    if (!account) {
      throw new Error('Credit account not found.');
    }

    if (account.balance < params.amount) {
      createAuditLog({
        userId: params.userId,
        action: 'credit_deduction_insufficient_balance',
        resource: 'credit_ledger',
        details: {
          requested: params.amount,
          available: account.balance,
        },
      });

      throw new Error(
        `Insufficient credits. Required: ${params.amount}, Available: ${account.balance}`
      );
    }

    const balanceBefore = account.balance;
    const balanceAfter = balanceBefore - params.amount;
    const now = new Date().toISOString();

    account.balance = balanceAfter;
    account.total_consumed += params.amount;
    account.version += 1;
    account.updated_at = now;

    const transaction: CreditTransaction = {
      id: crypto.randomUUID(),
      account_id: account.id,
      user_id: params.userId,
      amount: -params.amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      transaction_type: 'usage',
      reason: params.reason,
      reference_id: params.referenceId || null,
      idempotency_key: params.idempotencyKey || null,
      created_at: now,
    };

    memDb.creditTransactions.push(transaction);

    createAuditLog({
      userId: params.userId,
      action: 'credit_deducted',
      resource: 'credit_ledger',
      details: {
        amount: params.amount,
        balanceBefore,
        balanceAfter,
        reason: params.reason,
      },
    });

    return {
      success: true,
      balance: balanceAfter,
      transaction,
    };
  } finally {
    releaseLock();
  }
}

/**
 * Atomically grants credits.
 *
 * Production correctness depends on the PostgreSQL atomic_add_credits()
 * function, which must perform idempotency handling, row locking, balance
 * update, and ledger insertion atomically.
 */
export async function addCredits(params: {
  userId: string;
  amount: number;
  type: TransactionType;
  reason: string;
  referenceId?: string;
  idempotencyKey?: string;
}): Promise<{
  success: boolean;
  balance: number;
  transaction: CreditTransaction;
}> {
  validateUserId(params.userId);
  validateAmount(params.amount);
  validateReason(params.reason);
  validateIdempotencyKey(params.idempotencyKey);

  if (pgPool) {
    const result = await dbQuery<{
      success: boolean;
      balance: number;
      transaction_id: string;
      error_message: string | null;
      balance_before?: number;
      created_at?: string;
    }>(
      `SELECT * FROM atomic_add_credits($1, $2, $3, $4, $5, $6)`,
      [
        params.userId,
        params.amount,
        params.type,
        params.reason,
        params.referenceId || null,
        params.idempotencyKey || null,
      ]
    );

    if (!result || result.rows.length === 0) {
      throw new Error('Database credit grant returned no result.');
    }

    const row = result.rows[0];

    if (!row.success) {
      throw new Error(row.error_message || 'Database credit grant failed.');
    }

    const balance = Number(row.balance);
    const transaction: CreditTransaction = {
      id: row.transaction_id,
      account_id: params.userId,
      user_id: params.userId,
      amount: params.amount,
      balance_before:
        row.balance_before !== undefined
          ? Number(row.balance_before)
          : balance - params.amount,
      balance_after: balance,
      transaction_type: params.type,
      reason: params.reason,
      reference_id: params.referenceId || null,
      idempotency_key: params.idempotencyKey || null,
      created_at: row.created_at || new Date().toISOString(),
    };

    return {
      success: true,
      balance,
      transaction,
    };
  }

  requireProductionPostgres();

  // Development/test fallback only.
  const releaseLock = await acquireLock(params.userId);

  try {
    if (params.idempotencyKey) {
      const existingTx = memDb.creditTransactions.find(
        (tx) =>
          tx.user_id === params.userId &&
          tx.idempotency_key === params.idempotencyKey
      );

      if (existingTx) {
        const account = await getCreditAccount(params.userId);
        return {
          success: true,
          balance: account.balance,
          transaction: { ...existingTx },
        };
      }
    }

    let account = memDb.creditAccounts.get(params.userId);

    if (!account) {
      account = {
        id: crypto.randomUUID(),
        user_id: params.userId,
        balance: 0,
        total_earned: 0,
        total_consumed: 0,
        version: 1,
        updated_at: new Date().toISOString(),
      };

      memDb.creditAccounts.set(params.userId, account);
    }

    const balanceBefore = account.balance;
    const balanceAfter = balanceBefore + params.amount;
    const now = new Date().toISOString();

    account.balance = balanceAfter;
    account.total_earned += params.amount;
    account.version += 1;
    account.updated_at = now;

    const transaction: CreditTransaction = {
      id: crypto.randomUUID(),
      account_id: account.id,
      user_id: params.userId,
      amount: params.amount,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      transaction_type: params.type,
      reason: params.reason,
      reference_id: params.referenceId || null,
      idempotency_key: params.idempotencyKey || null,
      created_at: now,
    };

    memDb.creditTransactions.push(transaction);

    createAuditLog({
      userId: params.userId,
      action: 'credit_granted',
      resource: 'credit_ledger',
      details: {
        amount: params.amount,
        type: params.type,
        balanceBefore,
        balanceAfter,
        reason: params.reason,
      },
    });

    return {
      success: true,
      balance: balanceAfter,
      transaction,
    };
  } finally {
    releaseLock();
  }
}
