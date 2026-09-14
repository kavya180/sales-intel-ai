import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { memDb, dbQuery, pgPool } from '@/lib/db';
import { createAuditLog } from '@/lib/audit';
import type { KnowledgeDocument, KnowledgeChunk } from '@/types';

const isProduction = process.env.NODE_ENV === 'production';

const EXPECTED_VECTOR_DIMENSION = Number.parseInt(
  process.env.EMBEDDING_DIMENSION || '768',
  10
);

// Current Google Gemini embedding models support configurable output
// dimensionality. Keep this aligned with knowledge_chunks.embedding vector(N).
const EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';

if (
  !Number.isInteger(EXPECTED_VECTOR_DIMENSION) ||
  EXPECTED_VECTOR_DIMENSION < 128 ||
  EXPECTED_VECTOR_DIMENSION > 3072
) {
  throw new Error(
    'EMBEDDING_DIMENSION must be an integer between 128 and 3072.'
  );
}

function requireProductionInfrastructure(): void {
  if (isProduction && !pgPool) {
    throw new Error(
      'CRITICAL: PostgreSQL is required for RAG operations in production.'
    );
  }

  if (isProduction && !process.env.GEMINI_API_KEY) {
    throw new Error(
      'CRITICAL: GEMINI_API_KEY is required for RAG operations in production.'
    );
  }
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    if (isProduction) {
      throw new Error('GEMINI_API_KEY is not configured.');
    }
    return null;
  }

  return new GoogleGenAI({ apiKey });
}

