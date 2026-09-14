'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Check,
  Clock3,
  CreditCard,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

type Plan = {
  id: string;
  name: string;
  description?: string | null;
  type?: string | null;
  price_inr: number;
  billing_period?: string | null;
  credits: number;
  is_active?: boolean;
};

function isMonthly(plan: Plan) {
  return String(plan.type ?? plan.billing_period ?? '').toLowerCase() === 'monthly';
}

function isFree(plan: Plan) {
  return Number(plan.price_inr) === 0;
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

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingTrial, setStartingTrial] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

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

      const validPlans = received.filter((plan): plan is Plan => {
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
      });

      setPlans(validPlans);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load pricing.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlans();
  }, []);

  async function startTrial() {
    setStartingTrial(true);
    setError('');
    setMessage('');

    try {
      const response = await fetch('/api/trial/start', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const data = await readJson(response);

      setMessage(
        typeof data.message === 'string'
          ? data.message
          : 'Your free trial has started.'
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to start your free trial.'
      );
    } finally {
      setStartingTrial(false);
    }
  }

  const freePlans = plans.filter(isFree);
  const paidPlans = plans.filter((plan) => !isFree(plan));
  const monthlyPlans = paidPlans.filter(isMonthly);
  const oneTimePlans = paidPlans.filter((plan) => !isMonthly(plan));

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-12 text-slate-100 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <header className="mx-auto max-w-3xl text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-4 py-2 text-sm font-semibold text-amber-300">
            <Sparkles className="h-4 w-4" />
            Simple, credit-based pricing
          </div>

          <h1 className="text-4xl font-black tracking-tight sm:text-5xl">
            Choose how you want to use Sales Intel AI
          </h1>

          <p className="mt-5 text-base leading-7 text-slate-400 sm:text-lg">
            Start free, try the full workflow for a month, subscribe monthly,
            or buy credits once. One generated Sales Intelligence Report uses
            one credit.
          </p>
        </header>

        {(error || message) && (
          <div
            className={`mx-auto mt-8 max-w-3xl rounded-xl border px-4 py-3 text-sm ${
              error
                ? 'border-red-900/70 bg-red-950/30 text-red-300'
                : 'border-emerald-900/70 bg-emerald-950/30 text-emerald-300'
            }`}
            role={error ? 'alert' : 'status'}
          >
            {error || message}
          </div>
        )}

        <section className="mt-12 grid gap-6 lg:grid-cols-4">
          <article className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
            <div className="mb-6">
              <span className="inline-flex rounded-full bg-slate-800 px-3 py-1 text-xs font-bold uppercase tracking-wide text-slate-300">
                Always Free
              </span>
              <h2 className="mt-4 text-2xl font-bold">Free</h2>
              <p className="mt-2 text-sm text-slate-400">
                Keep using the core assistant without a subscription.
              </p>
            </div>

            <div className="mb-6">
              <span className="text-4xl font-black">₹0</span>
              <span className="ml-2 text-sm text-slate-500">forever</span>
            </div>

            <ul className="mb-8 space-y-3 text-sm text-slate-300">
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                Core Sales Intelligence workflow
              </li>
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                Credits are consumed per report
              </li>
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                No recurring payment
              </li>
            </ul>

            <Link
              href="/assistant"
              className="mt-auto inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-5 py-3 font-bold text-slate-100 transition hover:border-slate-500"
            >
              Use Free
            </Link>
          </article>

          <article className="flex flex-col rounded-2xl border border-amber-400/40 bg-gradient-to-b from-amber-400/10 to-slate-900 p-6 shadow-2xl shadow-amber-950/20">
            <div className="mb-6">
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-400 px-3 py-1 text-xs font-black uppercase tracking-wide text-slate-950">
                <Clock3 className="h-3.5 w-3.5" />
                1 Month Trial
              </span>
              <h2 className="mt-4 text-2xl font-bold">Free Trial</h2>
              <p className="mt-2 text-sm text-slate-300">
                Try the paid-level workflow before choosing a payment plan.
              </p>
            </div>

            <div className="mb-6">
              <span className="text-4xl font-black">₹0</span>
              <span className="ml-2 text-sm text-slate-400">for 30 days</span>
            </div>

            <ul className="mb-8 space-y-3 text-sm text-slate-300">
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                Trial credits configured by the service
              </li>
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                Server-side expiry
              </li>
              <li className="flex gap-2">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                No card required to start
              </li>
            </ul>

            <button
              type="button"
              onClick={() => void startTrial()}
              disabled={startingTrial}
              className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {startingTrial ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                'Start Free Trial'
              )}
            </button>
          </article>

          <article className="flex flex-col rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
            <div className="mb-6">
              <span className="inline-flex rounded-full bg-blue-400/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-blue-300">
                Monthly Subscription
              </span>
              <h2 className="mt-4 text-2xl font-bold">Subscribe</h2>
              <p className="mt-2 text-sm text-slate-400">
                Recurring monthly billing through Razorpay.
              </p>
            </div>

            <div className="space-y-4">
              {loading ? (
                <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
              ) : monthlyPlans.length ? (
                monthlyPlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-bold">{plan.name}</h3>
                        {plan.description && (
                          <p className="mt-1 text-xs text-slate-500">
                            {plan.description}
                          </p>
                        )}
                      </div>
                      <span className="whitespace-nowrap font-bold">
                        ₹{plan.price_inr.toLocaleString('en-IN')}/mo
                      </span>
                    </div>

                    <p className="mt-3 text-sm text-slate-400">
                      {plan.credits.toLocaleString('en-IN')} credits per billing
                      cycle
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">
                  No monthly plans are currently available.
                </p>
              )}
            </div>

            <Link
              href="/billing"
              className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-500 px-5 py-3 font-bold text-white transition hover:bg-blue-400"
            >
              <CreditCard className="h-4 w-4" />
              View Monthly Plans
            </Link>
          </article>

          <article className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
            <div className="mb-6">
              <span className="inline-flex rounded-full bg-violet-400/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-violet-300">
                One-Time Purchase
              </span>
              <h2 className="mt-4 text-2xl font-bold">Buy Credits</h2>
              <p className="mt-2 text-sm text-slate-400">
                Pay once and use the purchased credits without automatic
                renewal.
              </p>
            </div>

            <div className="space-y-4">
              {loading ? (
                <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
              ) : oneTimePlans.length ? (
                oneTimePlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-bold">{plan.name}</h3>
                        {plan.description && (
                          <p className="mt-1 text-xs text-slate-500">
                            {plan.description}
                          </p>
                        )}
                      </div>
                      <span className="whitespace-nowrap font-bold">
                        ₹{plan.price_inr.toLocaleString('en-IN')}
                      </span>
                    </div>

                    <p className="mt-3 text-sm text-slate-400">
                      {plan.credits.toLocaleString('en-IN')} credits
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">
                  No one-time plans are currently available.
                </p>
              )}
            </div>

            <Link
              href="/billing"
              className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-violet-400/40 px-5 py-3 font-bold text-violet-200 transition hover:border-violet-300 hover:bg-violet-400/10"
            >
              <CreditCard className="h-4 w-4" />
              View One-Time Plans
            </Link>
          </article>
        </section>

        <section className="mx-auto mt-12 max-w-4xl rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-lg font-bold">How credits work</h2>
          <div className="mt-4 grid gap-4 text-sm text-slate-400 sm:grid-cols-3">
            <div>
              <p className="font-semibold text-slate-200">1 credit = 1 report</p>
              <p className="mt-1">Credits are deducted server-side when a report is generated.</p>
            </div>
            <div>
              <p className="font-semibold text-slate-200">Monthly</p>
              <p className="mt-1">A confirmed recurring charge grants the configured monthly credits.</p>
            </div>
            <div>
              <p className="font-semibold text-slate-200">One-time</p>
              <p className="mt-1">Purchased credits are granted after successful payment verification.</p>
            </div>
          </div>
        </section>

        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => void loadPlans()}
            disabled={loading}
            className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh pricing
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-slate-600">
          Monthly subscriptions and one-time purchases are processed through
          Razorpay Checkout. No payment credentials are stored by the
          application.
        </p>
      </div>
    </main>
  );
}
