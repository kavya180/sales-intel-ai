import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getCreditAccount, getTransactions } from '@/lib/credits';
import { isPostgresConfigured } from '@/lib/db';

export async function GET() {
  try {
    const user = await requireUser();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Credit balance is temporarily unavailable.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    const [account, transactions] = await Promise.all([
      getCreditAccount(user.id),
      getTransactions(user.id, 50),
    ]);

    return NextResponse.json(
      {
        balance: account.balance,
        totalEarned: account.total_earned,
        totalConsumed: account.total_consumed,
        transactions,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
        },
      }
    );
  } catch (err: unknown) {
    console.error('Failed to fetch credit balance:', err);

    const isProduction = process.env.NODE_ENV === 'production';

    return NextResponse.json(
      {
        error: isProduction
          ? 'Credit balance is temporarily unavailable.'
          : err instanceof Error
            ? err.message
            : 'Failed to fetch credit balance.',
      },
      {
        status: isProduction ? 503 : 401,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
