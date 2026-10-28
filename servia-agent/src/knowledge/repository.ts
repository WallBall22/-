import { eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { knowledgeChunks, knowledgeDocuments } from '../database/schema.js';
import type { LoadedDocument } from './loader.js';
import { buildTsQuery, normalizeForIndex } from './normalize.js';

export interface KnowledgePassage {
  id: string;
  documentSlug: string;
  documentTitle: string;
  heading: string;
  content: string;
  rank: number;
}

export interface SearchOptions {
  topK: number;
  minRank: number;
}

export interface KnowledgeSearch {
  search(query: string, options: SearchOptions): Promise<KnowledgePassage[]>;
}

export interface ReloadStats {
  documents: number;
  chunks: number;
  updated: string[];
  unchanged: string[];
  removed: string[];
}

/** PostgreSQL full-text retrieval over `knowledge_chunks`. */
export class PgKnowledgeSearch implements KnowledgeSearch {
  constructor(private readonly db: Database) {}

  async search(query: string, { topK, minRank }: SearchOptions): Promise<KnowledgePassage[]> {
    const tsquery = buildTsQuery(query);
    if (!tsquery) return [];
    // The tsquery is passed as a bound parameter; tokens contain only letters and digits.
    const result = await this.db.execute<{
      id: string;
      slug: string;
      title: string;
      heading: string;
      content: string;
      rank: number;
    }>(sql`
      SELECT c.id, d.slug, d.title, c.heading, c.content,
             ts_rank_cd(c.search_vector, q.query)::float8 AS rank
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id,
           to_tsquery('simple', ${tsquery}) AS q(query)
      WHERE c.search_vector @@ q.query
      ORDER BY rank DESC, c.id ASC
      LIMIT ${topK}
    `);
    return result.rows
      .filter((r) => Number(r.rank) >= minRank)
      .map((r) => ({
        id: r.id,
        documentSlug: r.slug,
        documentTitle: r.title,
        heading: r.heading,
        content: r.content,
        rank: Number(r.rank),
      }));
  }
}

/**
 * Replaces the stored knowledge with the given documents in one transaction.
 * Unchanged files (same content hash) keep their chunks; removed files are deleted.
 */
export async function replaceKnowledge(db: Database, documents: LoadedDocument[]): Promise<ReloadStats> {
  return db.transaction(async (tx) => {
    const stats: ReloadStats = { documents: documents.length, chunks: 0, updated: [], unchanged: [], removed: [] };
    const slugs = documents.map((d) => d.slug);

    const removed = await tx
      .delete(knowledgeDocuments)
      .where(slugs.length ? notInArray(knowledgeDocuments.slug, slugs) : undefined)
      .returning({ slug: knowledgeDocuments.slug });
    stats.removed = removed.map((r) => r.slug);

    const existing = slugs.length
      ? await tx
          .select({ id: knowledgeDocuments.id, slug: knowledgeDocuments.slug, hash: knowledgeDocuments.contentHash })
          .from(knowledgeDocuments)
          .where(inArray(knowledgeDocuments.slug, slugs))
      : [];
    const bySlug = new Map(existing.map((e) => [e.slug, e]));

    for (const doc of documents) {
      stats.chunks += doc.sections.length;
      const current = bySlug.get(doc.slug);
      if (current && current.hash === doc.contentHash) {
        stats.unchanged.push(doc.slug);
        continue;
      }
      const [row] = await tx
        .insert(knowledgeDocuments)
        .values({ slug: doc.slug, title: doc.title, sourcePath: doc.sourcePath, contentHash: doc.contentHash })
        .onConflictDoUpdate({
          target: knowledgeDocuments.slug,
          set: { title: doc.title, sourcePath: doc.sourcePath, contentHash: doc.contentHash, updatedAt: new Date() },
        })
        .returning({ id: knowledgeDocuments.id });
      const documentId = row!.id;
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
      if (doc.sections.length > 0) {
        await tx.insert(knowledgeChunks).values(
          doc.sections.map((s, i) => ({
            id: `${doc.slug}#${i}`,
            documentId,
            chunkIndex: i,
            heading: s.heading,
            content: s.content,
            // Title, heading and keywords rank above body text, so "pricing" finds the pricing section first.
            normalizedHeading: normalizeForIndex(`${doc.title} ${s.heading} ${s.keywords ?? ''}`),
            normalizedContent: normalizeForIndex(s.content),
          })),
        );
      }
      stats.updated.push(doc.slug);
    }
    return stats;
  });
}
