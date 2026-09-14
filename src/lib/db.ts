import { Pool, QueryResult, QueryResultRow } from 'pg';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type {
  UserProfile,
  Plan,
  TrialRecord,
  Entitlement,
  CreditAccount,
  CreditTransaction,
  PaymentRecord,
  KnowledgeDocument,
  KnowledgeChunk,
  AuditLog,
} from '@/types';

const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;

// ==============================================================================
// 1. PostgreSQL Production Connection Pool
// ==============================================================================
let pgPool: Pool | null = null;
export const isPostgresConfigured = Boolean(connectionString);

if (connectionString) {
  try {
    pgPool = new Pool({
      connectionString,
      ssl: isProduction ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  } catch (err) {
    console.error('Failed to initialize PostgreSQL connection pool:', err);
    pgPool = null;
  }
}

// In production, DATABASE_URL must be supplied. Silent fallback is strictly blocked.
export function validateDatabaseConfig(): void {
  if (isProduction && (!connectionString || connectionString.includes('localhost:5432/sales_objection_db'))) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production deployment requires a valid, persistent DATABASE_URL. ' +
      'In-memory storage is strictly prohibited in production.'
    );
  }
}

/**
 * Allows the in-memory adapter only outside production.
 * Production must fail closed rather than silently using process memory.
 */
function requireMemoryFallbackAllowed(): void {
  if (isProduction) {
    throw new Error(
      'CRITICAL: In-memory storage is disabled in production. Configure a persistent DATABASE_URL.'
    );
  }
}

// Do not execute validateDatabaseConfig() at module import time.
// Next.js imports route modules during `next build` to collect configuration,
// while DATABASE_URL is a runtime deployment secret. Runtime DB operations
// still fail closed when PostgreSQL is unavailable.

// Helper to execute parameterized queries safely against PostgreSQL
export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T> | null> {
  if (isProduction) {
    validateDatabaseConfig();
  }

  if (!pgPool) {
    if (isProduction) {
      throw new Error('CRITICAL: PostgreSQL pool is not initialized in production environment.');
    }
    return null;
  }
  try {
    return await pgPool.query<T>(text, params);
  } catch (err) {
    if (isProduction) {
      console.error('CRITICAL: PostgreSQL query execution failure:', err);
      throw err;
    }
    return null;
  }
}

// ==============================================================================
// 2. In-Memory Store (Development & Testing Fallback ONLY)
// ==============================================================================
class MemoryDatabase {
  public profiles: Map<string, UserProfile & { password_hash: string }> = new Map();
  public plans: Map<string, Plan> = new Map();
  public trials: Map<string, TrialRecord> = new Map();
  public entitlements: Map<string, Entitlement> = new Map();
  public creditAccounts: Map<string, CreditAccount> = new Map();
  public creditTransactions: CreditTransaction[] = [];
  public payments: Map<string, PaymentRecord> = new Map();
  public knowledgeDocuments: Map<string, KnowledgeDocument> = new Map();
  public knowledgeChunks: KnowledgeChunk[] = [];
  public auditLogs: AuditLog[] = [];
  public usageRecords: Array<{
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
  }> = [];

  constructor() {
    // Never create demo users, plans, credentials, or seed knowledge in production.
    // Production data belongs in PostgreSQL and is created by migrations/admin tooling.
    if (isProduction) return;
    this.seedDefaults();
  }

