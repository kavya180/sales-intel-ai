import crypto from 'crypto';
import Razorpay from 'razorpay';

import {
  dbGetPlanById,
  dbCreatePayment,
  dbGetPaymentByOrderId,
  dbUpdatePayment,
  dbUpsertEntitlement,
  dbQuery,
  isPostgresConfigured,
  memDb,
} from '@/lib/db';
import { addCredits } from '@/lib/credits';
import { createAuditLogAsync } from '@/lib/audit';
import type { PaymentRecord, Entitlement, Plan } from '@/types';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '';
const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

let razorpayClient: Razorpay | null = null;

if (keyId && keySecret) {
  try {
    razorpayClient = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
  } catch (error) {
    console.error('Failed to initialize Razorpay client:', error);
  }
}

function isMockAllowed(): boolean {
  return (
    !isProduction() &&
    (process.env.PAYMENT_MODE || '').trim().toLowerCase() === 'mock'
  );
}

function requireProductionPaymentInfrastructure(): void {
  if (!isProduction()) return;

  if (isMockAllowed()) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: PAYMENT_MODE=mock is prohibited in production.'
    );
  }

  if (!keyId || !keySecret || !razorpayClient) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Valid production Razorpay credentials/client are required.'
    );
  }

  if (!webhookSecret || webhookSecret.toLowerCase().includes('mock')) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Valid RAZORPAY_WEBHOOK_SECRET is required in production.'
    );
  }

  if (!isPostgresConfigured) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: PostgreSQL is required for production payments.'
    );
  }
}

export function validatePaymentConfig(): void {
  requireProductionPaymentInfrastructure();
}

function requireServerSidePaymentReady(): void {
  validatePaymentConfig();

  if (!razorpayClient && !isMockAllowed()) {
    throw new Error('Payment gateway is not configured.');
  }
}

function amountToPaise(plan: Plan): number {
  if (!Number.isFinite(Number(plan.price_inr))) {
    throw new Error('Invalid server-side plan amount.');
  }

  const amount = Math.round(Number(plan.price_inr) * 100);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Invalid server-side plan amount.');
  }

  return amount;
}

function timingSafeHexEqual(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');

  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Razorpay normal Checkout:
 * HMAC_SHA256(order_id + "|" + payment_id)
 */
export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  if (!orderId || !paymentId || !signature) return false;

  if (isProduction()) {
    if (!keySecret || isMockAllowed()) return false;
  }

  if (isMockAllowed() && signature.startsWith('mock_sig_')) {
    return true;
  }

  if (!keySecret) return false;

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`, 'utf8')
    .digest('hex');

  return timingSafeHexEqual(expected, signature);
}

/**
 * Razorpay Subscription Checkout:
 * HMAC_SHA256(payment_id + "|" + subscription_id)
 */
export function verifyRazorpaySubscriptionSignature(
  subscriptionId: string,
  paymentId: string,
  signature: string
): boolean {
  if (!subscriptionId || !paymentId || !signature) return false;

  if (isProduction()) {
    if (!keySecret || isMockAllowed()) return false;
  }

  if (isMockAllowed() && signature.startsWith('mock_sub_sig_')) {
    return true;
  }

  if (!keySecret) return false;

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${paymentId}|${subscriptionId}`, 'utf8')
    .digest('hex');

  return timingSafeHexEqual(expected, signature);
}

