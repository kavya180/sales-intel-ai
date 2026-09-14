import { redirect } from 'next/navigation';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
import { getCurrentUser } from '@/lib/auth';
import { getCreditAccount } from '@/lib/credits';
import { getTrialStatus } from '@/lib/trial';
import { dbGetUserEntitlements, isPostgresConfigured, memDb } from '@/lib/db';
import { Zap, Clock, Sparkles, Bot, ArrowRight, Shield } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  let credit;
  let trial;
  let entitlements;

  try {
    [credit, trial, entitlements] = await Promise.all([
      getCreditAccount(user.id),
      getTrialStatus(user.id),
      isPostgresConfigured ? dbGetUserEntitlements(user.id) : Promise.resolve(Array.from(memDb.entitlements.values()).filter(e => e.user_id === user.id && e.is_active)),
    ]);
  } catch {
    if (isPostgresConfigured) throw new Error('Dashboard data is temporarily unavailable.');
    throw new Error('Unable to load dashboard.');
  }

  const now = Date.now();
  const activeEntitlements = entitlements.filter(e => e.is_active && (!e.valid_until || new Date(e.valid_until).getTime() > now));
  const activePlanType = activeEntitlements.some(e => e.type === 'monthly')
    ? 'Monthly Pro'
    : activeEntitlements.some(e => e.type === 'onetime')
      ? 'One-Time Growth Pass'
      : trial.isActive ? 'Free 1-Month Trial' : 'Always Free';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <Navbar user={user} creditBalance={credit.balance} trialActive={trial.isActive} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex-1 w-full">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div><h1 className="text-2xl sm:text-3xl font-bold text-white">Welcome back, {user.full_name || user.email}</h1><p className="text-xs text-slate-400 mt-1">Your sales intelligence workspace</p></div>
          <Link href="/assistant" className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-2"><Bot className="w-4 h-4"/>Open Sales Assistant</Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800"><div className="flex justify-between mb-4"><span className="text-xs font-semibold text-slate-400 uppercase">Authoritative Balance</span><Zap className="w-4 h-4 text-amber-400"/></div><div className="text-3xl font-extrabold">{credit.balance} Credits</div><div className="text-xs text-slate-400 flex justify-between pt-3 mt-3 border-t border-slate-800"><span>Consumed: {credit.total_consumed}</span><Link href="/billing" className="text-amber-400">Add More +</Link></div></div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800"><div className="flex justify-between mb-4"><span className="text-xs font-semibold text-slate-400 uppercase">Active Entitlement</span><Shield className="w-4 h-4 text-indigo-400"/></div><div className="text-2xl font-extrabold">{activePlanType}</div><div className="text-xs text-slate-400 pt-3 mt-3 border-t border-slate-800"><Link href="/pricing" className="text-amber-400">Change Tier →</Link></div></div>
          <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800"><div className="flex justify-between mb-4"><span className="text-xs font-semibold text-slate-400 uppercase">30-Day Trial Status</span><Clock className="w-4 h-4 text-emerald-400"/></div>{trial.hasTrial ? trial.isActive ? <><div className="text-2xl font-extrabold text-emerald-400">{trial.daysRemaining} Days Left</div><div className="text-[11px] text-slate-400 pt-3 mt-3 border-t border-slate-800">Expires: {new Date(trial.expiresAt!).toLocaleDateString()}</div></> : <><div className="text-2xl font-extrabold text-rose-400">Trial Expired</div><div className="text-[11px] text-slate-400 pt-3 mt-3 border-t border-slate-800">Your Always Free access remains available.</div></> : <><div className="text-lg font-bold text-slate-300">Trial Not Activated</div><form action="/api/trial/start" method="POST" className="pt-3 mt-3 border-t border-slate-800"><button type="submit" className="text-xs bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-3 py-1.5 rounded-lg">Activate 30-Day Trial</button></form></>}</div>
        </div>

        <div className="p-8 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900 to-amber-950/30 border border-amber-500/30">
          <div className="max-w-2xl"><div className="inline-flex items-center gap-2 text-xs font-semibold text-amber-400 mb-2"><Sparkles className="w-4 h-4"/>Ready for your next high-ticket pitch?</div><h3 className="text-xl font-bold text-white mb-2">Generate Sales Intelligence Report</h3><p className="text-xs text-slate-400 mb-6 leading-relaxed">Get tailored buyer motivations, discovery questions, and objection-handling scripts based on your commercial context.</p><Link href="/assistant" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs">Open Assistant Now<ArrowRight className="w-4 h-4"/></Link></div>
        </div>
      </main>
    </div>
  );
}