  public seedDefaults() {
    const defaultPlans: Plan[] = [
      {
        id: 'free',
        name: 'Always Free',
        type: 'free',
        active: true,
        price_inr: 0,
        currency: 'INR',
        duration_days: 0,
        credits: parseInt(process.env.DEFAULT_FREE_CREDITS || '5', 10),
        credit_renewal_behavior: 'none',
        features: [
          '5 Lifetime AI Credits',
          'Standard Sales Objection Handling',
          'Core B2B Discovery Questionnaire',
          'Export to Markdown & Text',
        ],
        limits: { max_credits: 5, requests_per_minute: 5 },
        trial_eligibility: true,
      },
      {
        id: 'trial_30d',
        name: 'Free 1-Month Trial',
        type: 'trial',
        active: true,
        price_inr: 0,
        currency: 'INR',
        duration_days: parseInt(process.env.DEFAULT_TRIAL_DAYS || '30', 10),
        credits: parseInt(process.env.DEFAULT_TRIAL_CREDITS || '25', 10),
        credit_renewal_behavior: 'none',
        features: [
          'Full Pro Access for 30 Days',
          '25 AI Intelligence Credits',
          'Manuj Bajaj Video Transcript RAG Retrieval',
          'Deep Objection & Root-Cause Analysis',
          'Custom Response Scripting',
        ],
        limits: { max_credits: 25, trial_days: 30, requests_per_minute: 10 },
        trial_eligibility: false,
      },
      {
        id: 'monthly_pro',
        name: 'Monthly Pro Subscription',
        type: 'monthly',
        active: true,
        price_inr: 2499,
        currency: 'INR',
        duration_days: 30,
        credits: parseInt(process.env.DEFAULT_MONTHLY_CREDITS || '150', 10),
        credit_renewal_behavior: 'monthly_reset',
        features: [
          '150 Monthly AI Credits',
          'Full Proprietary Methodology Vector Search',
          'Multi-scenario Deal Sizing',
          'Priority LLM Processing & Low Latency',
          'Priority WhatsApp & Email Support',
        ],
        limits: { max_credits: 150, requests_per_minute: 20 },
        trial_eligibility: false,
        provider_plan_id: 'plan_monthly_pro_2499',
      },
      {
        id: 'onetime_pass',
        name: 'One-Time Growth Pass',
        type: 'onetime',
        active: true,
        price_inr: 6999,
        currency: 'INR',
        duration_days: 365,
        credits: parseInt(process.env.DEFAULT_ONETIME_CREDITS || '500', 10),
        credit_renewal_behavior: 'accumulate',
        features: [
          '500 Non-Expiring AI Credits',
          '1-Year Video Methodology RAG Access',
          'Complete Enterprise Objection Playbooks',
          'Commercial Buyer Psychology Profiles',
          'Early Access to New Features',
        ],
        limits: { max_credits: 500, requests_per_minute: 30 },
        trial_eligibility: false,
      },
    ];

    for (const plan of defaultPlans) {
      this.plans.set(plan.id, plan);
    }

    const adminEmail = process.env.INITIAL_ADMIN_EMAIL || 'admin@example.com';
    const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(32).toString('hex');
    const adminId = '00000000-0000-0000-0000-000000000001';

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(adminPassword, salt);

    this.profiles.set(adminId, {
      id: adminId,
      email: adminEmail,
      full_name: process.env.INITIAL_ADMIN_NAME || 'System Administrator',
      role: 'admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      password_hash: passwordHash,
    });

    this.creditAccounts.set(adminId, {
      id: 'acc-admin-01',
      user_id: adminId,
      balance: 10000,
      total_earned: 10000,
      total_consumed: 0,
      version: 1,
      updated_at: new Date().toISOString(),
    });

    const seedTranscript = `
Title: High-Ticket B2B Sales Objection Handling Framework
Speaker: Manuj Bajaj
Transcript:
When dealing with enterprise and high-ticket B2B sales (deals above ₹5 Lakh to ₹1 Crore+), objections are rarely about price. They are about risk and perceived certainty of ROI.
Rule 1: Never defend or justify your price immediately when the buyer says "Your price is too high".
Instead, isolate the objection: "Aside from the financial investment, is there anything else preventing us from moving forward with this transformation?"
Rule 2: Understand the difference between an Economic Buyer (CEO, MD, Business Owner) and a Functional Evaluator (Procurement, IT Manager). The Owner cares about top-line growth, speed of execution, and staying ahead of competitors. The Procurement Manager cares about vendor compliance, cost benchmarks, and avoiding blame if something breaks.
Rule 3: Use the 'Acknowledge, Clarify, Pivot' (ACP) technique.
When they say: "We are already working with another vendor", do not attack the vendor. Respond: "They have a respectable reputation in the market. Most of our current tier-1 clients were working with them too before discovering our 3x operational velocity. What is one capability you wish they delivered that they currently don't?"
Rule 4: In Govt and Institutional buying, decision cycles are long and bureaucratic. Never push urgency based on fake discounts. Align your proposal directly with their pre-allocated fiscal budget heads and compliance metrics.
Rule 5: Deal sizing determines buyer psychology. Under ₹1 Lakh deals require immediate emotional payoff and friction-free onboarding. ₹20 Lakh to ₹1 Crore+ deals require multi-stakeholder consensus, risk mitigation guarantees, and clear milestone-based stage gating.
`;

    const docId = 'doc-seed-manuj-001';
    const hash = crypto.createHash('sha256').update(seedTranscript).digest('hex');
    this.knowledgeDocuments.set(docId, {
      id: docId,
      title: 'High-Ticket B2B Sales Objection Handling Framework (Manuj Bajaj Video Transcript)',
      source_type: 'paste',
      content_hash: hash,
      raw_text: seedTranscript.trim(),
      total_chunks: 3,
      created_by: adminId,
      is_active: true,
      created_at: new Date().toISOString(),
    });

    const chunks = [
      'When dealing with enterprise and high-ticket B2B sales (deals above ₹5 Lakh to ₹1 Crore+), objections are rarely about price. They are about risk and perceived certainty of ROI. Rule 1: Never defend or justify your price immediately when the buyer says "Your price is too high". Instead, isolate the objection: "Aside from the financial investment, is there anything else preventing us from moving forward with this transformation?"',
      'Rule 2: Understand the difference between an Economic Buyer (CEO, MD, Business Owner) and a Functional Evaluator (Procurement, IT Manager). The Owner cares about top-line growth, speed of execution, and staying ahead of competitors. The Procurement Manager cares about vendor compliance, cost benchmarks, and avoiding blame if something breaks.',
      'Rule 3: Use the ACP (Acknowledge, Clarify, Pivot) technique. When they say "We are already working with another vendor", respond: "They have a respectable reputation in the market. Most of our current tier-1 clients were working with them too before discovering our 3x operational velocity. What is one capability you wish they delivered that they currently don\'t?" Deal sizing: ₹20L+ deals require multi-stakeholder consensus and risk mitigation.',
    ];

    chunks.forEach((c, idx) => {
      this.knowledgeChunks.push({
        id: `chunk-seed-${idx + 1}`,
        document_id: docId,
        chunk_index: idx,
        content: c,
        token_count: c.split(' ').length,
        created_at: new Date().toISOString(),
      });
    });
  }
}

