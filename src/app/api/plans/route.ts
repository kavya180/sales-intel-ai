import { NextResponse } from 'next/server';
import { dbGetAllPlans, isPostgresConfigured } from '@/lib/db';

export async function GET() {
  try {
    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Plans are temporarily unavailable.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    const plans = await dbGetAllPlans();

    return NextResponse.json(
      { plans },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
        },
      }
    );
  } catch (err: unknown) {
    console.error('Failed to fetch plans:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Plans are temporarily unavailable.'
            : err instanceof Error
              ? err.message
              : 'Failed to fetch plans.',
      },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
