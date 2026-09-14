import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser } from '@/lib/auth';
import { addCredits, deductCredits, getCreditAccount } from '@/lib/credits';
import { generateSalesIntelligenceReport } from '@/lib/ai';
import {
  dbGetUserEntitlements,
  dbQuery,
  isPostgresConfigured,
} from '@/lib/db';
import { createAuditLogAsync } from '@/lib/audit';

const isProduction = process.env.NODE_ENV === 'production';

const GenerateReportSchema = z
  .object({
    selling: z.string().trim().min(2).max(500),
    target_industry: z.string().trim().min(2).max(100),
    business_model: z.string().trim().min(2).max(100),
    deal_size: z.string().trim().min(2).max(100),
    buyer_type: z.string().trim().min(2).max(100),
    additional_context: z.string().trim().max(2500).optional(),
  })
  .strict();

const MAX_REPORTS_PER_MINUTE = 10;
const CREDIT_COST_DEFAULT = 1;

function getCreditCost(): number {
  const configured = Number.parseInt(
    process.env.CREDIT_COST_PER_REPORT || '',
    10
  );

  if (!Number.isFinite(configured) || configured <= 0) {
    return CREDIT_COST_DEFAULT;
  }

  return Math.min(configured, 1000);
}

/**
 * Production rate limiting.
 *
 * The original route used an in-process Map. That does not work reliably when
 * the SaaS runs on multiple instances. Until a dedicated distributed rate
 * limit table/cache is introduced, usage_records provides a durable
 * per-user successful-generation window.
 *
 * This is deliberately fail-closed in production when PostgreSQL is absent.
 */
