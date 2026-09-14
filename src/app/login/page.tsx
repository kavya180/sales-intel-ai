'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, ArrowRight, AlertCircle, Lock, Mail } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    const normalizedEmail=email.trim().toLowerCase();
    if (!normalizedEmail || password.length < 8) { setError('Enter a valid email and password.'); return; }
    setLoading(true);
    try {
      const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({email:normalizedEmail,password})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data.error||'Unable to sign in.');
      router.replace('/dashboard'); router.refresh();
    } catch(err:unknown){ setError(err instanceof Error?err.message:'Unable to sign in.'); setLoading(false); }
  };

  return <div className="min-h-screen bg-slate-950 flex flex-col justify-center py-12 sm:px-6 lg:px-8 text-slate-100">
    <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
      <Link href="/" className="inline-flex items-center gap-2 mb-4"><div className="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center text-slate-950"><Bot className="w-6 h-6"/></div><span className="font-extrabold text-xl text-white">Sales Intel AI</span></Link>
      <h2 className="text-2xl font-bold text-white">Sign in to your account</h2>
      <p className="mt-2 text-xs text-slate-400">New here? <Link href="/register" className="font-medium text-amber-400">Create an account</Link></p>
    </div>
    <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0"><div className="bg-slate-900/70 border border-slate-800 py-8 px-6 shadow-2xl rounded-2xl sm:px-10">
      {error&&<div role="alert" className="mb-6 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2"><AlertCircle className="w-4 h-4"/><span>{error}</span></div>}
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div><label className="block text-xs font-semibold text-slate-300 mb-1.5">Email address</label><div className="relative"><Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3"/><input type="email" required maxLength={254} autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400" placeholder="you@company.com"/></div></div>
        <div><label className="block text-xs font-semibold text-slate-300 mb-1.5">Password</label><div className="relative"><Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3"/><input type="password" required maxLength={128} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400" placeholder="Your password"/></div></div>
        <button type="submit" disabled={loading} className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-2">{loading?'Authenticating...':'Sign In'}<ArrowRight className="w-4 h-4"/></button>
      </form>
      <p className="mt-6 pt-6 border-t border-slate-800 text-center text-xs text-slate-500">Secure server-side authentication.</p>
    </div></div>
  </div>;
}
