import { z } from 'zod';
import type { KnowledgePassage } from '../knowledge/repository.js';
import { PROMPT_CANARY } from './prompt.js';

const modelOutputSchema = z.object({
  reply: z.string(),
  needs_human: z.boolean(),
  source_ids: z.array(z.string()).max(20),
});

export interface ParsedModelOutput {
  reply: string;
  needsHuman: boolean;
  sourceIds: string[];
}

export type GuardViolation = 'malformed_output' | 'empty_reply' | 'prompt_leak' | 'unsupported_price';

export type GuardResult = { ok: true; output: ParsedModelOutput } | { ok: false; violation: GuardViolation };

export const MAX_REPLY_CHARS = 1_200;

// A currency amount: a number next to a currency word or symbol, in either order.
const CURRENCY = String.raw`(?:\$|usd|dollars?|egp|l\.?e\.?|sar|aed|eur|€|£|gbp|جنيه|جنية|ج\.م|دولار|ريال|درهم|يورو)`;
const NUMBER = String.raw`\d[\d.,]*`;
const PRICE_PATTERN = new RegExp(`(${NUMBER})\\s*${CURRENCY}|${CURRENCY}\\s*(${NUMBER})`, 'giu');

function toAsciiDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Currency amounts stated in the text, as bare digit strings (e.g. "1,500 EGP" → "1500"). */
export function extractPriceAmounts(text: string): string[] {
  const amounts: string[] = [];
  for (const match of toAsciiDigits(text).matchAll(PRICE_PATTERN)) {
    const raw = match[1] ?? match[2] ?? '';
    const digits = raw.replace(/[.,]+$/, '').replace(/[^\d.]/g, '');
    if (digits) amounts.push(digits);
  }
  return amounts;
}

function leaksPrompt(reply: string, instructions: string): boolean {
  if (reply.includes(PROMPT_CANARY)) return true;
  // Any long verbatim run of the instructions in the reply is a leak.
  const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  const r = flat(reply);
  const ins = flat(instructions);
  const WINDOW = 80;
  for (let i = 0; i + WINDOW <= ins.length; i += 40) {
    if (r.includes(ins.slice(i, i + WINDOW))) return true;
  }
  return false;
}

/**
 * Validates the model's JSON output against the retrieved passages:
 * - the output must match the schema and contain a non-empty reply;
 * - the reply must not leak the system prompt;
 * - every currency amount in the reply must appear in a retrieved passage;
 * - source ids not among the retrieved passages are dropped.
 */
export function validateModelOutput(
  rawOutput: string,
  passages: KnowledgePassage[],
  instructions: string,
): GuardResult {
  let data: unknown;
  try {
    data = JSON.parse(rawOutput);
  } catch {
    return { ok: false, violation: 'malformed_output' };
  }
  const parsed = modelOutputSchema.safeParse(data);
  if (!parsed.success) return { ok: false, violation: 'malformed_output' };

  const reply = parsed.data.reply.trim();
  if (!reply) return { ok: false, violation: 'empty_reply' };
  if (leaksPrompt(reply, instructions)) return { ok: false, violation: 'prompt_leak' };

  const knownAmounts = new Set(passages.flatMap((p) => extractPriceAmounts(p.content)));
  if (extractPriceAmounts(reply).some((a) => !knownAmounts.has(a))) {
    return { ok: false, violation: 'unsupported_price' };
  }

  const allowed = new Set(passages.map((p) => p.id));
  return {
    ok: true,
    output: {
      reply: truncate(reply, MAX_REPLY_CHARS),
      needsHuman: parsed.data.needs_human,
      sourceIds: [...new Set(parsed.data.source_ids.filter((id) => allowed.has(id)))],
    },
  };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('؟ '), cut.lastIndexOf('\n'));
  return `${boundary > max * 0.6 ? cut.slice(0, boundary + 1) : cut}…`;
}

const HUMAN_REQUEST_PATTERNS = [
  /\b(talk|speak|chat)\s+(to|with)\s+(a\s+)?(human|person|someone|agent|representative|sales|team)\b/i,
  /\b(real|live)\s+(person|human|agent)\b/i,
  /\bhuman\s+(agent|support)\b/i,
  /(عايز|عاوز|محتاج|ممكن|اريد|أريد|اود|أود)\s+(اكلم|أكلم|اتكلم|أتكلم|اتواصل|أتواصل|التحدث|أتحدث|اتحدث)\s+(مع\s+)?(حد|شخص|موظف|بني\s*ادم|انسان|إنسان|المبيعات|الفريق|خدمة\s+العملاء)/,
  /(كلمني|كلموني)\s+(حد|موظف)/,
];

/** True when the customer explicitly asks for a human. Cheap and deterministic, checked before any model call. */
export function isHumanRequest(text: string): boolean {
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(text));
}
