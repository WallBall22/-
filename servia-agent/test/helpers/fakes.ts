import { pino } from 'pino';
import type { AiProvider, AiRequest, AiResult } from '../../src/ai/provider.js';
import type { KnowledgePassage, KnowledgeSearch } from '../../src/knowledge/repository.js';

export const silentLogger = pino({ level: 'silent' });

export function passage(id: string, content: string, overrides: Partial<KnowledgePassage> = {}): KnowledgePassage {
  return { id, documentSlug: id.split('#')[0]!, documentTitle: 'Doc', heading: 'Section', content, rank: 0.5, ...overrides };
}

export class FakeKnowledge implements KnowledgeSearch {
  queries: string[] = [];
  constructor(private readonly result: KnowledgePassage[] = []) {}
  async search(query: string): Promise<KnowledgePassage[]> {
    this.queries.push(query);
    return this.result;
  }
}

type Responder = (req: AiRequest) => AiResult | Promise<AiResult>;

/** A scripted model. Records every request so tests can assert what the model was given. */
export class FakeProvider implements AiProvider {
  readonly name = 'fake';
  requests: AiRequest[] = [];
  constructor(private readonly responder: Responder) {}

  static replying(reply: string, opts: { needsHuman?: boolean; sourceIds?: string[] } = {}): FakeProvider {
    return new FakeProvider(() => ({
      rawOutput: JSON.stringify({ reply, needs_human: opts.needsHuman ?? false, source_ids: opts.sourceIds ?? [] }),
      model: 'fake-model',
      usage: { inputTokens: 120, outputTokens: 30 },
    }));
  }

  async generate(request: AiRequest): Promise<AiResult> {
    this.requests.push(request);
    return this.responder(request);
  }
}