async function enforceGenerationRateLimit(userId: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetTime: number;
}> {
  const now = Date.now();
  const resetTime = now + 60_000;

  if (!isProduction) {
    // Development intentionally avoids requiring a distributed service.
    return {
      allowed: true,
      remaining: MAX_REPORTS_PER_MINUTE,
      resetTime,
    };
  }

  if (!isPostgresConfigured) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production rate limiting requires PostgreSQL.'
    );
  }

  const result = await dbQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM usage_records
      WHERE user_id = $1
        AND feature = 'sales_intelligence_report'
        AND created_at >= CURRENT_TIMESTAMP - INTERVAL '1 minute'`,
    [userId]
  );

  const count = Number.parseInt(result?.rows?.[0]?.count || '0', 10);

  if (!Number.isFinite(count)) {
    throw new Error('Unable to evaluate rate limit.');
  }

  return {
    allowed: count < MAX_REPORTS_PER_MINUTE,
    remaining: Math.max(0, MAX_REPORTS_PER_MINUTE - count),
    resetTime,
  };
}

function errorResponse(
  message: string,
  status: number,
  extra?: Record<string, unknown>
) {
  return NextResponse.json(
    {
      error: message,
      ...extra,
    },
    { status }
  );
}

export async function POST(req: Request) {
  let userId: string | null = null;
  let deducted = false;
  let deductionReference: string | null = null;
  let creditCost = CREDIT_COST_DEFAULT;

  try {
    // 1. Authenticate strictly from the server-side session.
    let user;

    try {
      user = await requireUser();
    } catch {
      return errorResponse(
        'Authentication required to access Sales Assistant.',
        401
      );
    }

    userId = user.id;

    // 2. Parse and validate the request before doing expensive work.
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return errorResponse('Request body must contain valid JSON.', 400);
    }

    const parsed = GenerateReportSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        'Invalid input. All primary sales situation fields are required.',
        400,
        {
          code: 'INVALID_INPUT',
          details: parsed.error.flatten().fieldErrors,
        }
      );
    }

    // 3. Enforce a server-side generation rate limit.
    const rate = await enforceGenerationRateLimit(user.id);

    if (!rate.allowed) {
      return errorResponse(
        'Rate limit reached. Please wait a moment before generating another report.',
        429,
        {
          code: 'RATE_LIMITED',
          remaining: 0,
          resetTime: rate.resetTime,
        }
      );
    }

    /*
     * 4. Trial status is NOT an access gate.
     *
     * The product has an Always Free tier plus a one-month trial. When the
     * trial expires, a user can return to the Free plan. Credits/entitlements
     * remain the authoritative consumption mechanism.
     *
     * Paid entitlement/trial checks belong to billing/entitlement logic, not
     * to a client-controlled request field.
     */
    const entitlements = await dbGetUserEntitlements(user.id);
    const hasActiveEntitlement = entitlements.some(
      (entitlement) =>
        entitlement.is_active &&
        (!entitlement.valid_until ||
          new Date(entitlement.valid_until).getTime() > Date.now())
    );

    if (!hasActiveEntitlement) {
      return errorResponse(
        'No active plan is available for this account.',
        403,
        { code: 'NO_ACTIVE_ENTITLEMENT' }
      );
    }

    // 5. Determine credit cost from server configuration only.
    creditCost = getCreditCost();

    const account = await getCreditAccount(user.id);

    if (account.balance < creditCost) {
      return errorResponse(
        `Insufficient AI credits. This report requires ${creditCost} credit${creditCost === 1 ? '' : 's'}, but your balance is ${account.balance}.`,
        402,
        {
          code: 'INSUFFICIENT_CREDITS',
          balance: account.balance,
          requiredCredits: creditCost,
        }
      );
    }

    /*
     * 6. Reserve/deduct the credit BEFORE calling the AI.
     *
     * This closes the race where multiple requests could generate reports
     * concurrently after seeing the same balance. deductCredits() is backed
     * by the PostgreSQL atomic ledger in production.
     */
    deductionReference = `report-${user.id}-${cryptoRandomId()}`;

    const deduction = await deductCredits({
      userId: user.id,
      amount: creditCost,
      reason: `Sales Intelligence Report generation (${parsed.data.selling.slice(0, 30)})`,
      referenceId: deductionReference,
      idempotencyKey: deductionReference,
    });

    deducted = true;

    // 7. Generate the report through the server-side AI + RAG pipeline.
    const startTime = Date.now();

    let generated;
    try {
      generated = await generateSalesIntelligenceReport(parsed.data);
    } catch (aiError) {
      /*
       * If AI fails after reservation, return the reserved credits.
       * The unique refund key makes this operation idempotent if the caller
       * retries the failure path.
       */
      try {
        await addCredits({
          userId: user.id,
          amount: creditCost,
          type: 'refund',
          reason: 'Refund for failed Sales Intelligence Report generation',
          referenceId: deductionReference,
          idempotencyKey: `refund-${deductionReference}`,
        });
        deducted = false;
      } catch (refundError) {
        console.error('CRITICAL: Failed to refund AI generation credit:', {
          userId: user.id,
          referenceId: deductionReference,
          refundError,
        });
      }

      throw aiError;
    }

    const latencyMs = Date.now() - startTime;
    const { report, tokens } = generated;

    // 8. Persist usage telemetry durably in production.
    const usageId = cryptoRandomId();
    const now = new Date().toISOString();
    const modelUsed =
      process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';

    try {
      if (!isPostgresConfigured) {
        if (isProduction) {
          throw new Error(
            'FATAL CONFIGURATION ERROR: Production usage persistence requires PostgreSQL.'
          );
        }
      } else {
        await dbQuery(
          `INSERT INTO usage_records
             (id, user_id, prompt_tokens, completion_tokens, total_tokens,
              credits_deducted, model, feature, input_summary, latency_ms, created_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            usageId,
            user.id,
            Math.max(0, Math.round(tokens.prompt)),
            Math.max(0, Math.round(tokens.completion)),
            Math.max(0, Math.round(tokens.total)),
            creditCost,
            modelUsed,
            'sales_intelligence_report',
            JSON.stringify({
              selling: parsed.data.selling,
              target_industry: parsed.data.target_industry,
              deal_size: parsed.data.deal_size,
            }),
            Math.max(0, Math.round(latencyMs)),
            now,
          ]
        );
      }
    } catch (usageError) {
      console.error('Failed to persist usage telemetry:', usageError);

      /*
       * Do not silently continue in production because this record is also
       * used by the temporary durable rate-limit implementation.
       */
      if (isProduction) {
        throw new Error(
          'Report was generated but usage recording failed. Please contact support before retrying.'
        );
      }
    }

    // 9. Durable audit event.
    await createAuditLogAsync({
      userId: user.id,
      action: 'report_generated',
      resource: 'sales_assistant',
      details: {
        usageId,
        creditsDeducted: creditCost,
        remainingBalance: deduction.balance,
        latencyMs,
        model: modelUsed,
      },
    });

    return NextResponse.json({
      success: true,
      report,
      creditsDeducted: creditCost,
      remainingBalance: deduction.balance,
      latencyMs,
    });
  } catch (err: unknown) {
    console.error('Sales Intelligence generation request failed:', err);

    /*
     * If a failure happened after deduction but before the AI error handler
     * could refund, make one final best-effort idempotent refund.
     */
    if (deducted && userId && deductionReference) {
      try {
        await addCredits({
          userId,
          amount: creditCost,
          type: 'refund',
          reason: 'Refund for unsuccessful Sales Intelligence Report request',
          referenceId: deductionReference,
          idempotencyKey: `refund-${deductionReference}`,
        });
      } catch (refundError) {
        console.error('CRITICAL: Final AI credit refund failed:', {
          userId,
          deductionReference,
          refundError,
        });
      }
    }

    const message =
      err instanceof Error
        ? err.message
        : 'Failed to generate Sales Intelligence Report.';

    // Do not expose internal configuration/database/provider errors.
    if (
      message.startsWith('FATAL CONFIGURATION ERROR') ||
      message.includes('PostgreSQL') ||
      message.includes('GEMINI_API_KEY') ||
      message.includes('database')
    ) {
      return errorResponse(
        'The Sales Assistant is temporarily unavailable. Please try again later.',
        503,
        { code: 'SERVICE_UNAVAILABLE' }
      );
    }

    if (message.includes('currently unavailable')) {
      return errorResponse(message, 503, {
        code: 'AI_SERVICE_UNAVAILABLE',
      });
    }

    return errorResponse(
      'Unable to generate the Sales Intelligence Report. Please try again.',
      500,
      { code: 'GENERATION_FAILED' }
    );
  }
}

/**
 * Use a cryptographically random request identifier rather than Date.now()
 * so concurrent requests cannot accidentally share an idempotency key.
 */
function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}
