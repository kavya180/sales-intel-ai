import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { getCreditAccount } from '@/lib/credits';
import { getTrialStatus } from '@/lib/trial';
import { dbGetUserEntitlements, isPostgresConfigured } from '@/lib/db';

const isProduction = process.env.NODE_ENV === 'production';

export async function GET() {
  try {
    const user = await getCurrentUser();

    if (!user) {
      return NextResponse.json(
        {
          authenticated: false,
          user: null,
        },
        {
          status: 401,
          headers: {
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    if (isProduction && !isPostgresConfigured) {
      throw new Error(
        'FATAL CONFIGURATION ERROR: Production auth state requires PostgreSQL.'
      );
    }

    // All three values are resolved from the server-side authoritative stores.
    // Nothing is accepted from the browser as a balance, trial date, or role.
    const [creditAccount, trialStatus, entitlements] = await Promise.all([
      getCreditAccount(user.id),
      getTrialStatus(user.id),
      dbGetUserEntitlements(user.id),
    ]);

    const now = Date.now();

    // Return only currently usable entitlements. Expired time-bounded
    // entitlements are not presented as active even if cleanup has not yet run.
    const activeEntitlements = entitlements.filter((entitlement) => {
      if (!entitlement.is_active) return false;

      if (!entitlement.valid_until) return true;

      const expiry = new Date(entitlement.valid_until).getTime();
      return Number.isFinite(expiry) && now < expiry;
    });

    return NextResponse.json(
      {
        authenticated: true,
        user,
        creditAccount: {
          balance: creditAccount.balance,
          total_earned: creditAccount.total_earned,
          total_consumed: creditAccount.total_consumed,
        },
        trialStatus,
        entitlements: activeEntitlements,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
        },
      }
    );
  } catch (error) {
    console.error('Failed to load authenticated user state:', error);

    return NextResponse.json(
      {
        authenticated: false,
        user: null,
        error: 'Unable to load your account state. Please sign in again.',
      },
      {
        status: isProduction ? 503 : 500,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}
