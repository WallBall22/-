import { detectLanguage } from '../knowledge/normalize.js';
import type { KnowledgeSearch } from '../knowledge/repository.js';
import type { Logger } from '../observability/logger.js';
import { isHumanRequest, validateModelOutput, type GuardViolation } from './guards.js';
import { canned } from './messages.js';
import { buildSystemPrompt, formatKnowledge } from './prompt.js';
import { AiError, type AiProvider, type AiUsage, type ChatTurn } from './provider.js';

export type ReplyOutcome =
  | 'answered'
  | 'handoff_requested'
  | 'empty_input'
  | 'unsupported_content'
  | 'guarded'
  | 'model_error';

export interface AgentReply {
  text: string;
  needsHuman: boolean;
  sourceIds: string[];
  outcome: ReplyOutcome;
  model: string | null;
  usage: AiUsage | null;
  /** Safe, non-sensitive reason when the reply is a fallback (guard violation or AI error kind). */
  errorCode: GuardViolation | AiError['kind'] | null;
}

export interface AgentInput {
  /** The customer's text, or null for non-text content (image, audio, sticker…). */
  text: string | null;
  history: ChatTurn[];
}

export interface AgentOptions {
  provider: AiProvider;
  knowledge: KnowledgeSearch;
  logger: Logger;
  topK: number;
  minRank: number;
  maxOutputTokens: number;
  maxInboundChars: number;
  humanFollowupTimeframe?: string;
}

/** Produces one grounded reply for one inbound customer message. Never throws for model problems. */
export class Agent {
  private readonly instructions: string;

  constructor(private readonly options: AgentOptions) {
    this.instructions = buildSystemPrompt({ humanFollowupTimeframe: options.humanFollowupTimeframe });
  }

  async reply(input: AgentInput): Promise<AgentReply> {
    const o = this.options;
    const cannedOpts = { humanFollowupTimeframe: o.humanFollowupTimeframe };
    const lastText = [...input.history].reverse().find((t) => t.role === 'user')?.content ?? '';
    const base = { sourceIds: [], model: null, usage: null, errorCode: null };

    if (input.text === null) {
      return { ...base, text: canned.unsupported(detectLanguage(lastText)), needsHuman: false, outcome: 'unsupported_content' };
    }
    const message = input.text.trim().slice(0, o.maxInboundChars);
    const lang = detectLanguage(message || lastText);
    if (!message) {
      return { ...base, text: canned.empty(lang), needsHuman: false, outcome: 'empty_input' };
    }
    if (isHumanRequest(message)) {
      return { ...base, text: canned.handoff(lang, cannedOpts), needsHuman: true, outcome: 'handoff_requested' };
    }

    const passages = await o.knowledge.search(message, { topK: o.topK, minRank: o.minRank });

    try {
      const result = await o.provider.generate({
        instructions: this.instructions,
        history: input.history,
        knowledgeBlock: formatKnowledge(passages),
        customerMessage: message,
        maxOutputTokens: o.maxOutputTokens,
        passages,
      });
      const checked = validateModelOutput(result.rawOutput, passages, this.instructions);
      if (!checked.ok) {
        o.logger.warn({ violation: checked.violation, model: result.model }, 'model reply blocked by guard');
        return {
          text: canned.fallback(lang, cannedOpts),
          needsHuman: true,
          sourceIds: [],
          outcome: 'guarded',
          model: result.model,
          usage: result.usage,
          errorCode: checked.violation,
        };
      }
      return {
        text: checked.output.reply,
        needsHuman: checked.output.needsHuman,
        sourceIds: checked.output.sourceIds,
        outcome: 'answered',
        model: result.model,
        usage: result.usage,
        errorCode: null,
      };
    } catch (error) {
      const kind = error instanceof AiError ? error.kind : 'unavailable';
      o.logger.error({ kind, provider: o.provider.name }, 'model call failed; sending fallback');
      return { ...base, text: canned.fallback(lang, cannedOpts), needsHuman: true, outcome: 'model_error', errorCode: kind };
    }
  }
}
