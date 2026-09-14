# Sales Objection Handling Assistant — Production SaaS Platform

An enterprise-grade, subscription-based SaaS web application built from scratch around Manuj Bajaj's proprietary sales methodologies. The platform diagnoses high-ticket commercial situations, retrieves tactical video transcripts via Retrieval-Augmented Generation (RAG), and synthesizes word-for-word objection handling scripts, root-cause analyses, discovery questions, and value positioning playbooks.

---

## 1. Project Overview & Architecture

The application is built on **Next.js 16 (App Router)** with **TypeScript**, **Tailwind CSS**, a **Double-Entry Credit Ledger**, strict **Server-Side UTC 30-Day Trial Enforcement**, **Razorpay Payment Integration** with HMAC signature verification, **RAG Knowledge Base indexing**, and **Google Gemini 1.5 Flash**.

### Key Architectural Tenets:
1. **Zero Client-Side Trust**:
   - The browser is never trusted for entitlement status, credit balance, trial eligibility, or payment verification.
   - All balance mutations happen via server-side atomic ledger entries.
2. **Server-Side UTC Trial Enforcement**:
   - Trial status is evaluated against server/database UTC timestamps. Tampering with laptop, mobile, or browser clock has zero effect on trial validity.
   - Strict single-use trial constraint prevents trial reset abuse.
3. **Double-Entry Credit Accounting**:
   - Each credit deduction or top-up creates an append-only transaction in the ledger (`credit_transactions`) with before/after balances, idempotency keys, and mutex concurrency locks to eliminate race conditions.
4. **Proprietary Video Transcript RAG Pipeline**:
   - Ingests Manuj Bajaj's video transcripts, splits them into semantic overlapping chunks, indexes them, and semantically injects the most relevant methodologies into Gemini prompts.
   - Defensive prompt engineering neutralizes prompt injection attacks.
5. **HMAC Webhook & Payment Verification**:
   - Verifies Razorpay checkout signatures and webhook event signatures using SHA-256 HMAC.
   - Idempotent fulfillment prevents duplicate credit grants from webhook replays.

---

## 2. SaaS Plans & Business Model

The system implements four distinct, configurable plan tiers:

| Plan Name | Type | Price (INR) | Duration | AI Credits | Renewal Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Always Free** | `free` | ₹0 | Unlimited | 5 Lifetime | None |
| **Free 1-Month Trial** | `trial` | ₹0 | 30 Days | 25 Credits | 1-time per verified account |
| **Monthly Pro Subscription** | `monthly` | ₹2,499 | 30 Days | 150 Credits | Monthly Reset / Recurring |
| **One-Time Growth Pass** | `onetime` | ₹6,999 | 365 Days | 500 Credits | Non-expiring Accumulation |

*All prices, credit quotas, trial days, and features are fully configurable via `.env` or the Admin Dashboard.*

---

## 3. Tech Stack

- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS, Lucide Icons.
- **Backend**: Next.js Server Actions & API Routes with Zod validation.
- **Security**: JWT (`jsonwebtoken`), `bcryptjs`, HMAC-SHA256, Sliding Window Rate Limiting, Audit Logging.
- **AI & RAG**: Google Gen AI SDK (`@google/genai` with Gemini 1.5 Flash), Vector Cosine Retrieval.
- **Payments**: Razorpay Node.js SDK with Webhook idempotency.
- **Testing**: Vitest test suite covering Auth, UTC Trial, Ledger, Payments, RAG, and AI Prompt Defense.

---

## 4. Directory Structure

