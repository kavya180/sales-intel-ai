-- ==============================================================================
-- Sales Objection Handling Assistant - Production PostgreSQL Schema
-- PostgreSQL is the authoritative production datastore.
-- Supports pgvector, UTC timestamps, trial tracking, credit ledger,
-- Razorpay payments, subscriptions, transcript knowledge, and audit logs.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 1. PROFILES & ROLES
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_lower
    ON profiles (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- 2. PLANS
CREATE TABLE IF NOT EXISTS plans (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL
        CHECK (type IN ('free', 'trial', 'monthly', 'onetime')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    price_inr NUMERIC(10, 2) NOT NULL DEFAULT 0.00
        CHECK (price_inr >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    duration_days INT NOT NULL DEFAULT 0
        CHECK (duration_days >= 0),
    credits INT NOT NULL DEFAULT 0
        CHECK (credits >= 0),
    credit_renewal_behavior VARCHAR(50) NOT NULL DEFAULT 'none'
        CHECK (credit_renewal_behavior IN ('none', 'monthly_reset', 'accumulate')),
    features JSONB NOT NULL DEFAULT '[]'::jsonb,
    limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    trial_eligibility BOOLEAN NOT NULL DEFAULT FALSE,
    -- Razorpay Plan ID used for recurring monthly subscriptions.
    -- NULL for Free, Trial and One-Time plans.
    provider_plan_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. TRIALS
CREATE TABLE IF NOT EXISTS trials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) NOT NULL REFERENCES plans(id),
    status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (expires_at > started_at)
);

CREATE INDEX IF NOT EXISTS idx_trials_expires_at ON trials(expires_at);

-- 4. SUBSCRIPTIONS
-- A row represents the user's recurring Razorpay subscription.
-- Monthly credits are granted per successful subscription charge, not merely
-- once when the subscription is created.
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) NOT NULL REFERENCES plans(id),
    provider_subscription_id VARCHAR(100) UNIQUE,
    provider_customer_id VARCHAR(100),
    -- Razorpay subscription lifecycle status is mirrored here.
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'halted', 'cancelled', 'completed', 'expired')),
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    current_period_end TIMESTAMPTZ NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (current_period_end > current_period_start)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub
    ON subscriptions(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
    ON subscriptions(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_active_per_plan
    ON subscriptions(user_id, plan_id)
    WHERE status IN ('pending', 'active');

-- 5. ENTITLEMENTS
CREATE TABLE IF NOT EXISTS entitlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) NOT NULL REFERENCES plans(id),
    type VARCHAR(50) NOT NULL
        CHECK (type IN ('free', 'trial', 'monthly', 'onetime')),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    source_reference VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entitlements_user_active
    ON entitlements(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_entitlements_validity
    ON entitlements(user_id, valid_from, valid_until);

-- 6. CREDIT ACCOUNTS
CREATE TABLE IF NOT EXISTS credit_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    balance INT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    total_earned INT NOT NULL DEFAULT 0 CHECK (total_earned >= 0),
    total_consumed INT NOT NULL DEFAULT 0 CHECK (total_consumed >= 0),
    version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_user
    ON credit_accounts(user_id);

-- 7. CREDIT TRANSACTIONS
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id UUID NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    amount INT NOT NULL CHECK (amount <> 0),
    balance_before INT NOT NULL CHECK (balance_before >= 0),
    balance_after INT NOT NULL CHECK (balance_after >= 0),
    transaction_type VARCHAR(50) NOT NULL
        CHECK (transaction_type IN (
            'initial_free_credit',
            'trial_credit',
            'subscription_credit',
            'one_time_purchase',
            'usage',
            'admin_adjustment',
            'refund',
            'expiry'
        )),
    reason TEXT NOT NULL,
    reference_id VARCHAR(100),
    idempotency_key VARCHAR(150) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_user_created
    ON credit_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_tx_account_created
    ON credit_transactions(account_id, created_at DESC);

-- 8. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) NOT NULL REFERENCES plans(id),
    provider VARCHAR(50) NOT NULL DEFAULT 'razorpay',
    -- One-time payments have an order_id. Subscription charges may not.
    order_id VARCHAR(100) UNIQUE,
    payment_id VARCHAR(100) UNIQUE,
    provider_subscription_id VARCHAR(100),
    provider_event_id VARCHAR(150),
    payment_type VARCHAR(30) NOT NULL DEFAULT 'one_time'
        CHECK (payment_type IN ('one_time', 'subscription')),
    signature VARCHAR(255),
    amount_inr NUMERIC(10, 2) NOT NULL CHECK (amount_inr > 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    status VARCHAR(50) NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'captured', 'failed', 'refunded')),
    idempotency_key VARCHAR(150) UNIQUE,
    raw_event JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_subscription_id
    ON payments(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_event_id
    ON payments(provider_event_id);

-- Webhook event IDs are globally unique. This is the database-level
-- idempotency boundary for Razorpay webhook retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_event_unique
    ON payments(provider, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

-- 9. PAYMENT WEBHOOK EVENTS
-- Stores every processed Razorpay webhook event exactly once.
-- Lifecycle events such as subscription.activated/cancelled may not have
-- a payment row, so webhook idempotency needs its own durable table.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(50) NOT NULL DEFAULT 'razorpay',
    event_id VARCHAR(150) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    provider_subscription_id VARCHAR(100),
    provider_payment_id VARCHAR(100),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_subscription
    ON payment_webhook_events(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type_created
    ON payment_webhook_events(event_type, processed_at DESC);

-- 10. USAGE RECORDS
CREATE TABLE IF NOT EXISTS usage_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    prompt_tokens INT NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens INT NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    total_tokens INT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    credits_deducted INT NOT NULL DEFAULT 1 CHECK (credits_deducted >= 0),
    model VARCHAR(100) NOT NULL,
    feature VARCHAR(100) NOT NULL DEFAULT 'sales_intelligence_report',
    input_summary JSONB,
    latency_ms INT CHECK (latency_ms IS NULL OR latency_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_usage_user_created
    ON usage_records(user_id, created_at DESC);

-- 10. KNOWLEDGE DOCUMENTS
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    source_type VARCHAR(50) NOT NULL
        CHECK (source_type IN ('txt', 'paste', 'pdf', 'docx')),
    content_hash VARCHAR(64) NOT NULL UNIQUE,
    raw_text TEXT NOT NULL,
    total_chunks INT NOT NULL DEFAULT 0 CHECK (total_chunks >= 0),
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 11. KNOWLEDGE CHUNKS
-- IMPORTANT: 768 must match the embedding model configured in src/lib/rag.ts.
-- If the application uses a different embedding model/dimension, this column
-- and its index must be migrated to the matching dimension.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    token_count INT NOT NULL DEFAULT 0 CHECK (token_count >= 0),
    embedding vector(768),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc
    ON knowledge_chunks(document_id);

-- Create the HNSW vector index only when supported by the installed pgvector.
-- Standard pgvector installations support vector_cosine_ops.
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
    ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

-- 12. AUDIT LOGS
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(100) NOT NULL,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_hash VARCHAR(64),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_created
    ON audit_logs(user_id, created_at DESC);

-- ==============================================================================
-- PAYMENT/SUBSCRIPTION COMPATIBILITY MIGRATION
-- ==============================================================================
-- The CREATE TABLE definitions above cover fresh databases. These ALTER
-- statements also upgrade databases created by the previous schema version.
-- They are intentionally additive/idempotent.

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS provider_plan_id VARCHAR(100);

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS provider_customer_id VARCHAR(100);

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS provider_subscription_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS provider_event_id VARCHAR(150),
    ADD COLUMN IF NOT EXISTS payment_type VARCHAR(30) NOT NULL DEFAULT 'one_time';

ALTER TABLE payments
    ALTER COLUMN order_id DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payments_payment_type_check'
    ) THEN
        ALTER TABLE payments
            ADD CONSTRAINT payments_payment_type_check
            CHECK (payment_type IN ('one_time', 'subscription'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_payments_subscription_id
    ON payments(provider_subscription_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_event_unique
    ON payments(provider, provider_event_id)
    WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
    ON subscriptions(user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_active_per_plan
    ON subscriptions(user_id, plan_id)
    WHERE status IN ('pending', 'active');

CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider VARCHAR(50) NOT NULL DEFAULT 'razorpay',
    event_id VARCHAR(150) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    provider_subscription_id VARCHAR(100),
    provider_payment_id VARCHAR(100),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_subscription
    ON payment_webhook_events(provider_subscription_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_type_created
    ON payment_webhook_events(event_type, processed_at DESC);

-- ==============================================================================
-- DEFAULT PLAN DATA
-- ==============================================================================

INSERT INTO plans (
    id, name, type, active, price_inr, currency, duration_days, credits,
    credit_renewal_behavior, features, limits, trial_eligibility
)
VALUES
(
    'free',
    'Always Free',
    'free',
    TRUE,
    0.00,
    'INR',
    0,
    5,
    'none',
    '["5 Lifetime AI Credits", "Standard Sales Objection Handling", "Community Support", "Basic Discovery Guide"]'::jsonb,
    '{"max_credits": 5, "requests_per_minute": 5}'::jsonb,
    TRUE
),
(
    'trial_30d',
    'Free 1-Month Trial',
    'trial',
    TRUE,
    0.00,
    'INR',
    30,
    25,
    'none',
    '["Full Access for 30 Days", "25 AI Credits", "Manuj Bajaj Video Transcript RAG", "Deep Objection Analysis", "Value Positioning Strategy"]'::jsonb,
    '{"max_credits": 25, "trial_days": 30, "requests_per_minute": 10}'::jsonb,
    FALSE
),
(
    'monthly_pro',
    'Monthly Pro Subscription',
    'monthly',
    TRUE,
    2499.00,
    'INR',
    30,
    150,
    'monthly_reset',
    '["150 Monthly AI Credits", "Full Video Methodology RAG Access", "Priority Prompt Processing", "Export to PDF & Markdown", "Priority Email Support"]'::jsonb,
    '{"max_credits": 150, "requests_per_minute": 20}'::jsonb,
    FALSE
),
(
    'onetime_pass',
    'One-Time Growth Pass',
    'onetime',
    TRUE,
    6999.00,
    'INR',
    365,
    500,
    'accumulate',
    '["500 Non-Expiring AI Credits", "1-Year Knowledge Base Retrieval", "Full Objection Handling Playbooks", "Dedicated Implementation Guide"]'::jsonb,
    '{"max_credits": 500, "requests_per_minute": 30}'::jsonb,
    FALSE
)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    active = EXCLUDED.active,
    price_inr = EXCLUDED.price_inr,
    currency = EXCLUDED.currency,
    duration_days = EXCLUDED.duration_days,
    credits = EXCLUDED.credits,
    credit_renewal_behavior = EXCLUDED.credit_renewal_behavior,
    features = EXCLUDED.features,
    limits = EXCLUDED.limits,
    trial_eligibility = EXCLUDED.trial_eligibility,
    updated_at = CURRENT_TIMESTAMP;

-- ==============================================================================
-- CREDIT ATOMIC FUNCTIONS
-- These are the production concurrency boundary.
-- They lock the user's credit row inside PostgreSQL.
-- ==============================================================================

CREATE OR REPLACE FUNCTION atomic_deduct_credits(
    p_user_id UUID,
    p_amount INT,
    p_reason TEXT,
    p_reference_id VARCHAR(100) DEFAULT NULL,
    p_idempotency_key VARCHAR(150) DEFAULT NULL
)
RETURNS TABLE (
    success BOOLEAN,
    balance INT,
    transaction_id UUID,
    error_message TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_account credit_accounts%ROWTYPE;
    v_existing credit_transactions%ROWTYPE;
    v_before INT;
    v_after INT;
    v_tx_id UUID;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit deduction amount must be positive.';
        RETURN;
    END IF;

    IF p_amount > 1000000 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit deduction amount exceeds the maximum.';
        RETURN;
    END IF;

    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Transaction reason is required.';
        RETURN;
    END IF;

    -- Idempotency is checked inside the same database transaction.
    IF p_idempotency_key IS NOT NULL THEN
        SELECT *
        INTO v_existing
        FROM credit_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            IF v_existing.user_id <> p_user_id THEN
                RETURN QUERY SELECT FALSE, 0, NULL::UUID,
                    'Idempotency key belongs to a different user.';
                RETURN;
            END IF;

            RETURN QUERY SELECT
                TRUE,
                v_existing.balance_after,
                v_existing.id,
                NULL::TEXT;
            RETURN;
        END IF;
    END IF;

    SELECT *
    INTO v_account
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit account not found.';
        RETURN;
    END IF;

    IF v_account.balance < p_amount THEN
        RETURN QUERY SELECT
            FALSE,
            v_account.balance,
            NULL::UUID,
            format(
                'Insufficient credits. Required: %s, Available: %s',
                p_amount,
                v_account.balance
            );
        RETURN;
    END IF;

    v_before := v_account.balance;
    v_after := v_before - p_amount;
    v_tx_id := uuid_generate_v4();

    UPDATE credit_accounts
    SET
        balance = v_after,
        total_consumed = total_consumed + p_amount,
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = v_account.id;

    INSERT INTO credit_transactions (
        id, account_id, user_id, amount, balance_before, balance_after,
        transaction_type, reason, reference_id, idempotency_key
    )
    VALUES (
        v_tx_id, v_account.id, p_user_id, -p_amount, v_before, v_after,
        'usage', p_reason, p_reference_id, p_idempotency_key
    );

    RETURN QUERY SELECT TRUE, v_after, v_tx_id, NULL::TEXT;

EXCEPTION
    WHEN unique_violation THEN
        IF p_idempotency_key IS NOT NULL THEN
            SELECT *
            INTO v_existing
            FROM credit_transactions
            WHERE idempotency_key = p_idempotency_key
            LIMIT 1;

            IF FOUND AND v_existing.user_id = p_user_id THEN
                RETURN QUERY SELECT
                    TRUE,
                    v_existing.balance_after,
                    v_existing.id,
                    NULL::TEXT;
                RETURN;
            END IF;
        END IF;

        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Duplicate credit transaction.';
END;
$$;

CREATE OR REPLACE FUNCTION atomic_add_credits(
    p_user_id UUID,
    p_amount INT,
    p_type VARCHAR(50),
    p_reason TEXT,
    p_reference_id VARCHAR(100) DEFAULT NULL,
    p_idempotency_key VARCHAR(150) DEFAULT NULL
)
RETURNS TABLE (
    success BOOLEAN,
    balance INT,
    transaction_id UUID,
    error_message TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_account credit_accounts%ROWTYPE;
    v_existing credit_transactions%ROWTYPE;
    v_before INT;
    v_after INT;
    v_tx_id UUID;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit grant amount must be positive.';
        RETURN;
    END IF;

    IF p_amount > 1000000 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit grant amount exceeds the maximum.';
        RETURN;
    END IF;

    IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Transaction reason is required.';
        RETURN;
    END IF;

    IF p_type NOT IN (
        'initial_free_credit',
        'trial_credit',
        'subscription_credit',
        'one_time_purchase',
        'admin_adjustment',
        'refund'
    ) THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Invalid credit transaction type.';
        RETURN;
    END IF;

    IF p_idempotency_key IS NOT NULL THEN
        SELECT *
        INTO v_existing
        FROM credit_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            IF v_existing.user_id <> p_user_id THEN
                RETURN QUERY SELECT FALSE, 0, NULL::UUID,
                    'Idempotency key belongs to a different user.';
                RETURN;
            END IF;

            RETURN QUERY SELECT
                TRUE,
                v_existing.balance_after,
                v_existing.id,
                NULL::TEXT;
            RETURN;
        END IF;
    END IF;

    SELECT *
    INTO v_account
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit account not found.';
        RETURN;
    END IF;

    v_before := v_account.balance;
    v_after := v_before + p_amount;
    v_tx_id := uuid_generate_v4();

    -- Protect against integer overflow.
    IF v_after < v_before THEN
        RETURN QUERY SELECT FALSE, v_before, NULL::UUID, 'Credit balance overflow.';
        RETURN;
    END IF;

    UPDATE credit_accounts
    SET
        balance = v_after,
        total_earned = total_earned + p_amount,
        version = version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = v_account.id;

    INSERT INTO credit_transactions (
        id, account_id, user_id, amount, balance_before, balance_after,
        transaction_type, reason, reference_id, idempotency_key
    )
    VALUES (
        v_tx_id, v_account.id, p_user_id, p_amount, v_before, v_after,
        p_type, p_reason, p_reference_id, p_idempotency_key
    );

    RETURN QUERY SELECT TRUE, v_after, v_tx_id, NULL::TEXT;

EXCEPTION
    WHEN unique_violation THEN
        IF p_idempotency_key IS NOT NULL THEN
            SELECT *
            INTO v_existing
            FROM credit_transactions
            WHERE idempotency_key = p_idempotency_key
            LIMIT 1;

            IF FOUND AND v_existing.user_id = p_user_id THEN
                RETURN QUERY SELECT
                    TRUE,
                    v_existing.balance_after,
                    v_existing.id,
                    NULL::TEXT;
                RETURN;
            END IF;
        END IF;

        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Duplicate credit transaction.';
END;
$$;

-- ==============================================================================
-- Automatic updated_at maintenance
-- ==============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON profiles;
CREATE TRIGGER trg_profiles_updated_at
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_plans_updated_at ON plans;
CREATE TRIGGER trg_plans_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_entitlements_updated_at ON entitlements;
CREATE TRIGGER trg_entitlements_updated_at
BEFORE UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_documents_updated_at ON knowledge_documents;
CREATE TRIGGER trg_knowledge_documents_updated_at
BEFORE UPDATE ON knowledge_documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ==============================================================================
-- Helper for creating a user's credit account.
-- Application code can safely call this after user registration.
-- ==============================================================================

CREATE OR REPLACE FUNCTION ensure_credit_account(p_user_id UUID)
RETURNS credit_accounts
LANGUAGE plpgsql
AS $$
DECLARE
    v_account credit_accounts%ROWTYPE;
BEGIN
    INSERT INTO credit_accounts (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT *
    INTO v_account
    FROM credit_accounts
    WHERE user_id = p_user_id;

    RETURN v_account;
END;
$$;