// Global memory singleton for development / testing environments
const globalForDb = global as unknown as { __memDbInstance?: MemoryDatabase };
export const memDb = globalForDb.__memDbInstance || new MemoryDatabase();
if (!isProduction) {
  globalForDb.__memDbInstance = memDb;
}

// ==============================================================================
// 3. Authoritative Production Database Repository Functions
// ==============================================================================

export async function dbGetUserByEmail(email: string): Promise<(UserProfile & { password_hash: string }) | null> {
  const normalized = email.trim().toLowerCase();
  if (pgPool) {
    const res = await dbQuery<{
      id: string;
      email: string;
      password_hash: string;
      full_name: string | null;
      role: 'user' | 'admin';
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, email, password_hash, full_name, role, created_at, updated_at 
       FROM profiles 
       WHERE LOWER(email) = LOWER($1) 
       LIMIT 1`,
      [normalized]
    );
    if (res && res.rows.length > 0) {
      const r = res.rows[0];
      return {
        id: r.id,
        email: r.email,
        password_hash: r.password_hash,
        full_name: r.full_name,
        role: r.role,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    }
    return null;
  }

  if (isProduction) {
    throw new Error('Database pool unavailable in production');
  }

  for (const user of memDb.profiles.values()) {
    if (user.email.toLowerCase() === normalized) {
      return { ...user };
    }
  }
  return null;
}

export async function dbGetUserById(id: string): Promise<UserProfile | null> {
  if (pgPool) {
    const res = await dbQuery<{
      id: string;
      email: string;
      full_name: string | null;
      role: 'user' | 'admin';
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, email, full_name, role, created_at, updated_at 
       FROM profiles 
       WHERE id = $1 
       LIMIT 1`,
      [id]
    );
    if (res && res.rows.length > 0) {
      const r = res.rows[0];
      return {
        id: r.id,
        email: r.email,
        full_name: r.full_name,
        role: r.role,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    }
    return null;
  }

  if (isProduction) {
    throw new Error('Database pool unavailable in production');
  }

  const u = memDb.profiles.get(id);
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export async function dbCreateUser(user: UserProfile & { password_hash: string }): Promise<UserProfile> {
  const normalized = user.email.trim().toLowerCase();
  if (pgPool) {
    await dbQuery(
      `INSERT INTO profiles (id, email, password_hash, full_name, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user.id, normalized, user.password_hash, user.full_name, user.role, user.created_at, user.updated_at]
    );
    return {
      id: user.id,
      email: normalized,
      full_name: user.full_name,
      role: user.role,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  if (isProduction) {
    throw new Error('Database pool unavailable in production');
  }

  memDb.profiles.set(user.id, { ...user, email: normalized });
  return {
    id: user.id,
    email: normalized,
    full_name: user.full_name,
    role: user.role,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export async function dbGetAllPlans(): Promise<Plan[]> {
  if (pgPool) {
    const res = await dbQuery<Plan>(
      `SELECT id, name, type, active, price_inr, currency, duration_days, credits, 
              credit_renewal_behavior, features, limits, trial_eligibility, provider_plan_id
       FROM plans 
       WHERE active = true 
       ORDER BY price_inr ASC`
    );
    if (res) {
      return res.rows.map((p) => ({
        ...p,
        price_inr: Number(p.price_inr),
        credits: Number(p.credits),
        duration_days: Number(p.duration_days),
      }));
    }
  }

  requireMemoryFallbackAllowed();
  return Array.from(memDb.plans.values()).filter((p) => p.active);
}

export async function dbGetPlanById(planId: string): Promise<Plan | null> {
  if (pgPool) {
    const res = await dbQuery<Plan>(
      `SELECT id, name, type, active, price_inr, currency, duration_days, credits, 
              credit_renewal_behavior, features, limits, trial_eligibility, provider_plan_id
       FROM plans 
       WHERE id = $1 
       LIMIT 1`,
      [planId]
    );
    if (res) {
      if (res.rows.length === 0) return null;
      const p = res.rows[0];
      return {
        ...p,
        price_inr: Number(p.price_inr),
        credits: Number(p.credits),
        duration_days: Number(p.duration_days),
      };
    }
  }

  requireMemoryFallbackAllowed();
  const p = memDb.plans.get(planId);
  return p ? { ...p } : null;
}

export async function dbGetTrialByUserId(userId: string): Promise<TrialRecord | null> {
  if (pgPool) {
    const res = await dbQuery<TrialRecord>(
      `SELECT id, user_id, plan_id, status, started_at, expires_at, created_at 
       FROM trials 
       WHERE user_id = $1 
       LIMIT 1`,
      [userId]
    );
    if (res && res.rows.length > 0) {
      return res.rows[0];
    }
    return null;
  }

  requireMemoryFallbackAllowed();
  const t = memDb.trials.get(userId);
  return t ? { ...t } : null;
}

export async function dbCreateTrial(trial: TrialRecord): Promise<TrialRecord> {
  if (pgPool) {
    await dbQuery(
      `INSERT INTO trials (id, user_id, plan_id, status, started_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [trial.id, trial.user_id, trial.plan_id, trial.status, trial.started_at, trial.expires_at, trial.created_at]
    );
    return trial;
  }

  if (isProduction) {
    throw new Error('Database pool unavailable in production');
  }

  memDb.trials.set(trial.user_id, { ...trial });
  return trial;
}

export async function dbUpdateTrialStatus(userId: string, status: 'active' | 'expired' | 'cancelled'): Promise<void> {
  if (pgPool) {
    await dbQuery(
      `UPDATE trials SET status = $1 WHERE user_id = $2`,
      [status, userId]
    );
    return;
  }

  requireMemoryFallbackAllowed();
  const t = memDb.trials.get(userId);
  if (t) {
    t.status = status;
  }
}

export async function dbGetUserEntitlements(userId: string): Promise<Entitlement[]> {
  if (pgPool) {
    const res = await dbQuery<Entitlement>(
      `SELECT id, user_id, plan_id, type, valid_from, valid_until, is_active, source_reference, created_at 
       FROM entitlements 
       WHERE user_id = $1 AND is_active = true`,
      [userId]
    );
    if (res && res.rows.length > 0) {
      return res.rows;
    }
    return [];
  }

  requireMemoryFallbackAllowed();
  return Array.from(memDb.entitlements.values()).filter((e) => e.user_id === userId && e.is_active);
}

export async function dbUpsertEntitlement(entitlement: Entitlement): Promise<void> {
  if (pgPool) {
    await dbQuery(
      `INSERT INTO entitlements (id, user_id, plan_id, type, valid_from, valid_until, is_active, source_reference, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entitlement.id,
        entitlement.user_id,
        entitlement.plan_id,
        entitlement.type,
        entitlement.valid_from,
        entitlement.valid_until,
        entitlement.is_active,
        entitlement.source_reference || null,
        entitlement.created_at || new Date().toISOString(),
      ]
    );
    return;
  }

  requireMemoryFallbackAllowed();
  memDb.entitlements.set(`ent-${entitlement.user_id}-${entitlement.type}`, { ...entitlement });
}

export async function dbCreatePayment(payment: PaymentRecord): Promise<PaymentRecord> {
  if (pgPool) {
    await dbQuery(
      `INSERT INTO payments (id, user_id, plan_id, provider, order_id, payment_id, signature, amount_inr, currency, status, idempotency_key, raw_event, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (order_id) DO NOTHING`,
      [
        payment.id,
        payment.user_id,
        payment.plan_id,
        payment.provider,
        payment.order_id,
        payment.payment_id || null,
        payment.signature || null,
        payment.amount_inr,
        payment.currency,
        payment.status,
        payment.idempotency_key || null,
        payment.raw_event ? JSON.stringify(payment.raw_event) : null,
        payment.created_at,
      ]
    );
    return payment;
  }

  requireMemoryFallbackAllowed();
  memDb.payments.set(payment.order_id, { ...payment });
  return payment;
}

export async function dbGetPaymentByOrderId(orderId: string): Promise<PaymentRecord | null> {
  if (pgPool) {
    const res = await dbQuery<PaymentRecord>(
      `SELECT id, user_id, plan_id, provider, order_id, payment_id, signature, 
              amount_inr, currency, status, idempotency_key, raw_event, created_at 
       FROM payments 
       WHERE order_id = $1 
       LIMIT 1`,
      [orderId]
    );
    if (res && res.rows.length > 0) {
      const p = res.rows[0];
      return {
        ...p,
        amount_inr: Number(p.amount_inr),
      };
    }
    return null;
  }

  requireMemoryFallbackAllowed();
  const p = memDb.payments.get(orderId);
  return p ? { ...p } : null;
}

export async function dbUpdatePayment(payment: PaymentRecord): Promise<void> {
  if (pgPool) {
    await dbQuery(
      `UPDATE payments 
       SET status = $1, payment_id = $2, signature = $3, raw_event = $4, updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
       WHERE order_id = $5`,
      [
        payment.status,
        payment.payment_id || null,
        payment.signature || null,
        payment.raw_event ? JSON.stringify(payment.raw_event) : null,
        payment.order_id,
      ]
    );
    return;
  }

  requireMemoryFallbackAllowed();
  memDb.payments.set(payment.order_id, { ...payment });
}

export async function dbCreateAuditLog(log: AuditLog): Promise<AuditLog> {
  if (pgPool) {
    const result = await dbQuery<AuditLog>(
      `INSERT INTO audit_logs
        (id, user_id, action, resource, details_json, ip_hash, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id, user_id, action, resource, details_json, ip_hash, user_agent, created_at`,
      [
        log.id,
        log.user_id,
        log.action,
        log.resource,
        JSON.stringify(log.details_json ?? {}),
        log.ip_hash,
        log.user_agent,
        log.created_at,
      ]
    );

    if (!result || !result.rows[0]) {
      throw new Error('Failed to persist audit log.');
    }

    return result.rows[0];
  }

  requireMemoryFallbackAllowed();
  memDb.auditLogs.unshift({ ...log });
  if (memDb.auditLogs.length > 1000) {
    memDb.auditLogs.pop();
  }
  return { ...log };
}

export async function dbGetRecentAuditLogs(limit = 50): Promise<AuditLog[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));

  if (pgPool) {
    const result = await dbQuery<AuditLog>(
      `SELECT id, user_id, action, resource, details_json, ip_hash, user_agent, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [safeLimit]
    );
    return result?.rows ?? [];
  }

  requireMemoryFallbackAllowed();
  return memDb.auditLogs.slice(0, safeLimit);
}

export { pgPool };