/**
 * Razorpay webhook signatures MUST be calculated over the exact raw request body.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  if (!rawBody || !signature) return false;

  if (isProduction() && (!webhookSecret || webhookSecret.toLowerCase().includes('mock'))) {
    return false;
  }

  if (!webhookSecret) {
    return isMockAllowed() && signature.startsWith('mock_webhook_');
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  return timingSafeHexEqual(expected, signature);
}

function getObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, any>)
    : null;
}

function extractWebhookEventId(payload: unknown): string | null {
  const object = getObject(payload);
  const eventId =
    object?.id ??
    object?.event_id ??
    object?.payload?.payment?.entity?.notes?.event_id ??
    null;

  return typeof eventId === 'string' && eventId.trim()
    ? eventId.trim()
    : null;
}

function extractPaymentEntity(payload: unknown): Record<string, any> | null {
  return getObject(payload)?.payload?.payment?.entity ?? null;
}

function extractSubscriptionEntity(
  payload: unknown
): Record<string, any> | null {
  return getObject(payload)?.payload?.subscription?.entity ?? null;
}

function extractPaymentId(payload: unknown): string | null {
  const entity = extractPaymentEntity(payload);
  return typeof entity?.id === 'string' ? entity.id : null;
}

function extractOrderId(payload: unknown): string | null {
  const entity = extractPaymentEntity(payload);
  return typeof entity?.order_id === 'string' ? entity.order_id : null;
}

function extractSubscriptionId(payload: unknown): string | null {
  const payment = extractPaymentEntity(payload);
  const subscription = extractSubscriptionEntity(payload);

  const id =
    subscription?.id ??
    payment?.subscription_id ??
    payment?.notes?.subscription_id ??
    null;

  return typeof id === 'string' ? id : null;
}

function extractPaymentAmountPaise(payload: unknown): number | null {
  const entity = extractPaymentEntity(payload);
  const amount = entity?.amount;

  return typeof amount === 'number' &&
    Number.isSafeInteger(amount) &&
    amount > 0
    ? amount
    : null;
}

function extractPaymentCurrency(payload: unknown): string | null {
  const entity = extractPaymentEntity(payload);
  return typeof entity?.currency === 'string' ? entity.currency : null;
}

function extractWebhookPaymentStatus(payload: unknown): string | null {
  const entity = extractPaymentEntity(payload);
  return typeof entity?.status === 'string' ? entity.status : null;
}

function getSubscriptionPeriod(
  subscriptionEntity: Record<string, any> | null,
  fallbackDays = 30
): { start: string; end: string } {
  const now = Date.now();

  const startUnix =
    Number(subscriptionEntity?.current_start) ||
    Math.floor(now / 1000);

  const endUnix =
    Number(subscriptionEntity?.current_end) ||
    startUnix + fallbackDays * 24 * 60 * 60;

  const start = new Date(startUnix * 1000);
  const end = new Date(endUnix * 1000);

  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end.getTime() <= start.getTime()
  ) {
    const fallbackEnd = new Date(
      start.getTime() + fallbackDays * 24 * 60 * 60 * 1000
    );

    return {
      start: start.toISOString(),
      end: fallbackEnd.toISOString(),
    };
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function sanitizeRazorpayError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 500);
  }

  return 'Payment gateway operation failed.';
}

async function recordSubscriptionInDatabase(params: {
  userId: string;
  plan: Plan;
  subscriptionId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  providerCustomerId?: string | null;
}): Promise<void> {
  if (isPostgresConfigured) {
    await dbQuery(
      `INSERT INTO subscriptions (
         id,
         user_id,
         plan_id,
         provider_subscription_id,
         provider_customer_id,
         status,
         current_period_start,
         current_period_end,
         created_at,
         updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )
       ON CONFLICT (provider_subscription_id)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         plan_id = EXCLUDED.plan_id,
         provider_customer_id = EXCLUDED.provider_customer_id,
         status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = CURRENT_TIMESTAMP`,
      [
        crypto.randomUUID(),
        params.userId,
        params.plan.id,
        params.subscriptionId,
        params.providerCustomerId || null,
        params.status,
        params.currentPeriodStart,
        params.currentPeriodEnd,
      ]
    );
    return;
  }

  if (isProduction()) {
    throw new Error('PostgreSQL is required for subscription persistence.');
  }

  // Development/test fallback. Production never uses this state.
  const key = `subscription:${params.subscriptionId}`;
  const subscriptionStore = getMemorySubscriptionStore();

  subscriptionStore.set(key, {
    userId: params.userId,
    planId: params.plan.id,
    providerSubscriptionId: params.subscriptionId,
    providerCustomerId: params.providerCustomerId || null,
    status: params.status,
    currentPeriodStart: params.currentPeriodStart,
    currentPeriodEnd: params.currentPeriodEnd,
  });
}

type MemorySubscription = {
  userId: string;
  planId: string;
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
};

const memorySubscriptions = new Map<string, MemorySubscription>();

function getMemorySubscriptionStore(): Map<string, MemorySubscription> {
  return memorySubscriptions;
}

async function getSubscriptionByProviderId(
  subscriptionId: string
): Promise<MemorySubscription | Record<string, any> | null> {
  if (!subscriptionId) return null;

  if (isPostgresConfigured) {
    const result = await dbQuery(
      `SELECT
         id,
         user_id,
         plan_id,
         provider_subscription_id,
         provider_customer_id,
         status,
         current_period_start,
         current_period_end,
         cancel_at_period_end,
         created_at,
         updated_at
       FROM subscriptions
       WHERE provider_subscription_id = $1
       LIMIT 1`,
      [subscriptionId]
    );

    return result?.rows?.[0] || null;
  }

  if (isProduction()) {
    throw new Error('PostgreSQL is required for subscription lookup.');
  }

  return memorySubscriptions.get(`subscription:${subscriptionId}`) || null;
}

async function markWebhookEventProcessed(params: {
  eventId: string;
  eventType: string;
  subscriptionId?: string | null;
  paymentId?: string | null;
  payload: unknown;
}): Promise<boolean> {
  if (!params.eventId) {
    throw new Error('Razorpay webhook event ID is required.');
  }

  if (isPostgresConfigured) {
    const result = await dbQuery(
      `INSERT INTO payment_webhook_events (
         id,
         provider,
         event_id,
         event_type,
         provider_subscription_id,
         provider_payment_id,
         payload,
         processed_at
       )
       VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [
        crypto.randomUUID(),
        params.eventId,
        params.eventType,
        params.subscriptionId || null,
        params.paymentId || null,
        JSON.stringify(params.payload ?? {}),
      ]
    );

    return Boolean(result?.rows?.[0]);
  }

  if (isProduction()) {
    throw new Error('PostgreSQL is required for webhook idempotency.');
  }

  const key = `razorpay:${params.eventId}`;

  if ((markWebhookEventProcessed as any)._memoryEvents?.has(key)) {
    return false;
  }

  if (!(markWebhookEventProcessed as any)._memoryEvents) {
    (markWebhookEventProcessed as any)._memoryEvents = new Set<string>();
  }

  (markWebhookEventProcessed as any)._memoryEvents.add(key);
  return true;
}

async function updateSubscriptionStatus(params: {
  subscriptionId: string;
  status: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  if (isPostgresConfigured) {
    await dbQuery(
      `UPDATE subscriptions
       SET
         status = $1,
         current_period_start = COALESCE($2, current_period_start),
         current_period_end = COALESCE($3, current_period_end),
         cancel_at_period_end = COALESCE($4, cancel_at_period_end),
         updated_at = CURRENT_TIMESTAMP
       WHERE provider_subscription_id = $5`,
      [
        params.status,
        params.currentPeriodStart || null,
        params.currentPeriodEnd || null,
        typeof params.cancelAtPeriodEnd === 'boolean'
          ? params.cancelAtPeriodEnd
          : null,
        params.subscriptionId,
      ]
    );
    return;
  }

  if (isProduction()) {
    throw new Error('PostgreSQL is required for subscription status updates.');
  }

  const store = memorySubscriptions;
  const existing = store.get(`subscription:${params.subscriptionId}`);

  if (existing) {
    existing.status = params.status;
    if (params.currentPeriodStart) {
      existing.currentPeriodStart = params.currentPeriodStart;
    }
    if (params.currentPeriodEnd) {
      existing.currentPeriodEnd = params.currentPeriodEnd;
    }
  }
}

async function upsertMonthlyEntitlement(params: {
  userId: string;
  plan: Plan;
  validFrom: string;
  validUntil: string;
  sourceReference: string;
}): Promise<void> {
  if (isPostgresConfigured) {
    await dbQuery(
      `UPDATE entitlements
       SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
         AND type = 'monthly'
         AND is_active = true`,
      [params.userId]
    );

    await dbQuery(
      `INSERT INTO entitlements (
         id,
         user_id,
         plan_id,
         type,
         valid_from,
         valid_until,
         is_active,
         source_reference,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, 'monthly', $4, $5, true, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        crypto.randomUUID(),
        params.userId,
        params.plan.id,
        params.validFrom,
        params.validUntil,
        params.sourceReference,
      ]
    );

    return;
  }

  if (isProduction()) {
    throw new Error('PostgreSQL is required for subscription entitlements.');
  }

  const entitlement: Entitlement = {
    id: crypto.randomUUID(),
    user_id: params.userId,
    plan_id: params.plan.id,
    type: 'monthly',
    valid_from: params.validFrom,
    valid_until: params.validUntil,
    is_active: true,
    source_reference: params.sourceReference,
    created_at: params.validFrom,
  };

  await dbUpsertEntitlement(entitlement);
}

async function createSubscriptionPaymentRecord(params: {
  userId: string;
  plan: Plan;
  paymentId: string;
  subscriptionId: string;
  amountInr: number;
  currency: string;
  signature?: string | null;
  rawEvent?: unknown;
}): Promise<void> {
  /*
   * PaymentRecord currently requires an order_id for compatibility with the
   * existing TypeScript model/repository. Subscription charges do not need a
   * Razorpay order_id, so use a deterministic internal reference based on the
   * Razorpay payment ID. The database stores the real subscription ID separately.
   */
  const internalOrderId = `subscription_payment_${params.paymentId}`;

  if (isPostgresConfigured) {
    await dbQuery(
      `INSERT INTO payments (
         id,
         user_id,
         plan_id,
         provider,
         order_id,
         payment_id,
         provider_subscription_id,
         payment_type,
         signature,
         amount_inr,
         currency,
         status,
         idempotency_key,
         raw_event,
         created_at,
         updated_at
       )
       VALUES (
         $1, $2, $3, 'razorpay', $4, $5, $6, 'subscription',
         $7, $8, $9, 'captured', $10, $11,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )
       ON CONFLICT (payment_id) DO NOTHING`,
      [
        crypto.randomUUID(),
        params.userId,
        params.plan.id,
        internalOrderId,
        params.paymentId,
        params.subscriptionId,
        params.signature || null,
        params.amountInr,
        params.currency,
        `subscription-grant-${params.paymentId}`,
        JSON.stringify(params.rawEvent ?? {}),
      ]
    );
    return;
  }

  if (isProduction()) {
    throw new Error('PostgreSQL is required for subscription payment records.');
  }

  const payment: PaymentRecord = {
    id: crypto.randomUUID(),
    user_id: params.userId,
    plan_id: params.plan.id,
    provider: 'razorpay',
    order_id: internalOrderId,
    payment_id: params.paymentId,
    signature: params.signature || null,
    amount_inr: params.amountInr,
    currency: params.currency,
    status: 'captured',
    idempotency_key: `subscription-grant-${params.paymentId}`,
    raw_event: params.rawEvent,
    created_at: new Date().toISOString(),
  };

  memDb.payments.set(internalOrderId, payment);
}

