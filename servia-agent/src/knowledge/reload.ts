import type { Database } from '../database/client.js';
import type { Logger } from '../observability/logger.js';
import { loadKnowledgeDirectory } from './loader.js';
import { replaceKnowledge, type ReloadStats } from './repository.js';

export interface KnowledgeReloadResult extends ReloadStats {
  warnings: string[];
}

/** Reads the knowledge directory and syncs it into the database. Refuses to wipe everything by accident. */
export async function reloadKnowledge(db: Database, dir: string, logger?: Logger): Promise<KnowledgeReloadResult> {
  const { documents, warnings } = await loadKnowledgeDirectory(dir);
  if (documents.length === 0) {
    throw new Error(`No knowledge documents found in ${dir}; refusing to replace the existing knowledge base`);
  }
  const stats = await replaceKnowledge(db, documents);
  for (const warning of warnings) logger?.warn({ warning }, 'knowledge warning');
  logger?.info(
    { documents: stats.documents, chunks: stats.chunks, updated: stats.updated.length, removed: stats.removed.length },
    'knowledge reloaded',
  );
  return { ...stats, warnings };
}
