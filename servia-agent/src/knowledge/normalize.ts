/**
 * Text normalization shared by indexing and querying. Both sides must use the same function,
 * otherwise full-text matches silently fail.
 */

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const EASTERN_ARABIC_DIGITS = /[۰-۹]/g;

// Definite-article prefixes ("ال" with optional و/ب/ف/ك/ل). Only stripped when a real stem remains.
const ARABIC_PREFIX = /^(?:وال|بال|فال|كال|لل|ال)(?=\p{L}{2,})/u;

const STOPWORDS = new Set(
  [
    // English
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
    'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'i', 'you', 'we', 'they', 'he',
    'she', 'it', 'me', 'my', 'your', 'our', 'this', 'that', 'these', 'those', 'what', 'which', 'who',
    'can', 'could', 'would', 'should', 'will', 'please', 'hi', 'hello', 'hey', 'thanks', 'thank', 'about',
    'have', 'has', 'any', 'there', 'so', 'just', 'want', 'need', 'know', 'tell', 'us', 'as',
    // Arabic (MSA and Egyptian); normalized forms
    'في', 'من', 'علي', 'الي', 'عن', 'مع', 'او', 'ثم', 'هل', 'ما', 'ماذا', 'لا', 'نعم', 'انا', 'انت', 'انتم',
    'احنا', 'نحن', 'هو', 'هي', 'هم', 'ده', 'دي', 'دا', 'دول', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'ايه',
    'عايز', 'عاوز', 'عايزه', 'محتاج', 'ممكن', 'لو', 'يا', 'اهلا', 'مرحبا', 'السلام', 'عليكم', 'شكرا', 'و',
    'بس', 'كمان', 'عند', 'عندكم', 'ازاي', 'اللي', 'كده', 'طيب',
  ].map((w) => baseNormalize(w)),
);

function baseNormalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

function stem(token: string): string {
  if (/^\p{Script=Arabic}+$/u.test(token)) return token.replace(ARABIC_PREFIX, '');
  if (/^[a-z]+$/.test(token) && token.length > 3) {
    if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  }
  return token;
}

/** Normalized, stemmed, stopword-free tokens. Only letters and digits survive, so tokens are safe in tsquery. */
export function tokenize(text: string): string[] {
  return baseNormalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1 || /\d/.test(t));
}

/** The string stored in `knowledge_chunks.normalized_content` and fed to `to_tsvector('simple', …)`. */
export function normalizeForIndex(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * Builds an OR-ed prefix tsquery from user text, e.g. `clinic:* | receptionist:*`.
 * Returns null when nothing searchable remains (greetings, punctuation, stopwords).
 */
export function buildTsQuery(text: string, maxTerms = 16): string | null {
  const unique = [...new Set(tokenize(text))].slice(0, maxTerms);
  if (unique.length === 0) return null;
  return unique.map((t) => (t.length >= 3 ? `${t}:*` : t)).join(' | ');
}

/** Rough language detection for fallback messages: Arabic script vs everything else. */
export function detectLanguage(text: string): 'ar' | 'en' {
  const arabic = (text.match(/\p{Script=Arabic}/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic >= latin ? 'ar' : 'en';
}
