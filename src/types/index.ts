export type UserRole = 'user' | 'admin';

export interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export type PlanType = 'free' | 'trial' | 'monthly' | 'onetime';

export interface Plan {
  id: string;
  name: string;
  type: PlanType;
  active: boolean;
  price_inr: number;
  currency: string;
  duration_days: number;
  credits: number;
  credit_renewal_behavior: 'none' | 'monthly_reset' | 'accumulate';
  features: string[];
  limits: Record<string, unknown>;
  trial_eligibility: boolean;
  provider_plan_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TrialRecord {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'expired' | 'cancelled';
  started_at: string;
  expires_at: string;
  created_at: string;
}

export interface Entitlement {
  id: string;
  user_id: string;
  plan_id: string;
  type: PlanType;
  valid_from: string;
  valid_until: string | null;
  is_active: boolean;
  source_reference?: string;
  created_at?: string;
}

export interface CreditAccount {
  id: string;
  user_id: string;
  balance: number;
  total_earned: number;
  total_consumed: number;
  version: number;
  updated_at: string;
}

export type TransactionType =
  | 'initial_free_credit'
  | 'trial_credit'
  | 'subscription_credit'
  | 'one_time_purchase'
  | 'usage'
  | 'admin_adjustment'
  | 'refund'
  | 'expiry';

export interface CreditTransaction {
  id: string;
  account_id: string;
  user_id: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  transaction_type: TransactionType;
  reason: string;
  reference_id?: string | null;
  idempotency_key?: string | null;
  created_at: string;
}

export interface PaymentRecord {
  id: string;
  user_id: string;
  plan_id: string;
  provider: 'razorpay';
  order_id: string;
  payment_id?: string | null;
  signature?: string | null;
  amount_inr: number;
  currency: string;
  status: 'created' | 'captured' | 'failed' | 'refunded';
  idempotency_key?: string | null;
  raw_event?: unknown;
  created_at: string;
}

export interface SalesReportInput {
  selling: string;
  target_industry: string;
  business_model: string;
  deal_size: string;
  buyer_type: string;
  additional_context?: string;
}

export interface SalesIntelligenceReport {
  summary: string;
  buyer_motivations: string[];
  likely_objections: Array<{
    objection: string;
    root_cause: string;
    recommended_strategy: string;
    scripted_response: string;
  }>;
  discovery_questions: string[];
  value_positioning: string[];
  perceived_risks: string[];
  suggested_next_steps: string[];
  knowledge_citations?: string[];
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source_type: 'txt' | 'paste' | 'pdf' | 'docx';
  content_hash: string;
  raw_text: string;
  total_chunks: number;
  created_by?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding?: number[];
  similarity?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface AuditLog {
  id: string;
  user_id?: string | null;
  action: string;
  resource: string;
  details_json: Record<string, unknown>;
  ip_hash?: string | null;
  user_agent?: string | null;
  created_at: string;
}
