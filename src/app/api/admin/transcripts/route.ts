import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { dbQuery, isPostgresConfigured, memDb } from '@/lib/db';
import { ingestTranscript } from '@/lib/rag';
import { createAuditLogAsync } from '@/lib/audit';

const IngestSchema = z
  .object({
    title: z.string().trim().min(3).max(300),
    rawText: z.string().trim().min(20).max(5_000_000),
    sourceType: z.enum(['txt', 'paste', 'pdf', 'docx']).default('paste'),
  })
  .strict();

type KnowledgeDocument = {
  id: string;
  title: string;
  source_type: 'txt' | 'paste' | 'pdf' | 'docx';
  total_chunks: number;
  created_by: string | null;
  created_at: string;
};

export async function GET() {
  try {
    await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Knowledge base is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let documents: KnowledgeDocument[];
    let totalChunks = 0;

    if (isPostgresConfigured) {
      const result = await dbQuery<KnowledgeDocument>(
        `SELECT id, title, source_type, total_chunks, created_by, created_at
         FROM knowledge_documents
         ORDER BY created_at DESC
         LIMIT $1`,
        [500]
      );

      const countResult = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM knowledge_chunks`
      );

      if (!result || !countResult) {
        throw new Error('Failed to fetch knowledge base.');
      }

      documents = result.rows;
      totalChunks = Number.parseInt(countResult.rows[0]?.count ?? '0', 10) || 0;
    } else {
      documents = Array.from(memDb.knowledgeDocuments.values())
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() -
            new Date(a.created_at).getTime()
        )
        .slice(0, 500)
        .map((doc) => ({
          id: doc.id,
          title: doc.title,
          source_type: doc.source_type,
          total_chunks: doc.total_chunks,
          created_by: doc.created_by ?? null,
          created_at: doc.created_at,
        }));

      totalChunks = memDb.knowledgeChunks.length;
    }

    return NextResponse.json(
      { documents, totalChunks },
      { status: 200, headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err: unknown) {
    console.error('Admin transcript GET failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Knowledge base is temporarily unavailable.'
            : err instanceof Error
              ? err.message
              : 'Unauthorized',
      },
      {
        status: process.env.NODE_ENV === 'production' ? 503 : 403,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Knowledge ingestion is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON request body.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const parsed = IngestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Valid title and transcript text are required.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const doc = await ingestTranscript({
      title: parsed.data.title,
      rawText: parsed.data.rawText,
      sourceType: parsed.data.sourceType,
      createdBy: admin.id,
    });

    await createAuditLogAsync({
      userId: admin.id,
      action: 'transcript_ingested',
      resource: 'knowledge_base',
      details: {
        documentId: doc.id,
        title: doc.title,
        sourceType: parsed.data.sourceType,
        totalChunks: doc.total_chunks,
      },
    });

    return NextResponse.json(
      {
        success: true,
        message: `Transcript "${doc.title}" ingested successfully into ${doc.total_chunks} chunks.`,
        document: doc,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    console.error('Admin transcript ingestion failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Transcript ingestion failed.'
            : err instanceof Error
              ? err.message
              : 'Ingestion failed.',
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const admin = await requireAdmin();

    if (process.env.NODE_ENV === 'production' && !isPostgresConfigured) {
      return NextResponse.json(
        { error: 'Knowledge base is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const id = new URL(req.url).searchParams.get('id')?.trim();

    if (!id || id.length > 100) {
      return NextResponse.json(
        { error: 'Document id is required.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let title = '';

    if (isPostgresConfigured) {
      const documentResult = await dbQuery<{ id: string; title: string }>(
        `SELECT id, title FROM knowledge_documents WHERE id = $1 LIMIT 1`,
        [id]
      );

      if (!documentResult || !documentResult.rows[0]) {
        return NextResponse.json(
          { error: 'Document not found.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      title = documentResult.rows[0].title;

      const deleteChunks = await dbQuery(
        `DELETE FROM knowledge_chunks WHERE document_id = $1`,
        [id]
      );

      if (!deleteChunks) {
        throw new Error('Failed to delete document chunks.');
      }

      const deleteDocument = await dbQuery(
        `DELETE FROM knowledge_documents WHERE id = $1`,
        [id]
      );

      if (!deleteDocument) {
        throw new Error('Failed to delete document.');
      }
    } else {
      const doc = memDb.knowledgeDocuments.get(id);

      if (!doc) {
        return NextResponse.json(
          { error: 'Document not found.' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      title = doc.title;
      memDb.knowledgeDocuments.delete(id);
      memDb.knowledgeChunks = memDb.knowledgeChunks.filter(
        (chunk) => chunk.document_id !== id
      );
    }

    await createAuditLogAsync({
      userId: admin.id,
      action: 'transcript_deleted',
      resource: 'knowledge_base',
      details: { documentId: id, title },
    });

    return NextResponse.json(
      { success: true, message: `Document "${title}" removed.` },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    console.error('Admin transcript deletion failed:', err);

    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Document deletion failed.'
            : err instanceof Error
              ? err.message
              : 'Deletion failed.',
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
