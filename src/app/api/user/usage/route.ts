import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { dbQuery, isPostgresConfigured, memDb } from '@/lib/db';

type UsageRecord = {
  id: string;
  user_id: string;
  credits_deducted: number;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  feature: string;
  input_summary: Record<string, unknown>;
  created_at: string;
};

export async function GET() {
  try {
    const user = await requireUser();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Usage data is temporarily unavailable.' },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        }
      );
    }

    let records: UsageRecord[];

    if (isPostgresConfigured) {
      const result = await dbQuery<UsageRecord>(
        `SELECT
          id,
          user_id,
          credits_deducted,
          model,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          feature,
          input_summary,
          created_at
         FROM usage_records
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [user.id, 50]
      );

      if (!result) {
        throw new Error('Failed to fetch usage records.');
      }

      records = result.rows;
    } else {
      // Development/test fallback only. Production is blocked above.
      records = memDb.usageRecords
        .filter((record) => record.user_id === user.id)
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() -
            new Date(a.created_at).getTime()
        )
        .slice(0, 50);
    }

    return NextResponse.json(
      { usage: records },
      {
        status: 200,
        headers: {
          'Cache-Control': 'private, no-store',
        },
      }
    );
  } catch (err: unknown) {
    console.error('Failed to fetch usage records:', err);

    const isProduction = process.env.NODE_ENV === 'production';

    return NextResponse.json(
      {
        error: isProduction
          ? 'Usage data is temporarily unavailable.'
          : err instanceof Error
            ? err.message
            : 'Failed to fetch usage data.',
      },
      {
        status: isProduction ? 503 : 401,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
