'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, ArrowRight, AlertCircle, Lock, Mail, User, CheckCircle2 } from 'lucide-react';

export default function RegisterPage() {
  const router=useRouter();
  const [fullName,setFullName]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);

  const handleSubmit=async(e:FormEvent)=>{
    e.preventDefault(); setError(null);
    const name=fullName.trim(), normalizedEmail=email.trim().toLowerCase();
    if(name.length<2){setError('Please enter your full name.');return;}
    if(!normalizedEmail||password.length<8){setError('Enter a valid email and a password of at least 8 characters.');return;}
    setLoading(true);
    try{
      const res=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({fullName:name,email:normalizedEmail,password})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data.error||'Registration failed.');
      router.replace('/dashboard'); router.refresh();
    }catch(err:unknown){setError(err instanceof Error?err.message:'Registration failed.');setLoading(false);}
  };

  return <div className="min-h-screen bg-slate-950 flex flex-col justify-center py-12 sm:px-6 lg:px-8 text-slate-100">
    <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
      <Link href="/" className="inline-flex items-center gap-2 mb-4"><div className="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center text-slate-950"><Bot className="w-6 h-6"/></div><span className="font-extrabold text-xl text-white">Sales Intel AI</span></Link>
      <h2 className="text-2xl font-bold text-white">Create your account</h2>
      <p className="mt-2 text-xs text-slate-400">Already have an account? <Link href="/login" className="font-medium text-amber-400">Sign in</Link></p>
    </div>
    <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0"><div className="bg-slate-900/70 border border-slate-800 py-8 px-6 shadow-2xl rounded-2xl sm:px-10">
      <div className="mb-6 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2"><CheckCircle2 className="w-4 h-4"/><span>Includes 5 free AI credits upon successful registration.</span></div>
      {error&&<div role="alert" className="mb-6 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2"><AlertCircle className="w-4 h-4"/><span>{error}</span></div>}
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div><label className="block text-xs font-semibold text-slate-300 mb-1.5">Full Name</label><div className="relative"><User className="w-4 h-4 text-slate-500 absolute left-3.5 top-3"/><input type="text" required maxLength={120} autoComplete="name" value={fullName} onChange={e=>setFullName(e.target.value)} className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400" placeholder="Your name"/></div></div>
        <div><label className="block text-xs font-semibold text-slate-300 mb-1.5">Work Email</label><div className="relative"><Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-3"/><input type="email" required maxLength={254} autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400" placeholder="you@company.com"/></div></div>
        <div><label className="block text-xs font-semibold text-slate-300 mb-1.5">Password</label><div className="relative"><Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-3"/><input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-sm text-white focus:outline-none focus:border-amber-400" placeholder="At least 8 characters"/></div></div>
        <button type="submit" disabled={loading} className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-2">{loading?'Creating Account...':'Create Account & Claim Credits'}<ArrowRight className="w-4 h-4"/></button>
      </form>
    </div></div>
  </div>;
}
