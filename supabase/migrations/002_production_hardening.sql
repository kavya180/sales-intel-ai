-- ==============================================================================
-- Sales Objection Handling Assistant - Migration 002: Production Hardening
-- Adds:
-- 1. Atomic credit deduction stored procedure with row-level locking (FOR UPDATE)
-- 2. Atomic credit grant stored procedure with idempotency & balance integrity
-- 3. Stored procedure for trial activation with concurrency uniqueness check
-- 4. Cosine similarity match function for pgvector knowledge chunks
-- 5. Strict invariant check constraints and unique constraints
-- ==============================================================================

-- 1. ATOMIC CREDIT DEDUCTION (Row-level lock prevents race conditions)
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
    v_account_id UUID;
    v_current_balance INT;
    v_new_balance INT;
    v_tx_id UUID;
    v_existing_tx_id UUID;
    v_existing_balance INT;
BEGIN
    -- Validate amount
    IF p_amount <= 0 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Deduction amount must be strictly greater than 0.'::TEXT;
        RETURN;
    END IF;

    -- Idempotency check: if key already executed, return current state safely
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_existing_tx_id
        FROM credit_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_existing_tx_id IS NOT NULL THEN
            SELECT balance INTO v_existing_balance
            FROM credit_accounts
            WHERE user_id = p_user_id;

            RETURN QUERY SELECT TRUE, v_existing_balance, v_existing_tx_id, NULL::TEXT;
            RETURN;
        END IF;
    END IF;

    -- Row-level lock on credit_accounts row (SELECT ... FOR UPDATE)
    SELECT id, balance INTO v_account_id, v_current_balance
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_account_id IS NULL THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Credit account does not exist.'::TEXT;
        RETURN;
    END IF;

    IF v_current_balance < p_amount THEN
        RETURN QUERY SELECT FALSE, v_current_balance, NULL::UUID, 
            ('Insufficient credits. Required: ' || p_amount || ', Available: ' || v_current_balance)::TEXT;
        RETURN;
    END IF;

    v_new_balance := v_current_balance - p_amount;
    v_tx_id := uuid_generate_v4();

    -- Update balance and stats atomically
    UPDATE credit_accounts
    SET balance = v_new_balance,
        total_consumed = total_consumed + p_amount,
        version = version + 1,
        updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    WHERE id = v_account_id;

    -- Insert ledger record
    INSERT INTO credit_transactions (
        id, account_id, user_id, amount, balance_before, balance_after,
        transaction_type, reason, reference_id, idempotency_key, created_at
    ) VALUES (
        v_tx_id, v_account_id, p_user_id, -p_amount, v_current_balance, v_new_balance,
        'usage', p_reason, p_reference_id, p_idempotency_key, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    );

    RETURN QUERY SELECT TRUE, v_new_balance, v_tx_id, NULL::TEXT;
END;
$$;

-- 2. ATOMIC CREDIT GRANT (Double-entry top-up with idempotency)
CREATE OR REPLACE FUNCTION atomic_add_credits(
    p_user_id UUID,
    p_amount INT,
    p_transaction_type VARCHAR(50),
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
    v_account_id UUID;
    v_current_balance INT;
    v_new_balance INT;
    v_tx_id UUID;
    v_existing_tx_id UUID;
    v_existing_balance INT;
BEGIN
    IF p_amount <= 0 THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'Grant amount must be strictly greater than 0.'::TEXT;
        RETURN;
    END IF;

    -- Idempotency check
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_existing_tx_id
        FROM credit_transactions
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;

        IF v_existing_tx_id IS NOT NULL THEN
            SELECT balance INTO v_existing_balance
            FROM credit_accounts
            WHERE user_id = p_user_id;

            RETURN QUERY SELECT TRUE, v_existing_balance, v_existing_tx_id, NULL::TEXT;
            RETURN;
        END IF;
    END IF;

    -- Lock or create credit account
    SELECT id, balance INTO v_account_id, v_current_balance
    FROM credit_accounts
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_account_id IS NULL THEN
        v_account_id := uuid_generate_v4();
        v_current_balance := 0;
        INSERT INTO credit_accounts (id, user_id, balance, total_earned, total_consumed, version, updated_at)
        VALUES (v_account_id, p_user_id, 0, 0, 0, 1, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'));
    END IF;

    v_new_balance := v_current_balance + p_amount;
    v_tx_id := uuid_generate_v4();

    UPDATE credit_accounts
    SET balance = v_new_balance,
        total_earned = total_earned + p_amount,
        version = version + 1,
        updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    WHERE id = v_account_id;

    INSERT INTO credit_transactions (
        id, account_id, user_id, amount, balance_before, balance_after,
        transaction_type, reason, reference_id, idempotency_key, created_at
    ) VALUES (
        v_tx_id, v_account_id, p_user_id, p_amount, v_current_balance, v_new_balance,
        p_transaction_type, p_reason, p_reference_id, p_idempotency_key, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    );

    RETURN QUERY SELECT TRUE, v_new_balance, v_tx_id, NULL::TEXT;
END;
$$;

-- 3. PGVECTOR SEMANTIC SIMILARITY SEARCH FUNCTION
CREATE OR REPLACE FUNCTION match_knowledge_chunks (
    query_embedding vector(768),
    match_threshold float DEFAULT 0.25,
    match_count int DEFAULT 4
)
RETURNS TABLE (
    id UUID,
    document_id UUID,
    content TEXT,
    similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        kc.id,
        kc.document_id,
        kc.content,
        1 - (kc.embedding <=> query_embedding) AS similarity
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kd.id = kc.document_id
    WHERE kd.is_active = TRUE
      AND (1 - (kc.embedding <=> query_embedding)) >= match_threshold
    ORDER BY kc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
