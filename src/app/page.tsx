import Link from 'next/link';
import Navbar from '@/components/Navbar';
import { getCurrentUser } from '@/lib/auth';
import { getCreditAccount } from '@/lib/credits';
import { getTrialStatus } from '@/lib/trial';
import { isPostgresConfigured } from '@/lib/db';
import {
  ShieldCheck,
  Zap,
  Bot,
  Brain,
  Layers,
  ArrowRight,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LandingPage() {
  const user = await getCurrentUser();

  let credit = null;
  let trial = null;

  if (user) {
    try {
      [credit, trial] = await Promise.all([
        getCreditAccount(user.id),
        getTrialStatus(user.id),
      ]);
    } catch {
      if (isPostgresConfigured) {
        credit = null;
        trial = null;
      }
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-amber-500 selection:text-slate-950">
      <Navbar
        user={user}
        creditBalance={credit?.balance}
        trialActive={trial?.isActive}
      />

      <main>
        <section className="relative pt-20 pb-28 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto flex flex-col items-center text-center overflow-hidden">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-amber-500/10 blur-[120px] rounded-full pointer-events-none" />
          <div className="absolute top-1/3 left-1/3 w-64 h-64 bg-indigo-500/10 blur-[100px] rounded-full pointer-events-none" />

          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-amber-500/30 text-amber-300 text-xs font-semibold mb-8">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span>AI Sales Intelligence & Objection Handling</span>
          </div>

          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white max-w-5xl leading-tight">
            Win High-Ticket Deals with{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-400 via-amber-200 to-amber-500">
              Smarter Objection Handling
            </span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-slate-400 max-w-3xl leading-relaxed">
            Define your product, target industry, deal size, and buyer. Generate
            tailored buyer motivations, discovery questions, and practical
            objection-handling scripts using your organization&apos;s grounded
            sales knowledge.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto">
            <Link
              href="/assistant"
              className="w-full sm:w-auto px-8 py-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-base shadow-xl shadow-amber-500/20 hover:scale-[1.02] transition flex items-center justify-center gap-2"
            >
              <Bot className="w-5 h-5" />
              Launch Sales Assistant
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/pricing"
              className="w-full sm:w-auto px-8 py-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 font-semibold text-base border border-slate-800 hover:border-slate-700 transition flex items-center justify-center gap-2"
            >
              Explore Plans
            </Link>
          </div>

          <div className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-6 text-left w-full">
            <Feature
              icon={<Brain className="w-6 h-6 text-amber-400" />}
              title="Transcript-Grounded Intelligence"
              text="Your approved sales transcripts can be chunked, embedded, and retrieved semantically to ground AI responses in your organization's knowledge."
            />
            <Feature
              icon={<ShieldCheck className="w-6 h-6 text-indigo-400" />}
              title="Server-Side Access Control"
              text="Authentication, entitlements, trial status, and credit balances are enforced on the server rather than trusted from the browser."
            />
            <Feature
              icon={<Zap className="w-6 h-6 text-emerald-400" />}
              title="Atomic Credit Ledger"
              text="AI usage is charged through a server-side credit ledger designed to prevent negative balances and duplicate deductions."
            />
          </div>
        </section>

        <section id="methodology" className="py-20 bg-slate-900/40 border-t border-slate-900 px-4 sm:px-6 lg:px-8">
          <div className="max-w-7xl mx-auto">
            <div className="text-center max-w-3xl mx-auto mb-16">
              <h2 className="text-3xl font-extrabold text-white sm:text-4xl">
                Built for Practical Sales Conversations
              </h2>
              <p className="mt-4 text-slate-400">
                Turn commercial context into structured discovery, objection
                handling, and next-step guidance without relying on generic prompts.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
              <div className="space-y-6">
                <MethodStep
                  number="1"
                  title="Acknowledge, Clarify, Pivot"
                  text="Acknowledge the buyer's concern, clarify the underlying issue, and pivot the conversation toward measurable business value."
                />
                <MethodStep
                  number="2"
                  title="Buyer-Specific Positioning"
                  text="Adapt messaging to the buyer role, commercial context, ticket size, and decision criteria supplied by the user."
                />
                <MethodStep
                  number="3"
                  title="Stage-Gated Risk Shifting"
                  text="Convert large purchase concerns into structured milestones and concrete next steps while preserving pricing integrity."
                />
              </div>

              <div className="p-8 rounded-2xl bg-slate-950 border border-slate-800 shadow-2xl relative">
                <div className="text-xs uppercase font-bold tracking-wider text-amber-400 mb-2 flex items-center gap-2">
                  <Layers className="w-4 h-4" /> Live Intelligence Preview
                </div>
                <div className="text-sm font-semibold text-white mb-4">
                  Objection: &quot;Your software is more expensive than another vendor.&quot;
                </div>
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 leading-relaxed font-mono">
                  <span className="text-amber-400 font-bold block mb-1">
                    Recommended Response:
                  </span>
                  &quot;I understand that budget matters. Besides the initial
                  invoice, what criteria are you using to compare the two
                  approaches, and what would implementation risk or delay cost
                  the business?&quot;
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="mt-auto border-t border-slate-900 py-10 px-4 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 Sales Intel AI. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="/pricing" className="hover:text-slate-300">Pricing</Link>
            <Link href="/terms" className="hover:text-slate-300">Terms of Service</Link>
            <Link href="/privacy" className="hover:text-slate-300">Privacy Policy</Link>
            <Link href="/contact" className="hover:text-slate-300">Support & Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Feature({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 backdrop-blur-sm hover:border-amber-500/40 transition">
      <div className="w-12 h-12 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-bold text-white mb-2">{title}</h3>
      <p className="text-sm text-slate-400 leading-relaxed">{text}</p>
    </div>
  );
}

function MethodStep({
  number,
  title,
  text,
}: {
  number: string;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold flex-shrink-0">
        {number}
      </div>
      <div>
        <h4 className="text-base font-bold text-white">{title}</h4>
        <p className="text-sm text-slate-400 mt-1">{text}</p>
      </div>
    </div>
  );
}
