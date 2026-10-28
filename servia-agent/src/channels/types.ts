import type { Channel } from '../database/schema.js';

/** A customer message in the channel-independent internal format. */
export interface NormalizedInbound {
  channel: Channel;
  /** Business-side account that received it (WhatsApp phone number ID, Page ID, Instagram account ID). */
  platformAccountId: string;
  senderId: string;
  senderName: string | null;
  platformMessageId: string;
  /** Message text, or null for content the agent cannot read (image, audio, sticker, location…). */
  text: string | null;
  contentType: string;
  timestamp: Date | null;
}

export type DeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

export interface DeliveryStatusUpdate {
  channel: Channel;
  platformMessageId: string;
  status: DeliveryState;
  errorCode: string | null;
}

export interface ParsedWebhook {
  messages: NormalizedInbound[];
  statuses: DeliveryStatusUpdate[];
  /** Events deliberately ignored (echoes, reactions, read receipts we do not track, …). */
  ignored: number;
}

export interface SendContext {
  platformAccountId: string;
}

export interface SendResult {
  platformMessageId: string | null;
}

/** A send failure. `retryable` distinguishes transient errors (rate limits, 5xx, network) from permanent ones. */
export class SendError extends Error {
  constructor(
    public readonly retryable: boolean,
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SendError';
  }
}

export interface ChannelSender {
  readonly channel: Channel;
  /** Platform limit on one text message, in UTF-8 bytes. */
  readonly maxMessageBytes: number;
  send(recipientId: string, text: string, context: SendContext): Promise<SendResult>;
}

export interface ChannelAdapter extends ChannelSender {
  /** Handles the GET subscription handshake. Returns the challenge to echo, or null to reject. */
  verifySubscription(query: Record<string, unknown>): string | null;
  /** Validates `X-Hub-Signature-256` against the raw request body. */
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parse(payload: unknown): ParsedWebhook;
}

/** Cuts text to a UTF-8 byte budget without splitting a character, adding an ellipsis when cut. */
export function fitToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8');
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out.trimEnd()}${ellipsis}`;
}