async function grantSubscriptionCredits(params: {
  userId: string;
  plan: Plan;
  paymentId: string;
  subscriptionId: string;
  periodEnd: string;
  rawEvent?: unknown;
}): Promise<void> {
  await addCredits({
    userId: params.userId,
    amount: Number(params.plan.credits),
    type: 'subscription_credit',
    reason: `Monthly subscription charge confirmed for ${params.plan.name} (${params.subscriptionId})`,
    referenceId: params.paymentId,
    idempotencyKey: `subscription-grant-${params.paymentId}`,
  });

  await upsertMonthlyEntitlement({
    userId: params.userId,
    plan: params.plan,
    validFrom: new Date().toISOString(),
    validUntil: params.periodEnd,
    sourceReference: params.paymentId,
  });

  await createAuditLogAsync({
    userId: params.userId,
    action: 'subscription_charge_fulfilled',
    resource: 'subscriptions',
    details: {
      subscriptionId: params.subscriptionId,
      paymentId: params.paymentId,
      planId: params.plan.id,
      creditsGranted: Number(params.plan.credits),
      periodEnd: params.periodEnd,
    },
  });
}

/**
 * Creates either:
 *   - a Razorpay Subscription for monthly_pro
 *   - a normal Razorpay Order for onetime_pass
 *
 * The client never supplies price, amount or currency.
 */
