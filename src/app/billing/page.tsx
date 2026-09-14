'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Check, CreditCard, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

type Plan = {
  id: string;
  name: string;
  description?: string | null;
  price_inr: number;
  billing_period?: string | null;
  credits: number;
  is_active?: boolean;
};

type RazorpayOptions = {
  key: string;
  amount?: number;
  currency: string;
  name: string;
  description: string;
  order_id?: string;
  subscription_id?: string;
  prefill?: {
    name?: string;
    email?: string;
  };
  theme?: {
    color?: string;
  };
  handler: (response: Record<string, string>) => void | Promise<void>;
  modal?: {
    ondismiss?: () => void;
  };
};

type RazorpayConstructor = new (options: RazorpayOptions) => {
  open: () => void;
};

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

function isMonthly(plan: Plan) {
  return String(plan.billing_period || '').toLowerCase() === 'monthly';
}

async function readJson(response: Response) {
  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : 'Request failed.';
    throw new Error(message);
  }

  return data as Record<string, unknown>;
}

function loadRazorpay(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.querySelector(
      'script[data-razorpay-checkout="true"]'
    ) as HTMLScriptElement | null;

    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.Razorpay)), {
        once: true,
      });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpayCheckout = 'true';
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export default function BillingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutPlan, setCheckoutPlan] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  async function loadPlans() {
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/plans', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const data = await readJson(response);

      const received = Array.isArray(data.plans) ? data.plans : [];

      setPlans(
        received.filter((plan): plan is Plan => {
          if (!plan || typeof plan !== 'object') return false;

          const p = plan as Partial<Plan>;

          return (
            typeof p.id === 'string' &&
            typeof p.name === 'string' &&
            typeof p.price_inr === 'number' &&
            Number.isFinite(p.price_inr) &&
            typeof p.credits === 'number' &&
            Number.isFinite(p.credits)
          );
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load plans.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlans();
  }, []);

  async function startCheckout(plan: Plan) {
    setCheckoutPlan(plan.id);
    setError('');
    setMessage('');

    try {
      const razorpayAvailable = await loadRazorpay();

      if (!razorpayAvailable || !window.Razorpay) {
        throw new Error('Payment checkout could not be loaded. Please try again.');
      }

      const createResponse = await fetch('/api/payments/create-order', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ planId: plan.id }),
      });

      const payment = await readJson(createResponse);

      const key =
        typeof payment.keyId === 'string' ? payment.keyId : undefined;

      if (!key) {
        throw new Error('Payment configuration is unavailable.');
      }

      const checkoutType =
        payment.checkoutType === 'subscription' || payment.kind === 'subscription'
          ? 'subscription'
          : 'order';

      const orderId =
        typeof payment.orderId === 'string' ? payment.orderId : undefined;

      const subscriptionId =
        typeof payment.subscriptionId === 'string'
          ? payment.subscriptionId
          : undefined;

      if (checkoutType === 'order' && !orderId) {
        throw new Error('Payment order was not created.');
      }

      if (checkoutType === 'subscription' && !subscriptionId) {
        throw new Error('Subscription checkout was not created.');
      }

      const handler = async (response: Record<string, string>) => {
        try {
          setError('');
          setMessage('Verifying your payment...');

          if (
            typeof response.razorpay_payment_id !== 'string' ||
            typeof response.razorpay_signature !== 'string'
          ) {
            throw new Error('Payment response was incomplete.');
          }

          const verifyPayload =
            checkoutType === 'subscription'
              ? {
                  checkoutType: 'subscription',
                  subscriptionId,
                  paymentId: response.razorpay_payment_id,
                  signature: response.razorpay_signature,
                }
              : {
                  checkoutType: 'order',
                  orderId,
                  paymentId: response.razorpay_payment_id,
                  signature: response.razorpay_signature,
                };

          const verifyResponse = await fetch('/api/payments/verify', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(verifyPayload),
          });

          const verified = await readJson(verifyResponse);

          setMessage(
            typeof verified.message === 'string'
              ? verified.message
              : checkoutType === 'subscription'
                ? 'Subscription activated successfully.'
                : 'Payment verified and credits added.'
          );

          await loadPlans();
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : 'Payment verification failed.'
          );
          setMessage('');
        } finally {
          setCheckoutPlan(null);
        }
      };

      const options: RazorpayOptions = {
        key,
        currency:
          typeof payment.currency === 'string' ? payment.currency : 'INR',
        name: 'Sales Intel AI',
        description:
          checkoutType === 'subscription'
            ? `${plan.name} monthly subscription`
            : `${plan.name} credit package`,
        prefill: {
          name,
          email,
        },
        theme: {
          color: '#f59e0b',
        },
        handler,
        modal: {
          ondismiss: () => {
            setCheckoutPlan(null);
            setMessage('');
          },
        },
      };

      if (checkoutType === 'subscription') {
        options.subscription_id = subscriptionId;
      } else {
        const amount =
          typeof payment.amount === 'number'
            ? payment.amount
            : Number(payment.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('Invalid payment amount.');
        }

        options.amount = amount;
        options.order_id = orderId;
      }

      const razorpay = new window.Razorpay(options);
      razorpay.open();
    } catch (err) {
      setCheckoutPlan(null);
      setMessage('');
      setError(err instanceof Error ? err.message : 'Unable to start checkout.');
    }
  }

  async function handleRefresh(event?: FormEvent) {
    event?.preventDefault();
    await loadPlans();
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-amber-400">
              Billing
            </p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Choose your Sales Intel AI plan
            </h1>
            <p className="mt-3 max-w-2xl text-slate-400">
              Use credits to generate sales intelligence reports. Monthly
              subscriptions renew through Razorpay; one-time plans do not.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-slate-500 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {(error || message) && (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
              error
                ? 'border-red-900/70 bg-red-950/30 text-red-300'
                : 'border-emerald-900/70 bg-emerald-950/30 text-emerald-300'
            }`}
            role={error ? 'alert' : 'status'}
          >
            {error || message}
          </div>
        )}

        {loading ? (
          <div className="flex min-h-48 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
          </div>
        ) : plans.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
            <p className="font-semibold">No paid plans are currently available.</p>
            <p className="mt-2 text-sm text-slate-400">
              Please try again later.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {plans.map((plan) => {
              const monthly = isMonthly(plan);
              const busy = checkoutPlan === plan.id;

              return (
                <section
                  key={plan.id}
                  className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl"
                >
                  <div className="mb-6 flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-bold">{plan.name}</h2>
                      {plan.description && (
                        <p className="mt-2 text-sm text-slate-400">
                          {plan.description}
                        </p>
                      )}
                    </div>

                    <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-300">
                      {monthly ? 'Monthly' : 'One-time'}
                    </span>
                  </div>

                  <div className="mb-6">
                    <span className="text-4xl font-bold">
                      ₹{plan.price_inr.toLocaleString('en-IN')}
                    </span>
                    {monthly && (
                      <span className="ml-2 text-sm text-slate-400">/ month</span>
                    )}
                  </div>

                  <ul className="mb-8 space-y-3 text-sm text-slate-300">
                    <li className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {plan.credits.toLocaleString('en-IN')} report credits
                    </li>
                    <li className="flex gap-2">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      Secure server-side payment verification
                    </li>
                    <li className="flex gap-2">
                      <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {monthly
                        ? 'Automatic monthly renewal through Razorpay'
                        : 'No automatic renewal'}
                    </li>
                  </ul>

                  <button
                    type="button"
                    disabled={Boolean(checkoutPlan)}
                    onClick={() => void startCheckout(plan)}
                    className="mt-auto inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" />
                        Opening checkout...
                      </>
                    ) : monthly ? (
                      'Subscribe Monthly'
                    ) : (
                      'Buy Credits'
                    )}
                  </button>
                </section>
              );
            })}
          </div>
        )}

        <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-xs leading-5 text-slate-500">
          Payments are processed by Razorpay. Your card/UPI/payment credentials
          are entered in Razorpay Checkout and are not stored by Sales Intel AI.
          Monthly subscriptions can be cancelled according to the subscription
          terms configured for the account.
        </div>
      </div>
    </main>
  );
}
