import type { KnowledgePassage } from '../knowledge/repository.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  instructions: string;
  /** Prior turns (oldest first), excluding the current customer message. */
  history: ChatTurn[];
  knowledgeBlock: string;
  customerMessage: string;
  maxOutputTokens: number;
  /** Raw passages, for providers that do not call a model (offline). */
  passages: KnowledgePassage[];
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiResult {
  /** The model's raw output: a JSON document matching REPLY_JSON_SCHEMA. */
  rawOutput: string;
  model: string;
  usage: AiUsage;
}

export type AiErrorKind = 'timeout' | 'rate_limited' | 'unavailable' | 'invalid_request' | 'auth' | 'incomplete' | 'refused';

export class AiError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiError';
  }
}

export interface AiProvider {
  readonly name: string;
  generate(request: AiRequest): Promise<AiResult>;
}
