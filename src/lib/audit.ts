import crypto from 'crypto';

import {
  dbCreateAuditLog,
  dbGetRecentAuditLogs,
  isPostgresConfigured,
  memDb,
} from '@/lib/db';

import type { AuditLog } from '@/types';

const isProduction = process.env.NODE_ENV === 'production';

const MAX_ACTION_LENGTH = 100;
const MAX_RESOURCE_LENGTH = 200;
const MAX_USER_AGENT_LENGTH = 200;
const MAX_DETAIL_STRING_LENGTH = 2000;
const MAX_DETAIL_KEYS = 50;
const MAX_AUDIT_LOGS = 1000;

const SENSITIVE_KEY_PATTERN =
  /^(?:password|password_hash|passwd|secret|api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie|private[_-]?key|client[_-]?secret|webhook[_-]?secret)$/i;

function sanitizeValue(
  value: unknown,
  depth = 0
): unknown {
  if (depth > 4) return '[truncated]';

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_STRING_LENGTH
      ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}...[truncated]`
      : value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);

    for (const [key, nestedValue] of entries.slice(0, MAX_DETAIL_KEYS)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = '[redacted]';
        continue;
      }

      output[key] = sanitizeValue(nestedValue, depth + 1);
    }

    if (entries.length > MAX_DETAIL_KEYS) {
      output.__truncated_keys = entries.length - MAX_DETAIL_KEYS;
    }

    return output;
  }

  return '[unsupported]';
}

function sanitizeDetails(
  details: Record<string, unknown>
): Record<string, unknown> {
  return sanitizeValue(details) as Record<string, unknown>;
}

function hashIp(ip?: string | null): string | null {
  if (!ip) return null;

  const normalized = ip.trim();
  if (!normalized) return null;

  // Store only a short irreversible identifier rather than the raw IP.
  return crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .substring(0, 16);
}

function normalizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function shouldUsePostgres(): boolean {
  return isPostgresConfigured;
}

/**
 * Create an audit record.
 *
 * Production uses PostgreSQL so audit events survive process restarts and are
 * visible across multiple application instances. Memory storage is retained
 * only for development/test compatibility.
 */
export function createAuditLog(params: {
  userId?: string | null;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}): AuditLog {
  if (isProduction || shouldUsePostgres()) {
    /*
     * The durable repository API is asynchronous. Keeping this synchronous
     * helper from pretending that a Promise was persisted prevents audit
     * events from being silently lost.
     *
     * Production callers must use createAuditLogAsync().
     */
    throw new Error(
      'Use createAuditLogAsync() when PostgreSQL-backed audit logging is enabled.'
    );
  }

  const action = normalizeText(params.action, MAX_ACTION_LENGTH);
  const resource = normalizeText(params.resource, MAX_RESOURCE_LENGTH);

  if (!action) {
    throw new Error('Audit action is required.');
  }

  if (!resource) {
    throw new Error('Audit resource is required.');
  }

  const log: AuditLog = {
    id: crypto.randomUUID(),
    user_id: params.userId || null,
    action,
    resource,
    details_json: sanitizeDetails(params.details || {}),
    ip_hash: hashIp(params.ip),
    user_agent: params.userAgent
      ? normalizeText(params.userAgent, MAX_USER_AGENT_LENGTH)
      : null,
    created_at: new Date().toISOString(),
  };

  memDb.auditLogs.unshift(log);

  if (memDb.auditLogs.length > MAX_AUDIT_LOGS) {
    memDb.auditLogs.pop();
  }

  return log;
}

/**
 * Async production-safe audit API.
 *
 * Prefer this from API routes and other server-side code. It guarantees that
 * PostgreSQL persistence has completed before returning.
 */
export async function createAuditLogAsync(params: {
  userId?: string | null;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<AuditLog> {
  const action = normalizeText(params.action, MAX_ACTION_LENGTH);
  const resource = normalizeText(params.resource, MAX_RESOURCE_LENGTH);

  if (!action) {
    throw new Error('Audit action is required.');
  }

  if (!resource) {
    throw new Error('Audit resource is required.');
  }

  const log: AuditLog = {
    id: crypto.randomUUID(),
    user_id: params.userId || null,
    action,
    resource,
    details_json: sanitizeDetails(params.details || {}),
    ip_hash: hashIp(params.ip),
    user_agent: params.userAgent
      ? normalizeText(params.userAgent, MAX_USER_AGENT_LENGTH)
      : null,
    created_at: new Date().toISOString(),
  };

  if (shouldUsePostgres()) {
    try {
      const persisted = await dbCreateAuditLog(log);
      return persisted || log;
    } catch (error) {
      console.error('Failed to persist audit log:', error);

      if (isProduction) {
        throw error;
      }

      memDb.auditLogs.unshift(log);
      if (memDb.auditLogs.length > MAX_AUDIT_LOGS) {
        memDb.auditLogs.pop();
      }

      return log;
    }
  }

  if (isProduction) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production audit logging requires PostgreSQL.'
    );
  }

  memDb.auditLogs.unshift(log);

  if (memDb.auditLogs.length > MAX_AUDIT_LOGS) {
    memDb.auditLogs.pop();
  }

  return log;
}

/**
 * Get recent audit logs.
 *
 * Production reads from PostgreSQL. The limit is bounded to avoid accidental
 * unbounded queries. Development/test can use the in-memory adapter.
 */
export async function getRecentAuditLogsAsync(
  limit = 50
): Promise<AuditLog[]> {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), 500))
    : 50;

  if (shouldUsePostgres()) {
    return dbGetRecentAuditLogs(safeLimit);
  }

  if (isProduction) {
    throw new Error(
      'FATAL CONFIGURATION ERROR: Production audit logging requires PostgreSQL.'
    );
  }

  return memDb.auditLogs.slice(0, safeLimit);
}

/**
 * Synchronous compatibility helper.
 *
 * This is intentionally memory-only. Production code should use
 * getRecentAuditLogsAsync().
 */
export function getRecentAuditLogs(limit = 50): AuditLog[] {
  if (isProduction) {
    throw new Error('Production must use getRecentAuditLogsAsync().');
  }

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), 500))
    : 50;

  return memDb.auditLogs.slice(0, safeLimit);
}