function validateEmbedding(values: unknown): number[] {
  if (!Array.isArray(values) || values.length !== EXPECTED_VECTOR_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch. Expected ${EXPECTED_VECTOR_DIMENSION}, received ${
        Array.isArray(values) ? values.length : 0
      }.`
    );
  }

  const vector = values.map(Number);

  if (
    vector.some(
      (value) => !Number.isFinite(value)
    )
  ) {
    throw new Error('Embedding contains a non-finite value.');
  }

  return vector;
}

function vectorToPgLiteral(vector: number[]): string {
  validateEmbedding(vector);
  return `[${vector.join(',')}]`;
}

function normalizeTopK(topK: number): number {
  if (!Number.isInteger(topK) || topK < 1) return 4;
  return Math.min(topK, 20);
}

/**
 * Generates a Gemini embedding with an explicit output dimension so the
 * application and pgvector schema cannot silently disagree.
 *
 * Google currently supports configurable dimensions for Gemini embedding
 * models. The default here is 768 because the database schema uses
 * vector(768).
 */
export async function generateTextEmbedding(
  text: string,
  purpose: 'document' | 'query' = 'query',
  title?: string
): Promise<number[] | null> {
  const cleanText = text.trim();

  if (!cleanText) {
    return null;
  }

  requireProductionInfrastructure();

  const ai = getGeminiClient();
  if (!ai) return null;

  try {
    const config: Record<string, unknown> = {
      outputDimensionality: EXPECTED_VECTOR_DIMENSION,
    };

    // gemini-embedding-001 supports task types; Gemini Embedding 2 does not.
    if (EMBEDDING_MODEL === 'gemini-embedding-001') {
      config.taskType =
        purpose === 'document'
          ? 'RETRIEVAL_DOCUMENT'
          : 'RETRIEVAL_QUERY';

      if (purpose === 'document' && title) {
        config.title = title;
      }
    } else if (EMBEDDING_MODEL === 'gemini-embedding-2') {
      // Gemini Embedding 2 does not use taskType. The query/document role is
      // expressed in the input itself so both sides are embedded consistently.
      if (purpose === 'document') {
        // Do not alter the stored transcript content. Only the embedding input
        // receives the retrieval instruction.
      }
    }

    const embeddingInput =
      EMBEDDING_MODEL === 'gemini-embedding-2'
        ? purpose === 'document'
          ? `Represent this sales knowledge-base passage for semantic retrieval:\n${cleanText}`
          : `Represent this sales question for semantic retrieval:\n${cleanText}`
        : cleanText;

    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: embeddingInput,
      config,
    });

    const values =
      response.embeddings?.[0]?.values ??
      (response as any).embedding?.values;

    return validateEmbedding(values);
  } catch (err) {
    console.error(
      `Embedding generation failed using ${EMBEDDING_MODEL}:`,
      err
    );

    if (isProduction) {
      throw new Error('Failed to generate knowledge-base embedding.');
    }

    return null;
  }
}

/**
 * Splits transcript text into overlapping chunks.
 * Chunking is character-oriented with sentence/paragraph boundaries preserved
 * where possible.
 */
export function chunkText(
  text: string,
  chunkSize = 1200,
  overlap = 180
): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();

  if (!clean) return [];

  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 200 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= chunkSize
  ) {
    throw new Error('Invalid chunkSize/overlap configuration.');
  }

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];

  for (const paragraph of paragraphs) {
    const sentences = paragraph
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (sentences.length > 0) {
      units.push(...sentences);
    }
  }

  if (units.length === 0) return [];

  const chunks: string[] = [];
  let current = '';

  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }

    const candidate = `${current} ${unit}`;

    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    chunks.push(current.trim());

    const words = current.split(/\s+/);
    const targetOverlapWords = Math.max(
      1,
      Math.floor(overlap / 6)
    );

    const overlapWords = words.slice(-targetOverlapWords);
    current = `${overlapWords.join(' ')} ${unit}`.trim();

    // A single unusually large sentence should still be handled.
    if (current.length > chunkSize) {
      let start = 0;

      while (start < current.length) {
        const end = Math.min(start + chunkSize, current.length);
        const piece = current.slice(start, end).trim();

        if (piece) chunks.push(piece);

        if (end >= current.length) {
          current = '';
          break;
        }

        start = Math.max(end - overlap, start + 1);
      }
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Ingests a transcript into PostgreSQL with actual vector embeddings.
 *
 * In production:
 * - PostgreSQL is mandatory.
 * - Every chunk must have an embedding.
 * - Document + chunks are inserted in one DB transaction.
 * - The memory database is never populated.
 */
export async function ingestTranscript(params: {
  title: string;
  rawText: string;
  sourceType: 'txt' | 'paste' | 'pdf' | 'docx';
  createdBy?: string;
}): Promise<KnowledgeDocument> {
  requireProductionInfrastructure();

  const title = params.title.trim();
  const sanitizedText = params.rawText.trim();

  if (!title || title.length > 255) {
    throw new Error('Transcript title is required and must be 255 characters or less.');
  }

  if (sanitizedText.length < 20) {
    throw new Error(
      'Transcript text is too short to be processed (minimum 20 characters).'
    );
  }

  const hash = crypto
    .createHash('sha256')
    .update(sanitizedText, 'utf8')
    .digest('hex');

  // Deduplication is authoritative in PostgreSQL when PostgreSQL is configured.
  if (pgPool) {
    const existing = await dbQuery<{ id: string; title: string }>(
      `SELECT id, title
       FROM knowledge_documents
       WHERE content_hash = $1
       LIMIT 1`,
      [hash]
    );

    if (existing?.rows.length) {
      throw new Error(
        `This transcript has already been uploaded as "${existing.rows[0].title}".`
      );
    }
  } else {
    requireProductionInfrastructure();

    for (const doc of memDb.knowledgeDocuments.values()) {
      if (doc.content_hash === hash) {
        throw new Error(
          `This transcript has already been uploaded as "${doc.title}".`
        );
      }
    }
  }

  const chunks = chunkText(sanitizedText);

  if (chunks.length === 0) {
    throw new Error('No usable transcript chunks were generated.');
  }

  const docId = crypto.randomUUID();
  const now = new Date().toISOString();

  const chunkData: Array<{
    id: string;
    content: string;
    embedding: number[] | null;
  }> = [];

  for (const chunkContent of chunks) {
    const embedding = await generateTextEmbedding(
      chunkContent,
      'document',
      title
    );

    if (pgPool && !embedding) {
      throw new Error(
        'Failed to generate an embedding for a transcript chunk.'
      );
    }

    chunkData.push({
      id: crypto.randomUUID(),
      content: chunkContent,
      embedding,
    });
  }

  const doc: KnowledgeDocument = {
    id: docId,
    title,
    source_type: params.sourceType,
    content_hash: hash,
    raw_text: sanitizedText,
    total_chunks: chunks.length,
    created_by: params.createdBy || null,
    is_active: true,
    created_at: now,
  };

  if (pgPool) {
    const client = await pgPool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO knowledge_documents
         (id, title, source_type, content_hash, raw_text, total_chunks, created_by, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
        [
          docId,
          doc.title,
          doc.source_type,
          hash,
          sanitizedText,
          chunks.length,
          doc.created_by,
          now,
        ]
      );

      for (let idx = 0; idx < chunkData.length; idx++) {
        const item = chunkData[idx];

        if (!item.embedding) {
          throw new Error(
            `Missing embedding for chunk ${idx + 1}.`
          );
        }

        await client.query(
          `INSERT INTO knowledge_chunks
           (id, document_id, chunk_index, content, token_count, embedding, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7)`,
          [
            item.id,
            docId,
            idx,
            item.content,
            item.content.split(/\s+/).length,
            vectorToPgLiteral(item.embedding),
            now,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Development/test-only memory adapter.
    memDb.knowledgeDocuments.set(docId, doc);

    chunkData.forEach((item, idx) => {
      memDb.knowledgeChunks.push({
        id: item.id,
        document_id: docId,
        chunk_index: idx,
        content: item.content,
        token_count: item.content.split(/\s+/).length,
        embedding: item.embedding || undefined,
        created_at: now,
      });
    });
  }

  createAuditLog({
    userId: params.createdBy,
    action: 'transcript_ingested',
    resource: 'knowledge_base',
    details: {
      documentId: docId,
      title,
      totalChunks: chunks.length,
      characterCount: sanitizedText.length,
      embeddingsGenerated: chunkData.filter(
        (c) => c.embedding !== null
      ).length,
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimension: EXPECTED_VECTOR_DIMENSION,
    },
  });

  return doc;
}

/**
 * Semantic pgvector retrieval.
 *
 * Uses cosine distance (<=>) and filters out inactive documents and chunks
 * without embeddings. There is deliberately no keyword fallback in production.
 */
export async function retrieveRelevantChunksAsync(
  query: string,
  topK = 4,
  queryEmbedding?: number[]
): Promise<string[]> {
  requireProductionInfrastructure();

  const cleanQuery = query.trim();

  if (!cleanQuery) return [];

  const safeTopK = normalizeTopK(topK);

  let embeddingToUse = queryEmbedding;

  if (embeddingToUse) {
    embeddingToUse = validateEmbedding(embeddingToUse);
  } else {
    const generatedEmbedding = await generateTextEmbedding(
      cleanQuery,
      'query'
    );

    if (!generatedEmbedding) {
      if (isProduction) {
        throw new Error('Unable to generate query embedding.');
      }
    } else {
      embeddingToUse = generatedEmbedding;
    }
  }

  if (pgPool) {
    if (!embeddingToUse) {
      throw new Error('Unable to generate query embedding.');
    }

    const vectorStr = vectorToPgLiteral(embeddingToUse);

    const res = await dbQuery<{ content: string }>(
      `SELECT kc.content
       FROM knowledge_chunks kc
       INNER JOIN knowledge_documents kd
         ON kd.id = kc.document_id
       WHERE kd.is_active = TRUE
         AND kc.embedding IS NOT NULL
       ORDER BY kc.embedding <=> $1::vector
       LIMIT $2`,
      [vectorStr, safeTopK]
    );

    return res?.rows.map((row) => row.content) || [];
  }

  // Development/test-only fallback.
  if (embeddingToUse) {
    const embedded = memDb.knowledgeChunks.filter(
      (chunk) =>
        memDb.knowledgeDocuments.get(chunk.document_id)?.is_active &&
        Array.isArray(chunk.embedding) &&
        chunk.embedding.length === EXPECTED_VECTOR_DIMENSION
    );

    if (embedded.length > 0) {
      const ranked = embedded
        .map((chunk) => ({
          chunk,
          score: cosineSimilarity(
            embeddingToUse!,
            chunk.embedding as number[]
          ),
        }))
        .sort((a, b) => b.score - a.score);

      return ranked
        .slice(0, safeTopK)
        .map((item) => item.chunk.content);
    }
  }

  return retrieveRelevantChunks(cleanQuery, safeTopK);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (
    a.length !== b.length ||
    a.length !== EXPECTED_VECTOR_DIMENSION
  ) {
    return -1;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return -1;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Development/test-only keyword retrieval.
 * Production never falls back to this method.
 */
export function retrieveRelevantChunks(
  query: string,
  topK = 4
): string[] {
  if (isProduction) {
    throw new Error(
      'Keyword retrieval fallback is disabled in production.'
    );
  }

  const safeTopK = normalizeTopK(topK);

  const activeDocIds = new Set<string>();

  for (const doc of memDb.knowledgeDocuments.values()) {
    if (doc.is_active) {
      activeDocIds.add(doc.id);
    }
  }

  const queryTerms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((term) => term.length > 2);

  if (queryTerms.length === 0) {
    return memDb.knowledgeChunks
      .filter((chunk) => activeDocIds.has(chunk.document_id))
      .slice(0, safeTopK)
      .map((chunk) => chunk.content);
  }

  const scored = memDb.knowledgeChunks
    .filter((chunk) => activeDocIds.has(chunk.document_id))
    .map((chunk) => {
      const text = chunk.content.toLowerCase();
      let score = 0;

      for (const term of queryTerms) {
        if (text.includes(term)) {
          score += 1;
        }
      }

      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored
    .slice(0, safeTopK)
    .map((item) => item.chunk.content);
}
