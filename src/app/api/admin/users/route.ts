import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import {
  dbGetUserEntitlements,
  dbQuery,
  isPostgresConfigured,
  memDb,
} from '@/lib/db';
import { getCreditAccount } from '@/lib/credits';
import { getTrialStatus } from '@/lib/trial';

type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: 'user' | 'admin';
  created_at: string;
};

export async function GET() {
  try {
    await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'User administration is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let profiles: ProfileRow[];

    if (isPostgresConfigured) {
      const result = await dbQuery<ProfileRow>(
        `SELECT id, email, full_name, role, created_at
         FROM profiles
         ORDER BY created_at DESC
         LIMIT $1`,
        [500]
      );

      if (!result) {
        throw new Error('Failed to fetch users.');
      }

      profiles = result.rows;
    } else {
      profiles = Array.from(memDb.profiles.values())
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() -
            new Date(a.created_at).getTime()
        )
        .slice(0, 500)
        .map((p) => ({
          id: p.id,
          email: p.email,
          full_name: p.full_name,
          role: p.role,
          created_at: p.created_at,
        }));
    }

    const usersList = await Promise.all(
      profiles.map(async (profile) => {
        const [credit, trial, entitlements] = await Promise.all([
          getCreditAccount(profile.id),
          getTrialStatus(profile.id),
          dbGetUserEntitlements(profile.id),
        ]);

        const now = Date.now();
        const activeEntitlements = entitlements.filter((e) => {
          if (!e.is_active) return false;
          if (!e.valid_until) return true;
          const expiry = new Date(e.valid_until).getTime();
          return Number.isFinite(expiry) && expiry > now;
        });

        return {
          id: profile.id,
          email: profile.email,
          full_name: profile.full_name,
          role: profile.role,
          created_at: profile.created_at,
          balance: credit.balance,
          total_consumed: credit.total_consumed,
          trialStatus: trial.isActive
            ? 'Active'
            : trial.isExpired
              ? 'Expired'
              : 'None',
          entitlements: activeEntitlements.map((e) => e.type),
        };
      })
    );

    return NextResponse.json(
      { users: usersList },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err: unknown) {
    console.error('Admin users request failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'User administration is temporarily unavailable.'
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