export async function createPaymentOrder(params: {
  userId: string;
  planId: string;
}): Promise<{
  kind: 'subscription' | 'order';
  orderId?: string;
  subscriptionId?: string;
  amount: number;
  currency: string;
  planName: string;
  planId: string;
}> {
  if (!params.userId || !params.planId) {
    throw new Error('User and plan are required.');
  }

  requireServerSidePaymentReady();

  const plan = await dbGetPlanById(params.planId);

  if (!plan || !plan.active) {
    throw new Error('Invalid or inactive plan selected.');
  }

  if (!['monthly', 'onetime'].includes(plan.type)) {
    throw new Error('This plan does not require a payment.');
  }

  if (plan.currency !== 'INR') {
    throw new Error('Unsupported payment currency.');
  }

  const amountInPaise = amountToPaise(plan);

  /*
   * MONTHLY: true recurring Razorpay Subscription.
   *
   * provider_plan_id must be a real Razorpay Plan ID configured in the DB.
   * Do not create a Razorpay Plan during every checkout.
   */
  if (plan.type === 'monthly') {
    if (!plan.provider_plan_id) {
      throw new Error(
        'Monthly subscription is not configured. A Razorpay recurring Plan ID must be configured for this plan.'
      );
    }

    let subscriptionId: string;

    if (isMockAllowed()) {
      subscriptionId = `mock_sub_${crypto.randomUUID()}`;
    } else {
      try {
        const subscription = await razorpayClient!.subscriptions.create({
          plan_id: plan.provider_plan_id,
          total_count: 120,
          quantity: 1,
          customer_notify: 1,
          notes: {
            userId: params.userId,
            planId: plan.id,
          },
        } as any);

        if (!subscription?.id) {
          throw new Error('Razorpay returned an invalid subscription.');
        }

        subscriptionId = subscription.id;
      } catch (error) {
        console.error(
          'Razorpay subscription creation failed:',
          sanitizeRazorpayError(error)
        );
        throw new Error(
          'Failed to create recurring subscription with payment gateway.'
        );
      }
    }

    const now = new Date();
    const periodEnd = new Date(
      now.getTime() + Math.max(1, plan.duration_days || 30) * 24 * 60 * 60 * 1000
    );

    await recordSubscriptionInDatabase({
      userId: params.userId,
      plan,
      subscriptionId,
      status: 'pending',
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(),
    });

    await createAuditLogAsync({
      userId: params.userId,
      action: 'subscription_created',
      resource: 'subscriptions',
      details: {
        subscriptionId,
        planId: plan.id,
        providerPlanId: plan.provider_plan_id,
        amountInr: Number(plan.price_inr),
        mock: isMockAllowed(),
      },
    });

    return {
      kind: 'subscription',
      subscriptionId,
      amount: amountInPaise,
      currency: 'INR',
      planName: plan.name,
      planId: plan.id,
    };
  }

  // ONE-TIME: normal Razorpay Order.
  let orderId: string;

  if (isMockAllowed()) {
    orderId = `mock_order_${crypto.randomUUID()}`;
  } else {
    try {
      const order = await razorpayClient!.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `rcpt_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        notes: {
          userId: params.userId,
          planId: params.planId,
        },
      });

      if (!order?.id) {
        throw new Error('Razorpay returned an invalid order.');
      }

      orderId = order.id;
    } catch (error) {
      console.error(
        'Razorpay order creation failed:',
        sanitizeRazorpayError(error)
      );
      throw new Error(
        'Failed to create payment order with payment gateway.'
      );
    }
  }

  const paymentRecord: PaymentRecord = {
    id: crypto.randomUUID(),
    user_id: params.userId,
    plan_id: params.planId,
    provider: 'razorpay',
    order_id: orderId,
    amount_inr: Number(plan.price_inr),
    currency: 'INR',
    status: 'created',
    idempotency_key: `order-${orderId}`,
    created_at: new Date().toISOString(),
  };

  await dbCreatePayment(paymentRecord);

  await createAuditLogAsync({
    userId: params.userId,
    action: 'payment_order_created',
    resource: 'payments',
    details: {
      orderId,
      planId: plan.id,
      amountInr: Number(plan.price_inr),
      provider: 'razorpay',
      paymentType: 'one_time',
      mock: isMockAllowed(),
    },
  });

  return {
    kind: 'order',
    orderId,
    amount: amountInPaise,
    currency: 'INR',
    planName: plan.name,
    planId: plan.id,
  };
}

/**
 * Fulfill a successful ONE-TIME Razorpay payment.
 *
 * Monthly subscriptions are fulfilled by subscription webhooks so recurring
 * charges cannot depend on a browser callback.
 */
export async function fulfillSuccessfulPayment(params: {
  orderId: string;
  paymentId: string;
  expectedUserId?: string;
  signature?: string;
  rawPayload?: unknown;
}): Promise<PaymentRecord> {
  if (!params.orderId || !params.paymentId) {
    throw new Error('Payment order ID and payment ID are required.');
  }

  requireServerSidePaymentReady();

  const payment = await dbGetPaymentByOrderId(params.orderId);

  if (!payment) {
    throw new Error('Payment order not found.');
  }

  if (payment.provider !== 'razorpay') {
    throw new Error('Unsupported payment provider.');
  }

  if (params.expectedUserId && payment.user_id !== params.expectedUserId) {
    await createAuditLogAsync({
      userId: params.expectedUserId,
      action: 'payment_fulfillment_unauthorized_user_mismatch',
      resource: 'payments',
      details: {
        orderId: params.orderId,
      },
    });

    throw new Error(
      'Unauthorized payment verification: order does not belong to authenticated user.'
    );
  }

  if (payment.status === 'captured') {
    if (payment.payment_id && payment.payment_id !== params.paymentId) {
      throw new Error('Payment order is already fulfilled by another payment.');
    }

    return payment;
  }

  if (payment.payment_id && payment.payment_id !== params.paymentId) {
    throw new Error('Payment record contains a conflicting payment ID.');
  }

  const plan = await dbGetPlanById(payment.plan_id);

  if (!plan || !plan.active) {
    throw new Error('Associated plan not found or is inactive.');
  }

  if (plan.type !== 'onetime') {
    throw new Error(
      'This payment belongs to a recurring subscription and must be fulfilled through the subscription flow.'
    );
  }

  const expectedAmountPaise = amountToPaise(plan);

  if (params.signature && !verifyRazorpaySignature(
    params.orderId,
    params.paymentId,
    params.signature
  )) {
    throw new Error('Invalid Razorpay payment signature.');
  }

  if (params.rawPayload && typeof params.rawPayload === 'object') {
    const payloadPaymentId = extractPaymentId(params.rawPayload);
    const payloadOrderId = extractOrderId(params.rawPayload);
    const payloadAmount = extractPaymentAmountPaise(params.rawPayload);
    const payloadCurrency = extractPaymentCurrency(params.rawPayload);
    const payloadStatus = extractWebhookPaymentStatus(params.rawPayload);

    if (payloadPaymentId && payloadPaymentId !== params.paymentId) {
      throw new Error('Payment ID mismatch.');
    }

    if (payloadOrderId && payloadOrderId !== params.orderId) {
      throw new Error('Order ID mismatch.');
    }

    if (payloadAmount !== null && payloadAmount !== expectedAmountPaise) {
      throw new Error('Payment amount does not match the selected plan.');
    }

    if (payloadCurrency !== null && payloadCurrency !== 'INR') {
      throw new Error('Payment currency mismatch.');
    }

    if (payloadStatus && !['captured', 'authorized'].includes(payloadStatus)) {
      throw new Error('Razorpay payment is not in a successful state.');
    }
  }

  const now = new Date();
  const validUntil = new Date(
    now.getTime() + Math.max(1, plan.duration_days || 365) * 24 * 60 * 60 * 1000
  ).toISOString();

  payment.status = 'captured';
  payment.payment_id = params.paymentId;
  payment.signature = params.signature || null;
  payment.raw_event = params.rawPayload;

  await dbUpdatePayment(payment);

  const entitlement: Entitlement = {
    id: crypto.randomUUID(),
    user_id: payment.user_id,
    plan_id: plan.id,
    type: 'onetime',
    valid_from: now.toISOString(),
    valid_until: validUntil,
    is_active: true,
    source_reference: params.paymentId,
    created_at: now.toISOString(),
  };

  await dbUpsertEntitlement(entitlement);

  await addCredits({
    userId: payment.user_id,
    amount: Number(plan.credits),
    type: 'one_time_purchase',
    reason: `Payment confirmed for ${plan.name} (Order: ${params.orderId})`,
    referenceId: params.paymentId,
    idempotencyKey: `pay-grant-${params.orderId}`,
  });

  await createAuditLogAsync({
    userId: payment.user_id,
    action: 'payment_verified_and_fulfilled',
    resource: 'payments',
    details: {
      orderId: params.orderId,
      paymentId: params.paymentId,
      planId: plan.id,
      creditsGranted: Number(plan.credits),
      amountInr: Number(payment.amount_inr),
      paymentType: 'one_time',
    },
  });

  return payment;
}

/**
 * Verifies the browser response for a Razorpay Subscription Checkout.
 *
 * Browser verification proves that the Checkout response was signed. The
 * recurring entitlement/credit source of truth is still the webhook.
 */
export async function verifySubscriptionCheckout(params: {
  userId: string;
  subscriptionId: string;
  paymentId: string;
  signature: string;
}): Promise<{
  verified: boolean;
  subscriptionId: string;
}> {
  if (
    !params.userId ||
    !params.subscriptionId ||
    !params.paymentId ||
    !params.signature
  ) {
    throw new Error('Subscription verification fields are required.');
  }

  requireServerSidePaymentReady();

  const valid = verifyRazorpaySubscriptionSignature(
    params.subscriptionId,
    params.paymentId,
    params.signature
  );

  if (!valid) {
    throw new Error('Invalid Razorpay subscription signature.');
  }

  const subscription = await getSubscriptionByProviderId(
    params.subscriptionId
  );

  if (!subscription) {
    throw new Error('Subscription was not found.');
  }

  const ownerId =
    typeof (subscription as any).user_id === 'string'
      ? (subscription as any).user_id
      : (subscription as MemorySubscription).userId;

  if (ownerId !== params.userId) {
    throw new Error('Subscription does not belong to the authenticated user.');
  }

  await createAuditLogAsync({
    userId: params.userId,
    action: 'subscription_checkout_verified',
    resource: 'subscriptions',
    details: {
      subscriptionId: params.subscriptionId,
      paymentId: params.paymentId,
    },
  });

  return {
    verified: true,
    subscriptionId: params.subscriptionId,
  };
}

/**
 * Process a verified Razorpay webhook.
 *
 * Important events:
 *   subscription.activated
 *   subscription.charged
 *   subscription.halted
 *   subscription.cancelled
 *   subscription.completed
 *   subscription.expired
 *
 * subscription.charged is the recurring credit-grant boundary.
 */
export async function processRazorpayWebhook(params: {
  rawBody: string;
  signature: string;
  payload: unknown;
}): Promise<{ processed: boolean; event: string }> {
  requireServerSidePaymentReady();

  if (!verifyWebhookSignature(params.rawBody, params.signature)) {
    throw new Error('Invalid Razorpay webhook signature.');
  }

  const payload = getObject(params.payload);

  if (!payload) {
    throw new Error('Invalid Razorpay webhook payload.');
  }

  const event = typeof payload.event === 'string' ? payload.event : '';

  if (!event || event.length > 100) {
    throw new Error('Webhook event type is missing or invalid.');
  }

  const eventId = extractWebhookEventId(payload);

  if (!eventId) {
    /*
     * Razorpay webhook payloads should carry an event identifier. In
     * production we fail closed rather than process an event that cannot be
     * made idempotent.
     */
    throw new Error('Webhook event identifier is missing.');
  }

  const subscriptionId = extractSubscriptionId(payload);
  const paymentId = extractPaymentId(payload);

  const firstProcessing = await markWebhookEventProcessed({
    eventId,
    eventType: event,
    subscriptionId,
    paymentId,
    payload,
  });

  if (!firstProcessing) {
    return {
      processed: false,
      event,
    };
  }

  const subscriptionEvents = new Set([
    'subscription.activated',
    'subscription.charged',
    'subscription.halted',
    'subscription.cancelled',
    'subscription.completed',
    'subscription.expired',
    'subscription.paused',
    'subscription.resumed',
  ]);

  if (!subscriptionEvents.has(event)) {
    /*
     * Unknown/unrelated webhook events are still durably marked as processed
     * after signature verification. They do not mutate billing state.
     */
    return {
      processed: true,
      event,
    };
  }

  if (!subscriptionId) {
    throw new Error(`Webhook ${event} does not contain a subscription ID.`);
  }

  const subscription = await getSubscriptionByProviderId(subscriptionId);

  if (!subscription) {
    /*
     * Do not silently create an entitlement from an unrecognized subscription.
     * This protects against forged/misrouted events even after signature
     * verification.
     */
    throw new Error('Subscription does not exist in local billing records.');
  }

  const userId =
    typeof (subscription as any).user_id === 'string'
      ? (subscription as any).user_id
      : (subscription as MemorySubscription).userId;

  const planId =
    typeof (subscription as any).plan_id === 'string'
      ? (subscription as any).plan_id
      : (subscription as MemorySubscription).planId;

  const plan = await dbGetPlanById(planId);

  if (!plan || !plan.active || plan.type !== 'monthly') {
    throw new Error('Subscription is linked to an invalid monthly plan.');
  }

  const subscriptionEntity = extractSubscriptionEntity(payload);
  const period = getSubscriptionPeriod(
    subscriptionEntity,
    Math.max(1, plan.duration_days || 30)
  );

  switch (event) {
    case 'subscription.activated':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'active',
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
      });

      await createAuditLogAsync({
        userId,
        action: 'subscription_activated',
        resource: 'subscriptions',
        details: {
          subscriptionId,
          planId,
          currentPeriodEnd: period.end,
        },
      });
      break;

    case 'subscription.charged': {
      if (!paymentId) {
        throw new Error(
          'subscription.charged webhook does not contain a payment ID.'
        );
      }

      const amountPaise = extractPaymentAmountPaise(payload);
      const currency = extractPaymentCurrency(payload);

      const expectedAmountPaise = amountToPaise(plan);

      if (amountPaise !== null && amountPaise !== expectedAmountPaise) {
        throw new Error('Subscription charge amount does not match the plan.');
      }

      if (currency && currency !== 'INR') {
        throw new Error('Subscription charge currency mismatch.');
      }

      await updateSubscriptionStatus({
        subscriptionId,
        status: 'active',
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
      });

      await createSubscriptionPaymentRecord({
        userId,
        plan,
        paymentId,
        subscriptionId,
        amountInr: Number(plan.price_inr),
        currency: currency || 'INR',
        rawEvent: payload,
      });

      await grantSubscriptionCredits({
        userId,
        plan,
        paymentId,
        subscriptionId,
        periodEnd: period.end,
        rawEvent: payload,
      });
      break;
    }

    case 'subscription.halted':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'halted',
      });

      await createAuditLogAsync({
        userId,
        action: 'subscription_halted',
        resource: 'subscriptions',
        details: {
          subscriptionId,
          planId,
          reason: 'Razorpay subscription halted',
        },
      });
      break;

    case 'subscription.cancelled':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'cancelled',
      });

      if (isPostgresConfigured) {
        await dbQuery(
          `UPDATE entitlements
           SET is_active = false, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $1
             AND type = 'monthly'
             AND is_active = true
             AND (
               valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP
             )`,
          [userId]
        );
      }

      await createAuditLogAsync({
        userId,
        action: 'subscription_cancelled',
        resource: 'subscriptions',
        details: {
          subscriptionId,
          planId,
        },
      });
      break;

    case 'subscription.completed':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'completed',
      });
      break;

    case 'subscription.expired':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'expired',
      });
      break;

    case 'subscription.paused':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'halted',
      });
      break;

    case 'subscription.resumed':
      await updateSubscriptionStatus({
        subscriptionId,
        status: 'active',
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
      });
      break;
  }

  return {
    processed: true,
    event,
  };
}
