import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { dbQuery, isPostgresConfigured, memDb } from '@/lib/db';
import { createAuditLogAsync } from '@/lib/audit';

const PlanUpdateSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    price_inr: z.number().finite().nonnegative().max(10_000_000).optional(),
    credits: z.number().int().nonnegative().max(10_000_000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.price_inr !== undefined ||
      data.credits !== undefined ||
      data.active !== undefined,
    { message: 'At least one plan field must be supplied.' }
  );

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Plan configuration is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON request body.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const parsed = PlanUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid plan parameters.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { id, price_inr, credits, active } = parsed.data;

    if (isPostgresConfigured) {
      const existing = await dbQuery(
        `SELECT id FROM plans WHERE id = $1 LIMIT 1`,
        [id]
      );

      if (!existing || !existing.rows[0]) {
        return NextResponse.json(
          { error: 'Plan not found.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      const result = await dbQuery<{
        id: string;
        name: string;
        price_inr: number;
        credits: number;
        active: boolean;
      }>(
        `UPDATE plans
         SET
           price_inr = COALESCE($2, price_inr),
           credits = COALESCE($3, credits),
           active = COALESCE($4, active),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, name, price_inr, credits, active`,
        [id, price_inr ?? null, credits ?? null, active ?? null]
      );

      if (!result || !result.rows[0]) {
        throw new Error('Failed to update plan.');
      }

      await createAuditLogAsync({
        userId: admin.id,
        action: 'plan_configuration_updated',
        resource: 'plans',
        details: {
          planId: id,
          price_inr,
          credits,
          active,
        },
      });

      return NextResponse.json(
        { success: true, plan: result.rows[0] },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const plan = memDb.plans.get(id);

    if (!plan) {
      return NextResponse.json(
        { error: 'Plan not found.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (price_inr !== undefined) plan.price_inr = price_inr;
    if (credits !== undefined) plan.credits = credits;
    if (active !== undefined) plan.active = active;

    await createAuditLogAsync({
      userId: admin.id,
      action: 'plan_configuration_updated',
      resource: 'plans',
      details: { planId: id, price_inr, credits, active },
    });

    return NextResponse.json(
      { success: true, plan },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    console.error('Admin plan update failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Plan configuration failed.'
            : err instanceof Error
              ? err.message
              : 'Plan update failed.',
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
