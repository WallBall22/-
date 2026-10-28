/** Fixed replies used when the model is not called or its answer cannot be used. */

export type Lang = 'ar' | 'en';

export interface CannedOptions {
  humanFollowupTimeframe?: string;
}

const followup = (lang: Lang, timeframe?: string) => {
  if (!timeframe) return lang === 'ar' ? 'وهيتابعوا معاك.' : 'and they will follow up with you.';
  return lang === 'ar' ? `وهيتابعوا معاك ${timeframe}.` : `and they will follow up with you ${timeframe}.`;
};

export const canned = {
  /** Model unavailable, timed out, or its answer failed validation. */
  fallback(lang: Lang, o: CannedOptions = {}): string {
    return lang === 'ar'
      ? `آسفين، مش قادر أجاوب على ده بدقة دلوقتي. حوّلت رسالتك لفريق سيرفيا ${followup('ar', o.humanFollowupTimeframe)}`
      : `Sorry, I can't answer that accurately right now. I've passed your message to the SERVIA team, ${followup('en', o.humanFollowupTimeframe)}`;
  },
  /** The customer explicitly asked for a person. */
  handoff(lang: Lang, o: CannedOptions = {}): string {
    return lang === 'ar'
      ? `أكيد. حوّلت طلبك لفريق سيرفيا ${followup('ar', o.humanFollowupTimeframe)}`
      : `Of course. I've passed your request to the SERVIA team, ${followup('en', o.humanFollowupTimeframe)}`;
  },
  /** Images, audio, stickers, etc. */
  unsupported(lang: Lang): string {
    return lang === 'ar'
      ? 'شكرًا لرسالتك! حاليًا أقدر أقرا الرسائل النصية بس. ممكن تكتبلي سؤالك؟'
      : 'Thanks for your message! I can only read text messages for now. Could you type your question?';
  },
  /** Empty or whitespace-only text. */
  empty(lang: Lang): string {
    return lang === 'ar'
      ? 'أهلًا بيك في سيرفيا! إزاي أقدر أساعدك؟'
      : 'Hi, welcome to SERVIA! How can I help you?';
  },
};
