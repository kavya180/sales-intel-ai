import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUser } from '@/lib/auth';
import {
  fulfillSuccessfulPayment,
  verifyRazorpaySignature,
  verifyRazorpaySubscriptionSignature,
  verifySubscriptionCheckout,
} from '@/lib/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VerifyPaymentSchema = z
  .object({
    checkoutType: z.enum(['order', 'subscription']).optional(),
    orderId: z.string().trim().min(1).max(100).optional(),
    paymentId: z.string().trim().min(1).max(100),
    subscriptionId: z.string().trim().min(1).max(100).optional(),
    signature: z.string().trim().min(1).max(255),
  })
  .strict()
  .superRefine((value, ctx) => {
    const subscription =
      value.checkoutType === 'subscription' || Boolean(value.subscriptionId);

    if (subscription && !value.subscriptionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subscriptionId'],
        message: 'Subscription ID is required.',
      });
    }

    if (!subscription && !value.orderId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderId'],
        message: 'Order ID is required.',
      });
    }
  });

function errorResponse(message: string, status: number, code: string) {
  return NextResponse.json(
    { error: message, code },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(req: Request) {
  try {
    let user;
    try {
      user = await requireUser();
    } catch {
      return errorResponse('Authentication required.', 401, 'UNAUTHORIZED');
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON request body.', 400, 'INVALID_JSON');
    }

    const parsed = VerifyPaymentSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        'Invalid payment verification request.',
        400,
        'INVALID_INPUT'
      );
    }

    const data = parsed.data;
    const isSubscription =
      data.checkoutType === 'subscription' || Boolean(data.subscriptionId);

    if (isSubscription) {
      const subscriptionId = data.subscriptionId!;

      /*
       * Razorpay Subscription Checkout signature:
       * HMAC_SHA256(payment_id + "|" + subscription_id)
       */
      if (
        !verifyRazorpaySubscriptionSignature(
          subscriptionId,
          data.paymentId,
          data.signature
        )
      ) {
        return errorResponse(
          'Payment verification failed.',
          400,
          'INVALID_SIGNATURE'
        );
      }

      /*
       * verifySubscriptionCheckout performs the authenticated-user ownership
       * check against the local subscription record.
       *
       * Credit granting for recurring cycles is intentionally handled by
       * subscription.charged webhooks, not by the browser callback.
       */
      const result = await verifySubscriptionCheckout({
        userId: user.id,
        subscriptionId,
        paymentId: data.paymentId,
        signature: data.signature,
      });

      return NextResponse.json(
        {
          success: result.verified,
          kind: 'subscription',
          subscriptionId: result.subscriptionId,
          paymentId: data.paymentId,
          message:
            'Subscription payment verified. Credits will be granted from the confirmed billing event.',
        },
        {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    const orderId = data.orderId!;

    if (
      !verifyRazorpaySignature(orderId, data.paymentId, data.signature)
    ) {
      return errorResponse(
        'Payment verification failed.',
        400,
        'INVALID_SIGNATURE'
      );
    }

    const payment = await fulfillSuccessfulPayment({
      orderId,
      paymentId: data.paymentId,
      expectedUserId: user.id,
      signature: data.signature,
    });

    return NextResponse.json(
      {
        success: true,
        kind: 'order',
        orderId,
        paymentId: data.paymentId,
        planId: payment.plan_id,
        message: 'Payment verified and credits granted.',
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (error: unknown) {
    console.error('Payment verification failed:', error);

    return errorResponse(
      process.env.NODE_ENV === 'production'
        ? 'Payment verification failed. If your payment was successful, please wait for confirmation.'
        : error instanceof Error
          ? error.message
          : 'Payment verification failed.',
      400,
      'PAYMENT_VERIFICATION_FAILED'
    );
  }
}