```
c:/Internshala_projects/Graybox/
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql       # Full PostgreSQL & pgvector schema
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── admin/                   # Admin endpoints (users, credits, transcripts, audit)
│   │   │   ├── assistant/generate/      # Core Sales Intelligence AI generation endpoint
│   │   │   ├── auth/                    # Register, login, me, logout endpoints
│   │   │   ├── payments/                # Create-order, verify, webhook handlers
│   │   │   ├── plans/                   # Dynamic plan catalog endpoint
│   │   │   ├── trial/start/             # 30-day trial activation endpoint
│   │   │   └── user/                    # Balance and usage telemetry
│   │   ├── admin/page.tsx               # Admin Console (Transcripts, Users, Ledger, Logs)
│   │   ├── assistant/page.tsx           # Sales Objection Handling Assistant UI
│   │   ├── billing/page.tsx             # Billing, Subscription Checkout, & Ledger Statement
│   │   ├── dashboard/page.tsx           # User Dashboard with UTC Trial Countdown
│   │   ├── login/page.tsx               # Sign In
│   │   ├── register/page.tsx            # Sign Up
│   │   ├── pricing/page.tsx             # 4-Tier Public Pricing Table
│   │   └── page.tsx                     # Modern Landing Page with Methodology breakdown
│   ├── components/
│   │   └── Navbar.tsx                   # Responsive navigation bar with real-time balance
│   ├── lib/
│   │   ├── ai.ts                        # Gemini AI orchestration & prompt defense
│   │   ├── audit.ts                     # Secret-sanitized security audit logger
│   │   ├── auth.ts                      # JWT authentication & role enforcement
│   │   ├── credits.ts                   # Ledger-backed credit accounting & concurrency locks
│   │   ├── db.ts                        # Database abstraction & memory store with defaults
│   │   ├── payments.ts                  # Razorpay signature verification & fulfillment
│   │   ├── rag.ts                       # Transcript chunker & semantic retrieval
│   │   ├── ratelimit.ts                 # Sliding-window rate limiter
│   │   └── trial.ts                     # Strict server UTC trial management
│   ├── test/
│   │   └── saas.test.ts                 # Comprehensive Vitest test suite (18 tests)
│   └── types/
│       └── index.ts                     # Core TypeScript domain models
├── .env.example                         # Production environment template
├── .env.local                           # Local development configuration
└── vitest.config.ts                     # Vitest configuration
```

---

## 5. Local Setup & Running

### Prerequisites
- Node.js v18+ (tested on Node v24.18.1)
- npm v10+

### Installation & Execution
```bash
# 1. Install dependencies
npm install

# 2. Run automated test suite (all 18 unit & integration tests)
npm test

# 3. Verify TypeScript type safety
npm run typecheck

# 4. Run production build
npm run build

# 5. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Initial Admin Account Setup
Configure `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` in `.env.local` to seed the administrative account during initial deployment.

---

## 6. Testing Summary

Run the automated test suite anytime with:
```bash
npm test
```
The test suite validates:
1. **Authentication**: Registration with initial 5 free credits, duplicate prevention, password hashing, and login.
2. **Trial Enforcement**: 30-day UTC start, rejection of client clock manipulation, single-use trial restriction.
3. **Credit Accounting**: Atomic deduction, overdraft prevention, idempotency on duplicate requests, and concurrent request safety.
4. **Payments**: Order creation, HMAC signature verification, rejection of forged signatures, and idempotent webhook fulfillment.
5. **RAG Knowledge Base**: Overlapping text chunking, transcript indexing, and semantic keyword retrieval.
6. **AI Defense**: Comprehensive Sales Intelligence report generation and neutralization of prompt injection attempts.

---

## 7. Production Deployment Instructions

### Vercel / Cloud Deployment:
1. Push repository to GitHub/GitLab.
2. Connect repository to [Vercel](https://vercel.com).
3. Set the production environment variables from `.env.example`:
   - `DATABASE_URL` (Supabase or direct PostgreSQL connection string)
   - `JWT_SECRET` (Generate a 64-character random string)
   - `GEMINI_API_KEY` (From Google AI Studio)
   - `NEXT_PUBLIC_RAZORPAY_KEY_ID` & `RAZORPAY_KEY_SECRET` (From Razorpay Dashboard)
   - `RAZORPAY_WEBHOOK_SECRET` (From Razorpay Webhook settings)
4. In your Supabase/PostgreSQL database, execute `supabase/migrations/001_initial_schema.sql` to apply tables and indexes.
5. Configure your Razorpay Webhook URL to:
   `https://your-production-domain.com/api/payments/webhook` with event subscriptions for `payment.captured` and `order.paid`.
