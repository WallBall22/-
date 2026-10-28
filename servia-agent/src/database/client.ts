import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(url: string, poolMax = 10): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  // Idle client errors (e.g. the server restarting) must not crash the process.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** Finds the `drizzle/` migrations folder both from `src/` (tsx) and `dist/src/` (compiled). */
export function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Could not find the drizzle migrations folder; set MIGRATIONS_DIR');
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: findMigrationsDir() });
}

export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
