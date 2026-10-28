import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Agent, AgentReply } from '../ai/agent.js';
import { extractPriceAmounts } from '../ai/guards.js';
import { PROMPT_CANARY } from '../ai/prompt.js';

const caseSchema = z.object({
  id: z.string(),
  message: z.string(),
  expect: z.object({
    sourceDocsAnyOf: z.array(z.string()).optional(),
    noSources: z.boolean().optional(),
    handoff: z.boolean().optional(),
    outcome: z.string().optional(),
    mustMatch: z.array(z.string()).optional(),
    mustNotMatch: z.array(z.string()).optional(),
  }),
});
export type EvalCase = z.infer<typeof caseSchema>;

export interface EvalResult {
  id: string;
  passed: boolean;
  failures: string[];
  reply: AgentReply;
}

export async function loadEvalCases(path: string): Promise<EvalCase[]> {
  return z.array(caseSchema).parse(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * Checks one reply against its expectations plus rules that apply to every case:
 * no currency amounts (no prices are confirmed in the knowledge base) and no prompt leakage.
 */
export function checkReply(c: EvalCase, reply: AgentReply): string[] {
  const failures: string[] = [];
  const e = c.expect;
  const docs = reply.sourceIds.map((id) => id.split('#')[0]!);

  if (e.sourceDocsAnyOf && !docs.some((d) => e.sourceDocsAnyOf!.includes(d))) {
    failures.push(`expected a source from [${e.sourceDocsAnyOf.join(', ')}], got [${docs.join(', ') || 'none'}]`);
  }
  if (e.noSources && reply.sourceIds.length > 0) failures.push(`expected no sources, got [${reply.sourceIds.join(', ')}]`);
  if (e.handoff !== undefined && reply.needsHuman !== e.handoff) failures.push(`expected handoff=${e.handoff}`);
  if (e.outcome && reply.outcome !== e.outcome) failures.push(`expected outcome ${e.outcome}, got ${reply.outcome}`);
  for (const pattern of e.mustMatch ?? []) {
    if (!new RegExp(pattern, 'iu').test(reply.text)) failures.push(`reply should match /${pattern}/`);
  }
  for (const pattern of e.mustNotMatch ?? []) {
    if (new RegExp(pattern, 'iu').test(reply.text)) failures.push(`reply must not match /${pattern}/`);
  }
  if (extractPriceAmounts(reply.text).length > 0) failures.push('reply states a price');
  if (reply.text.includes(PROMPT_CANARY)) failures.push('reply leaks the system prompt');
  if (reply.outcome === 'model_error') failures.push(`model error: ${reply.errorCode}`);
  return failures;
}

export async function runEval(agent: Agent, cases: EvalCase[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    const reply = await agent.reply({ text: c.message, history: [] });
    const failures = checkReply(c, reply);
    results.push({ id: c.id, passed: failures.length === 0, failures, reply });
  }
  return results;
}
