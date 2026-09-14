'use client';

import { useCallback, useEffect, useState } from 'react';
import Navbar from '@/components/Navbar';
import type { KnowledgeDocument, AuditLog, Plan, UserProfile } from '@/types';
import {
  Shield,
  Users,
  Video,
  Activity,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Settings,
  Zap,
  RefreshCw,
} from 'lucide-react';

interface AdminUserView {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  created_at: string;
  balance: number;
  total_consumed: number;
  trialStatus: string;
  entitlements: string[];
}

type Message = {
  type: 'success' | 'error';
  text: string;
};

export default function AdminPage() {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<
    'transcripts' | 'users' | 'plans' | 'audit'
  >('transcripts');

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [ingestLoading, setIngestLoading] = useState(false);

  const [adjUserId, setAdjUserId] = useState('');
  const [adjAmount, setAdjAmount] = useState<number>(10);
  const [adjReason, setAdjReason] = useState('');
  const [adjLoading, setAdjLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const loadData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);

    try {
      const responses = await Promise.all([
        fetch('/api/admin/transcripts', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
        fetch('/api/admin/users', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
        fetch('/api/plans', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
        fetch('/api/admin/audit-logs', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
        fetch('/api/auth/me', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
      ]);

      const [transRes, usersRes, plansRes, auditRes, meRes] = responses;

      if (meRes.ok) {
        const m = await meRes.json();
        const user = m?.user ?? null;
        setCurrentUser(user);

        if (user?.role !== 'admin') {
          throw new Error('Administrator access is required.');
        }
      } else if (meRes.status === 401 || meRes.status === 403) {
        throw new Error('Administrator access is required.');
      }

      if (transRes.ok) {
        const d = await transRes.json();
        setDocuments(Array.isArray(d?.documents) ? d.documents : []);
      }

      if (usersRes.ok) {
        const u = await usersRes.json();
        setUsers(Array.isArray(u?.users) ? u.users : []);
      }

      if (plansRes.ok) {
        const p = await plansRes.json();
        setPlans(Array.isArray(p?.plans) ? p.plans : []);
      }

      if (auditRes.ok) {
        const a = await auditRes.json();
        setAuditLogs(Array.isArray(a?.logs) ? a.logs : []);
      }

      const failed = responses.filter((res) => !res.ok);
      if (failed.length > 0 && meRes.ok) {
        setMessage({
          type: 'error',
          text: 'Some admin data could not be loaded. Try refreshing.',
        });
      }
    } catch (err: unknown) {
      console.error('Failed to load admin data:', err);
      setMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to load administrator data.',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleIngest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (ingestLoading) return;

    setMessage(null);

    const cleanTitle = title.trim();
    const cleanText = rawText.trim();

    if (cleanTitle.length < 3 || cleanTitle.length > 300) {
      setMessage({
        type: 'error',
        text: 'Video title must be between 3 and 300 characters.',
      });
      return;
    }

    if (cleanText.length < 20) {
      setMessage({
        type: 'error',
        text: 'Transcript must contain at least 20 characters.',
      });
      return;
    }

    if (cleanText.length > 5_000_000) {
      setMessage({
        type: 'error',
        text: 'Transcript is too large. Maximum size is 5 MB of text.',
      });
      return;
    }

    setIngestLoading(true);

    try {
      const res = await fetch('/api/admin/transcripts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: cleanTitle,
          rawText: cleanText,
          sourceType: 'paste',
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string'
            ? data.error
            : 'Transcript ingestion failed.'
        );
      }

      setMessage({
        type: 'success',
        text: data?.message || 'Transcript ingested successfully.',
      });
      setTitle('');
      setRawText('');

      await loadData();
    } catch (err: unknown) {
      setMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Transcript ingestion failed.',
      });
    } finally {
      setIngestLoading(false);
    }
  };

  const handleDeleteTranscript = async (id: string) => {
    if (!id || ingestLoading) return;

    const confirmed = window.confirm(
      'Are you sure you want to permanently remove this video transcript and its indexed chunks?'
    );

    if (!confirmed) return;

    setMessage(null);

    try {
      const res = await fetch(
        `/api/admin/transcripts?id=${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
        }
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string'
            ? data.error
            : 'Failed to delete transcript.'
        );
      }

      setMessage({
        type: 'success',
        text: data?.message || 'Transcript removed.',
      });

      await loadData();
    } catch (err: unknown) {
      setMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to delete transcript.',
      });
    }
  };

  const handleAdjustCredits = async (
    e: React.FormEvent<HTMLFormElement>
  ) => {
    e.preventDefault();

    if (adjLoading) return;

    setMessage(null);

    const cleanReason = adjReason.trim();
    const amount = Number(adjAmount);

    if (!adjUserId) {
      setMessage({ type: 'error', text: 'Select a user first.' });
      return;
    }

    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      setMessage({
        type: 'error',
        text: 'Credit adjustment must be a non-zero amount up to 1,000,000.',
      });
      return;
    }

    if (cleanReason.length < 3 || cleanReason.length > 500) {
      setMessage({
        type: 'error',
        text: 'Reason must be between 3 and 500 characters.',
      });
      return;
    }

    setAdjLoading(true);

    // Keep one idempotency key for this submission. If the request is retried
    // by the caller with the same key, the credit ledger can safely deduplicate it.
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch('/api/admin/credits/adjust', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          userId: adjUserId,
          amount,
          reason: cleanReason,
          idempotencyKey,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string'
            ? data.error
            : 'Credit adjustment failed.'
        );
      }

      setMessage({
        type: 'success',
        text:
          typeof data?.message === 'string'
            ? data.message
            : 'Credit adjustment committed.',
      });
      setAdjReason('');

      await loadData();
    } catch (err: unknown) {
      setMessage({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Credit adjustment failed.',
      });
    } finally {
      setAdjLoading(false);
    }
  };

  const tabs = [
    {
      id: 'transcripts' as const,
      label: 'Video Transcripts (RAG)',
      icon: Video,
    },
    {
      id: 'users' as const,
      label: 'Users & Credits',
      icon: Users,
    },
    {
      id: 'plans' as const,
      label: 'Plan Config',
      icon: Settings,
    },
    {
      id: 'audit' as const,
      label: 'Audit Trail',
      icon: Activity,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-amber-500 selection:text-slate-950">
      <Navbar
        user={
          currentUser
            ? { email: currentUser.email, role: currentUser.role }
            : { email: 'Administrator', role: 'admin' }
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex-1 w-full">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                Admin &amp; Knowledge Base Console
              </h1>
              <p className="text-xs sm:text-sm text-slate-400">
                Manage transcripts, users, credits, plans, and security audit logs.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadData(true)}
            disabled={loading || refreshing}
            className="self-start sm:self-auto inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-300 hover:text-white hover:border-slate-600 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {message && (
          <div
            role="alert"
            className={`mb-6 p-4 rounded-xl text-xs flex items-center gap-2 ${
              message.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                : 'bg-rose-500/10 border border-rose-500/20 text-rose-300'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl bg-slate-900/60 border border-slate-800 p-10 text-center text-sm text-slate-400">
            Loading administrator console...
          </div>
        ) : currentUser?.role !== 'admin' ? (
          <div className="rounded-2xl bg-rose-500/10 border border-rose-500/20 p-10 text-center">
            <Shield className="w-8 h-8 text-rose-400 mx-auto mb-3" />
            <h2 className="text-base font-bold text-white">
              Administrator access required
            </h2>
            <p className="text-xs text-slate-400 mt-2">
              Your current account does not have administrator privileges.
            </p>
          </div>
        ) : (
          <>
            <div className="flex overflow-x-auto border-b border-slate-800 mb-8 gap-4 text-sm font-semibold">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`pb-3 flex-shrink-0 items-center gap-2 border-b-2 transition ${
                    activeTab === id
                      ? 'border-amber-400 text-amber-400'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  } flex`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ))}
            </div>

            {activeTab === 'transcripts' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div className="lg:col-span-5 bg-slate-900/60 border border-slate-800 p-6 rounded-2xl">
                  <h2 className="text-base font-bold text-white mb-2 flex items-center gap-2">
                    <Plus className="w-4 h-4 text-amber-400" />
                    Ingest New Video Transcript
                  </h2>
                  <p className="text-xs text-slate-400 mb-4">
                    Add sales methodology from your video transcripts to the
                    assistant&apos;s knowledge base.
                  </p>

                  <form onSubmit={handleIngest} className="space-y-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Video Title / Methodology Topic
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={300}
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. Closing ₹50L Deals Without Giving Discounts"
                        className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Transcript Content
                      </label>
                      <textarea
                        rows={8}
                        required
                        maxLength={5_000_000}
                        value={rawText}
                        onChange={(e) => setRawText(e.target.value)}
                        placeholder="Paste video speech-to-text transcript here..."
                        className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-none focus:border-amber-400 transition font-mono"
                      />
                      <p className="text-[10px] text-slate-500 mt-1 text-right">
                        {rawText.length.toLocaleString()} / 5,000,000
                      </p>
                    </div>

                    <button
                      type="submit"
                      disabled={ingestLoading}
                      className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shadow-lg shadow-amber-500/20 transition disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {ingestLoading ? 'Ingesting & Chunking...' : 'Index Video Transcript'}
                    </button>
                  </form>
                </div>

                <div className="lg:col-span-7">
                  <h2 className="text-base font-bold text-white mb-4">
                    Indexed Video Documents ({documents.length})
                  </h2>

                  <div className="space-y-4">
                    {documents.length === 0 ? (
                      <div className="p-8 rounded-2xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-500">
                        No indexed transcripts yet.
                      </div>
                    ) : (
                      documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col justify-between space-y-3"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <h3 className="font-bold text-sm text-white break-words">
                                {doc.title}
                              </h3>
                              <p className="text-[11px] text-slate-400 mt-1">
                                Chunks:{' '}
                                <span className="font-semibold text-amber-400">
                                  {doc.total_chunks}
                                </span>{' '}
                                • Ingested:{' '}
                                {new Date(doc.created_at).toLocaleDateString()}
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => void handleDeleteTranscript(doc.id)}
                              className="p-2 flex-shrink-0 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition"
                              aria-label={`Delete transcript ${doc.title}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          <p className="text-xs text-slate-400 line-clamp-3 bg-slate-950 p-3 rounded-xl border border-slate-800/80 font-mono break-words">
                            {doc.raw_text}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'users' && (
              <div className="space-y-8">
                <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800">
                  <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    Manual Credit Ledger Adjustment (Audited)
                  </h3>

                  <form
                    onSubmit={handleAdjustCredits}
                    className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end"
                  >
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Select User
                      </label>
                      <select
                        value={adjUserId}
                        onChange={(e) => setAdjUserId(e.target.value)}
                        required
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
                      >
                        <option value="">-- Choose User --</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.email} (Balance: {u.balance})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Credits (+ / -)
                      </label>
                      <input
                        type="number"
                        value={adjAmount}
                        onChange={(e) => setAdjAmount(Number(e.target.value))}
                        required
                        min={-1_000_000}
                        max={1_000_000}
                        step="1"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Reason for Audit Log
                      </label>
                      <input
                        type="text"
                        maxLength={500}
                        placeholder="e.g. VIP Customer courtesy grant"
                        value={adjReason}
                        onChange={(e) => setAdjReason(e.target.value)}
                        required
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={adjLoading}
                      className="w-full py-2.5 px-4 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-xl text-xs transition disabled:opacity-50"
                    >
                      {adjLoading ? 'Adjusting...' : 'Commit Adjustment'}
                    </button>
                  </form>
                </div>

                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs text-slate-300">
                      <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold border-b border-slate-800">
                        <tr>
                          <th className="px-4 py-3">User</th>
                          <th className="px-4 py-3">Role</th>
                          <th className="px-4 py-3">Credit Balance</th>
                          <th className="px-4 py-3">Total Consumed</th>
                          <th className="px-4 py-3">Trial Status</th>
                          <th className="px-4 py-3">Entitlements</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {users.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-8 text-center text-slate-500"
                            >
                              No users found.
                            </td>
                          </tr>
                        ) : (
                          users.map((u) => (
                            <tr key={u.id} className="hover:bg-slate-800/30">
                              <td className="px-4 py-3 font-medium text-white">
                                <div>{u.full_name || 'No Name'}</div>
                                <div className="text-slate-400 text-[11px] font-mono break-all">
                                  {u.email}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                    u.role === 'admin'
                                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                      : 'bg-slate-800 text-slate-300'
                                  }`}
                                >
                                  {u.role}
                                </span>
                              </td>
                              <td className="px-4 py-3 font-mono font-bold text-amber-400">
                                {u.balance}
                              </td>
                              <td className="px-4 py-3 font-mono text-slate-400">
                                {u.total_consumed}
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                                    u.trialStatus === 'Active'
                                      ? 'bg-emerald-500/20 text-emerald-400'
                                      : u.trialStatus === 'Expired'
                                        ? 'bg-rose-500/20 text-rose-400'
                                        : 'text-slate-500'
                                  }`}
                                >
                                  {u.trialStatus}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex gap-1 flex-wrap">
                                  {u.entitlements.length > 0 ? (
                                    u.entitlements.map((e) => (
                                      <span
                                        key={`${u.id}-${e}`}
                                        className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-slate-300"
                                      >
                                        {e}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-slate-600">None</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'plans' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {plans.length === 0 ? (
                  <div className="md:col-span-2 p-8 rounded-2xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-500">
                    No plans available.
                  </div>
                ) : (
                  plans.map((p) => (
                    <div
                      key={p.id}
                      className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-bold text-white">{p.name}</h3>
                        <span className="text-xs bg-slate-800 px-2 py-0.5 rounded font-mono text-amber-400">
                          ID: {p.id}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400">
                        Type: {p.type}
                      </div>
                      <div className="text-xs text-slate-300">
                        Price: ₹{p.price_inr}
                      </div>
                      <div className="text-xs text-slate-300">
                        Credits: {p.credits}
                      </div>
                      <div className="text-xs text-slate-300">
                        Duration: {p.duration_days} days
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === 'audit' && (
              <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold border-b border-slate-800">
                      <tr>
                        <th className="px-4 py-3">Timestamp</th>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Resource</th>
                        <th className="px-4 py-3">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td
                            colSpan={4}
                            className="px-4 py-8 text-center text-slate-500"
                          >
                            No audit events found.
                          </td>
                        </tr>
                      ) : (
                        auditLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-slate-800/30">
                            <td className="px-4 py-3 font-mono text-slate-400 whitespace-nowrap">
                              {new Date(log.created_at).toLocaleString()}
                            </td>
                            <td className="px-4 py-3 font-bold text-white">
                              {log.action}
                            </td>
                            <td className="px-4 py-3 text-slate-400">
                              {log.resource}
                            </td>
                            <td className="px-4 py-3 font-mono text-[11px] text-slate-300 max-w-md">
                              <pre className="whitespace-pre-wrap break-words">
                                {JSON.stringify(log.details_json)}
                              </pre>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
