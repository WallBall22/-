import { createHmac, timingSafeEqual } from 'node:crypto';
import { SendError } from './types.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Validates Meta's `X-Hub-Signature-256: sha256=<hex>` header: an HMAC-SHA256 of the exact raw request
 * body keyed with the app secret. Must run on the raw bytes, never on re-serialized JSON.
 */
export function verifyHubSignature(rawBody: Buffer, header: string | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, match[1]!.toLowerCase());
}

/** The GET handshake Meta sends when a webhook is registered: echo `hub.challenge` if the token matches. */
export function verifyHubChallenge(query: Record<string, unknown>, verifyToken: string | undefined): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (!verifyToken || mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
  if (challenge.length === 0 || challenge.length > 512) return null;
  return safeEqual(token, verifyToken) ? challenge : null;
}

/** Meta error codes that indicate throttling or temporary problems, so the send is worth retrying. */
const RETRYABLE_META_CODES = new Set([
  1, // unknown error
  2, // service temporarily unavailable
  4, // application request limit reached
  17, // user request limit reached
  32, // page request limit reached
  613, // calls within one hour exceeded
  80007, // rate limit (WhatsApp / Messenger business)
  130429, // WhatsApp throughput rate limit
  131016, // WhatsApp service unavailable
  131056, // WhatsApp pair rate limit
]);

interface GraphErrorBody {
  error?: { code?: number; error_subcode?: number; message?: string };
}

/** POSTs JSON to a Graph API endpoint with a bearer token and maps failures to retryable/permanent SendErrors. */
export async function graphPost<T>(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new SendError(true, timeout ? 'timeout' : 'network', timeout ? 'send timed out' : 'network error', { cause: error });
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (response.ok) return json as T;

  const metaError = (json as GraphErrorBody | null)?.error;
  const code = metaError?.code;
  const retryable = response.status === 429 || response.status >= 500 || (code !== undefined && RETRYABLE_META_CODES.has(code));
  const errorCode = `http_${response.status}${code !== undefined ? `_${code}` : ''}`;
  // Only the platform's error message is kept; it does not contain the token.
  throw new SendError(retryable, errorCode, metaError?.message?.slice(0, 300) ?? `HTTP ${response.status}`);
}

export function graphUrl(base: string, version: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${version}/${path.replace(/^\/+/, '')}`;
}
