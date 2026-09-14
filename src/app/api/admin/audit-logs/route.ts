import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import {
  getRecentAuditLogsAsync,
} from '@/lib/audit';
import { isPostgresConfigured } from '@/lib/db';

export async function GET() {
  try {
    await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Audit logs are temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const logs = await getRecentAuditLogsAsync(100);

    return NextResponse.json(
      { logs },
      {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' },
      }
    );
  } catch (err: unknown) {
    console.error('Admin audit log request failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Audit logs are temporarily unavailable.'
            : err instanceof Error
              ? err.message
              : 'Unauthorized',
      },
      {
        status: process.env.NODE_ENV === 'production' ? 503 : 403,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
