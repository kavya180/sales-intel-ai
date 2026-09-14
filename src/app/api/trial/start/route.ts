import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { isPostgresConfigured } from '@/lib/db';
import { startFreeTrial, getTrialStatus } from '@/lib/trial';

export async function POST() {
  try {
    const user = await requireUser();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Trial activation is temporarily unavailable.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    const trialRecord = await startFreeTrial(user.id);
    const status = await getTrialStatus(user.id);

    return NextResponse.json(
      {
        success: true,
        message:
          '1-Month Free Trial activated successfully. 25 AI Intelligence credits added to your account.',
        trial: trialRecord,
        status,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' },
      }
    );
  } catch (err: unknown) {
    console.error('Trial activation failed:', err);

    const isProduction = process.env.NODE_ENV === 'production';

    return NextResponse.json(
      {
        error: isProduction
          ? 'Unable to activate the free trial.'
          : err instanceof Error
            ? err.message
            : 'Failed to activate trial.',
      },
      {
        status: isProduction ? 500 : 400,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
