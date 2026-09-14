import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser } from '@/lib/auth';
import { createPaymentOrder } from '@/lib/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreatePaymentSchema = z
  .object({
    planId: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid plan ID.'),
  })
  .strict();

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json(
    {
      error: message,
      ...(code ? { code } : {}),
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}

export async function POST(req: Request) {
  try {
    let user;

    try {
      user = await requireUser();
    } catch {
      return jsonError('Authentication required.', 401, 'UNAUTHORIZED');
    }

    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return jsonError('Request body must contain valid JSON.', 400, 'INVALID_JSON');
    }

    const parsed = CreatePaymentSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError('Invalid payment request.', 400, 'INVALID_INPUT');
    }

    /*
     * IMPORTANT:
     * The browser supplies only the plan ID.
     *
     * createPaymentOrder() loads the authoritative plan from PostgreSQL,
     * determines the amount server-side, and chooses:
     *   - Razorpay Subscription for monthly plans
     *   - Razorpay Order for one-time plans
     */
    const payment = await createPaymentOrder({
      userId: user.id,
      planId: parsed.data.planId,
    });

    return NextResponse.json(
      {
        success: true,
        ...payment,
        /*
         * Keep this field explicit so the frontend cannot accidentally treat
         * a subscription as a normal order.
         */
        checkoutType: payment.kind,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (error: unknown) {
    console.error('Payment initialization failed:', error);

    const message =
      process.env.NODE_ENV === 'production'
        ? 'Unable to initialize payment. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Unable to initialize payment.';

    const status =
      error instanceof Error &&
      /invalid or inactive plan|does not require|does not require a paid checkout|not configured/i.test(
        error.message
      )
        ? 400
        : 500;

    return jsonError(message, status, 'PAYMENT_INITIALIZATION_FAILED');
  }
}
