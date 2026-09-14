import { NextResponse } from 'next/server';

import { processRazorpayWebhook } from '@/lib/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    /*
     * Razorpay webhook signatures are calculated over the exact raw request
     * body. Do not parse and re-stringify before verification.
     */
    const rawBody = await req.text();

    if (!rawBody || rawBody.length > 2_000_000) {
      return NextResponse.json(
        { error: 'Invalid webhook payload.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const signature = req.headers.get('x-razorpay-signature');

    if (!signature) {
      return NextResponse.json(
        { error: 'Missing webhook signature.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    /*
     * payments.ts owns:
     * - signature verification
     * - JSON validation
     * - webhook idempotency
     * - subscription lifecycle updates
     * - subscription.charged credit grants
     */
    let payload: unknown;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: 'Invalid webhook payload.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const result = await processRazorpayWebhook({
      rawBody,
      signature,
      payload,
    });

    return NextResponse.json(
      {
        success: true,
        received: true,
        processed: result.processed,
        event: result.event,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (error: unknown) {
    console.error('Razorpay webhook processing failed:', error);

    const message = error instanceof Error ? error.message : '';

    const invalidRequest =
      message === 'Invalid Razorpay webhook signature.' ||
      message === 'Invalid Razorpay webhook payload.' ||
      message === 'Webhook event identifier is missing.';

    return NextResponse.json(
      {
        error: invalidRequest
          ? 'Invalid webhook request.'
          : 'Webhook processing failed.',
      },
      {
        status: invalidRequest ? 400 : 500,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
