import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { addCredits, deductCredits } from '@/lib/credits';
import { createAuditLogAsync } from '@/lib/audit';
import { isPostgresConfigured } from '@/lib/db';

const AdjustSchema = z
  .object({
    userId: z.string().trim().min(1).max(100),
    amount: z
      .number()
      .finite()
      .refine((n) => n !== 0 && Math.abs(n) <= 1_000_000, {
        message: 'Amount must be non-zero and not exceed 1,000,000.',
      }),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Credit adjustment is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON request body.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const parsed = AdjustSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Valid userId, non-zero amount, and reason are required.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { userId, amount, reason } = parsed.data;
    const headerKey = req.headers.get('idempotency-key')?.trim();
    const idempotencyKey =
      parsed.data.idempotencyKey ||
      (headerKey && headerKey.length <= 200 ? headerKey : undefined) ||
      `admin-adjust-${randomUUID()}`;

    const auditReason = `[Admin:${admin.id}] ${reason}`;

    const result =
      amount > 0
        ? await addCredits({
            userId,
            amount,
            type: 'admin_adjustment',
            reason: auditReason,
            idempotencyKey,
          })
        : await deductCredits({
            userId,
            amount: Math.abs(amount),
            reason: auditReason,
            idempotencyKey,
          });

    await createAuditLogAsync({
      userId: admin.id,
      action: 'admin_credit_adjustment',
      resource: 'credit_account',
      details: {
        targetUserId: userId,
        amount,
        reason,
        newBalance: result.balance,
        idempotencyKey,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: `Adjusted credits by ${amount}. New balance: ${result.balance}`,
        balance: result.balance,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    console.error('Admin credit adjustment failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Credit adjustment failed.'
            : err instanceof Error
              ? err.message
              : 'Adjustment failed.',
      },
      {
        status: 400,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
