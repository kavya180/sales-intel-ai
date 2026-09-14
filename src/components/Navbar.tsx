import Link from 'next/link';
import { Bot, Shield, Zap, Sparkles } from 'lucide-react';

type NavbarUser = {
  email: string;
  role: string;
};

export default function Navbar({
  user,
  creditBalance,
  trialActive,
}: {
  user?: NavbarUser | null;
  creditBalance?: number;
  trialActive?: boolean;
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="group flex items-center gap-3" aria-label="Sales Intel AI home">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-amber-300 shadow-lg shadow-amber-500/20 transition group-hover:scale-105">
            <Bot className="h-6 w-6 text-slate-950" />
          </div>

          <div>
            <div className="flex items-center gap-2 text-lg font-bold tracking-tight text-white">
              Sales Intel AI
              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                AI
              </span>
            </div>
            <p className="text-xs text-slate-400">Sales Intelligence & Objection Handling</p>
          </div>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="hidden items-center gap-6 text-sm font-medium text-slate-300 md:flex"
        >
          <Link href="/pricing" className="transition hover:text-amber-400">
            Pricing & Plans
          </Link>

          <Link href="/#methodology" className="transition hover:text-amber-400">
            Methodology
          </Link>

          {user && (
            <>
              <Link
                href="/assistant"
                className="flex items-center gap-1.5 transition hover:text-amber-400"
              >
                <Sparkles className="h-4 w-4 text-amber-400" />
                Assistant
              </Link>

              <Link href="/dashboard" className="transition hover:text-amber-400">
                Dashboard
              </Link>

              <Link href="/billing" className="transition hover:text-amber-400">
                Billing
              </Link>

              {user.role === 'admin' && (
                <Link
                  href="/admin"
                  className="flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-rose-300 transition hover:bg-rose-500/20"
                >
                  <Shield className="h-3.5 w-3.5" />
                  Admin
                </Link>
              )}
            </>
          )}
        </nav>

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <Link
                href="/billing"
                aria-label={`View billing and credit balance: ${creditBalance ?? 0} credits`}
                className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:border-amber-400"
              >
                <Zap className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                <span>{creditBalance ?? 0} Credits</span>

                {trialActive && (
                  <span className="ml-1 rounded border border-emerald-500/30 bg-emerald-500/20 px-1.5 text-[10px] text-emerald-400">
                    Trial
                  </span>
                )}
              </Link>

              <form action="/api/auth/logout" method="POST">
                <button
                  type="submit"
                  className="rounded-lg border border-slate-800 px-3 py-1.5 text-xs text-slate-400 transition hover:border-slate-700 hover:text-white"
                >
                  Sign Out
                </button>
              </form>
            </>
          ) : (
            <div className="flex items-center gap-2 sm:gap-3">
              <Link
                href="/login"
                className="px-2 py-2 text-sm font-medium text-slate-300 transition hover:text-white sm:px-3"
              >
                Sign In
              </Link>

              <Link
                href="/register"
                className="rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 px-3 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-amber-500/20 transition hover:from-amber-400 hover:to-amber-500 sm:px-4"
              >
                Get Started Free
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
