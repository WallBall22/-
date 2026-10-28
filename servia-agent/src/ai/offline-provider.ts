import { detectLanguage } from '../knowledge/normalize.js';
import type { AiProvider, AiRequest, AiResult } from './provider.js';

/**
 * A deterministic, credential-free stand-in for the model, used by the local simulator and evaluation.
 * It answers with the best-matching passage text in the customer's script, or asks for team follow-up.
 * It is not a conversational model and is rejected in production by configuration.
 */
export class OfflineProvider implements AiProvider {
  readonly name = 'offline';

  async generate(request: AiRequest): Promise<AiResult> {
    const lang = detectLanguage(request.customerMessage);
    const top = request.passages[0];
    let output: { reply: string; needs_human: boolean; source_ids: string[] };

    if (!top) {
      output = {
        reply:
          lang === 'ar'
            ? 'معنديش معلومة مؤكدة عن ده هنا. تحب أحوّل سؤالك لفريق سيرفيا؟'
            : "I don't have verified information about that here. Would you like me to pass your question to the SERVIA team?",
        needs_human: false,
        source_ids: [],
      };
    } else {
      const paragraphs = top.content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      const inLanguage = paragraphs.filter((p) => detectLanguage(p) === lang);
      const text = (inLanguage.length > 0 ? inLanguage : paragraphs).join('\n').slice(0, 440);
      const unconfirmed = /UNCONFIRMED|غير مؤكد/.test(text);
      output = { reply: text, needs_human: unconfirmed, source_ids: [top.id] };
    }

    return {
      rawOutput: JSON.stringify(output),
      model: 'offline',
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}
