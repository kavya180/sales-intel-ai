'use client';

import { FormEvent, useState } from 'react';
import Navbar from '@/components/Navbar';
import type { SalesIntelligenceReport } from '@/types';
import {
  Bot, Sparkles, Zap, CheckCircle2, AlertCircle, HelpCircle,
  ShieldAlert, ArrowRight, Copy, FileText,
} from 'lucide-react';

export default function AssistantPage() {
  const [selling, setSelling] = useState('');
  const [targetIndustry, setTargetIndustry] = useState('');
  const [businessModel, setBusinessModel] = useState('B2B');
  const [dealSize, setDealSize] = useState('₹5 Lakh–₹20 Lakh');
  const [buyerType, setBuyerType] = useState('Business owner / entrepreneur');
  const [additionalContext, setAdditionalContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SalesIntelligenceReport | null>(null);
  const [creditsLeft, setCreditsLeft] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const businessModelOptions = ['B2B','B2C','B2B2C','Institutional / Govt','Export / OEM','Distribution / Retail','Franchise','Manufacturing'];
  const dealSizeOptions = ['Under ₹1 Lakh','₹1 Lakh–₹5 Lakh','₹5 Lakh–₹20 Lakh','₹20 Lakh–₹1 Crore','₹1 Crore+','Varies widely'];
  const buyerTypeOptions = ['Business owner / entrepreneur','CEO / C-suite','Procurement manager','Individual consumer','Department head / VP','Govt / institutional buyer'];

  const handleGenerate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const sellingValue = selling.trim();
    const industryValue = targetIndustry.trim();
    const contextValue = additionalContext.trim();

    if (sellingValue.length < 2 || industryValue.length < 2) {
      setError('Please provide the product/service and target industry.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/assistant/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          selling: sellingValue,
          target_industry: industryValue,
          business_model: businessModel,
          deal_size: dealSize,
          buyer_type: buyerType,
          additional_context: contextValue || undefined,
        }),
      });

      let data: { report?: SalesIntelligenceReport; remainingBalance?: number; error?: string };
      try {
        data = await res.json();
      } catch {
        throw new Error('The server returned an invalid response.');
      }

      if (!res.ok) throw new Error(data.error || 'Generation failed.');
      if (!data.report) throw new Error('The server did not return a report.');

      setReport(data.report);
      setCreditsLeft(typeof data.remainingBalance === 'number' ? data.remainingBalance : null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error generating report.');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Unable to copy the report to the clipboard.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-amber-500 selection:text-slate-950">
      <Navbar creditBalance={creditsLeft ?? undefined} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex-1 w-full">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-amber-500/30 text-amber-300 text-xs font-semibold mb-2">
            <Sparkles className="w-3.5 h-3.5" /> High-Ticket Sales Intelligence
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Sales Objection Handling Assistant</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">Specify your commercial context below. Each generation consumes 1 AI Credit.</p>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" /><span>{error}</span>
            {error.toLowerCase().includes('credit') && <a href="/billing" className="ml-auto underline font-bold text-xs text-amber-400">Top up credits →</a>}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-5 bg-slate-900/60 border border-slate-800 p-6 rounded-2xl backdrop-blur-sm h-fit">
            <form onSubmit={handleGenerate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">1. What are you selling? <span className="text-rose-400">*</span></label>
                <input required maxLength={500} value={selling} onChange={e => setSelling(e.target.value)} placeholder="e.g. AI-driven Supply Chain Optimization Platform" className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">2. Target Industry <span className="text-rose-400">*</span></label>
                <input required maxLength={300} value={targetIndustry} onChange={e => setTargetIndustry(e.target.value)} placeholder="e.g. Automotive & Heavy Machinery" className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">3. Business Model <span className="text-rose-400">*</span></label>
                <select value={businessModel} onChange={e => setBusinessModel(e.target.value)} className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition">{businessModelOptions.map(o => <option key={o}>{o}</option>)}</select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">4. Approximate Deal / Ticket Size <span className="text-rose-400">*</span></label>
                <select value={dealSize} onChange={e => setDealSize(e.target.value)} className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition">{dealSizeOptions.map(o => <option key={o}>{o}</option>)}</select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">5. Who is the buyer? <span className="text-rose-400">*</span></label>
                <select value={buyerType} onChange={e => setBuyerType(e.target.value)} className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition">{buyerTypeOptions.map(o => <option key={o}>{o}</option>)}</select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">6. Additional Context (Optional)</label>
                <textarea rows={4} maxLength={5000} value={additionalContext} onChange={e => setAdditionalContext(e.target.value)} placeholder="e.g. Buyer expressed fear of disrupting existing SAP ERP workflows during peak Q4 production." className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition" />
              </div>
              <button type="submit" disabled={loading} className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-xs shadow-lg shadow-amber-500/20 transition flex items-center justify-center gap-2 disabled:opacity-50">
                {loading ? <><div className="w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" /> Synthesizing AI Intelligence...</> : <><Zap className="w-4 h-4 fill-slate-950" /> Generate Sales Intelligence Report</>}
              </button>
            </form>
          </div>

          <div className="lg:col-span-7">
            {report ? (
              <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800">
                <div className="flex items-center justify-between mb-4 border-b border-slate-800/80 pb-3">
                  <div className="flex items-center gap-2"><FileText className="w-5 h-5 text-amber-400" /><h3 className="text-base font-bold text-white">Sales Intelligence Report</h3></div>
                  <button onClick={copyToClipboard} className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:text-white flex items-center gap-1.5">{copied ? 'Copied' : 'Copy JSON'}</button>
                </div>
                <div className="mb-6 p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 leading-relaxed"><span className="font-bold text-amber-400 block mb-1">Executive Diagnostic:</span>{report.summary}</div>
                <ReportList title="Core Buyer Motivations" icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />} items={report.buyer_motivations} />
                <div className="mb-6">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5"><ShieldAlert className="w-4 h-4 text-rose-400" /> Likely Objections & Scripted Handling (ACP)</h4>
                  <div className="space-y-3">{report.likely_objections.map((obj, idx) => <div key={idx} className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs"><div className="font-bold text-rose-300 text-sm">&ldquo;{obj.objection}&rdquo;</div><div className="text-slate-400"><b className="text-slate-500">Underlying Root Cause:</b> {obj.root_cause}</div><div className="text-slate-400"><b className="text-slate-500">Recommended Strategy:</b> {obj.recommended_strategy}</div><div className="mt-2 p-3 rounded-lg bg-slate-900 border border-amber-500/30 font-mono text-slate-200"><span className="text-amber-400 font-bold block mb-1">Verbatim Script:</span>{obj.scripted_response}</div></div>)}</div>
                </div>
                <ReportList title="High-Impact Discovery Questions" icon={<HelpCircle className="w-4 h-4 text-indigo-400" />} items={report.discovery_questions} />
                <ReportList title="Suggested Closing Next Steps" icon={<ArrowRight className="w-4 h-4 text-emerald-400" />} items={report.suggested_next_steps} numbered />
              </div>
            ) : (
              <div className="h-full min-h-[400px] border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center p-8 text-center bg-slate-900/20">
                <Bot className="w-12 h-12 text-slate-600 mb-3" /><h3 className="text-base font-bold text-slate-400 mb-1">No Report Generated Yet</h3><p className="text-xs text-slate-500 max-w-sm">Complete the commercial situation parameters and generate a tactical objection playbook.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ReportList({ title, icon, items, numbered = false }: { title: string; icon: React.ReactNode; items: string[]; numbered?: boolean }) {
  return (
    <div className="mb-6">
      <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">{icon} {title}</h4>
      <ul className="space-y-2 text-xs text-slate-300">{items.map((item, idx) => <li key={idx} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 flex items-start gap-2"><span className="text-amber-400 font-bold">{numbered ? `${idx + 1}.` : '•'}</span><span>{item}</span></li>)}</ul>
    </div>
  );
}
