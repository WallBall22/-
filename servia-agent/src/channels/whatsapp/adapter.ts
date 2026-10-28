import { z } from 'zod';
import { graphPost, graphUrl, verifyHubChallenge, verifyHubSignature, type FetchLike } from '../meta.js';
import type { ChannelAdapter, DeliveryStatusUpdate, NormalizedInbound, ParsedWebhook, SendContext, SendResult } from '../types.js';

export interface WhatsAppConfig {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  phoneNumberId: string;
  graphBaseUrl: string;
  graphVersion: string;
  sendTimeoutMs: number;
}

const messageSchema = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  button: z.looseObject({ text: z.string() }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ title: z.string() }).optional(),
      list_reply: z.looseObject({ title: z.string() }).optional(),
    })
    .optional(),
});

const statusSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  errors: z.array(z.looseObject({ code: z.number().optional() })).optional(),
});

const valueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.string() }),
  contacts: z.array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() })).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const payloadSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.looseObject({
      changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).default([]),
    }),
  ),
});

const sendResponseSchema = z.looseObject({ messages: z.array(z.looseObject({ id: z.string() })).optional() });

const STATUS_MAP: Record<string, DeliveryStatusUpdate['status'] | undefined> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/** WhatsApp Business Platform (Cloud API) adapter. */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  // Cloud API text bodies are limited to 4096 characters; bytes is the conservative bound.
  readonly maxMessageBytes = 4_096;

  constructor(
    private readonly config: WhatsAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  verifySubscription(query: Record<string, unknown>): string | null {
    return verifyHubChallenge(query, this.config.verifyToken);
  }

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    return verifyHubSignature(rawBody, header, this.config.appSecret);
  }

  parse(payload: unknown): ParsedWebhook {
    const result: ParsedWebhook = { messages: [], statuses: [], ignored: 0 };
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      result.ignored += 1;
      return result;
    }
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const value = valueSchema.safeParse(change.value);
        if (change.field !== 'messages' || !value.success) {
          result.ignored += 1;
          continue;
        }
        const phoneNumberId = value.data.metadata.phone_number_id;
        if (phoneNumberId !== this.config.phoneNumberId) {
          // Events for another number on the same app are not ours to answer.
          result.ignored += 1;
          continue;
        }
        const names = new Map((value.data.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

        for (const raw of value.data.messages ?? []) {
          const m = messageSchema.safeParse(raw);
          if (!m.success || m.data.type === 'reaction' || m.data.type === 'system') {
            result.ignored += 1;
            continue;
          }
          result.messages.push(this.normalize(m.data, phoneNumberId, names.get(m.data.from) ?? null));
        }
        for (const raw of value.data.statuses ?? []) {
          const s = statusSchema.safeParse(raw);
          const status = s.success ? STATUS_MAP[s.data.status] : undefined;
          if (!s.success || !status) {
            result.ignored += 1;
            continue;
          }
          const code = s.data.errors?.[0]?.code;
          result.statuses.push({
            channel: 'whatsapp',
            platformMessageId: s.data.id,
            status,
            errorCode: code !== undefined ? `wa_${code}` : null,
          });
        }
      }
    }
    return result;
  }

  private normalize(m: z.infer<typeof messageSchema>, phoneNumberId: string, name: string | null): NormalizedInbound {
    const text =
      m.type === 'text'
        ? (m.text?.body ?? '')
        : m.type === 'button'
          ? (m.button?.text ?? null)
          : m.type === 'interactive'
            ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null)
            : null;
    const seconds = m.timestamp ? Number(m.timestamp) : Number.NaN;
    return {
      channel: 'whatsapp',
      platformAccountId: phoneNumberId,
      senderId: m.from,
      senderName: name,
      platformMessageId: m.id,
      text,
      contentType: text === null ? m.type : 'text',
      timestamp: Number.isFinite(seconds) ? new Date(seconds * 1000) : null,
    };
  }

  async send(recipientId: string, text: string, _context: SendContext): Promise<SendResult> {
    const url = graphUrl(this.config.graphBaseUrl, this.config.graphVersion, `${this.config.phoneNumberId}/messages`);
    const response = await graphPost<unknown>(
      this.fetchImpl,
      url,
      this.config.accessToken,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipientId, type: 'text', text: { preview_url: false, body: text } },
      this.config.sendTimeoutMs,
    );
    const parsed = sendResponseSchema.safeParse(response);
    return { platformMessageId: parsed.success ? (parsed.data.messages?.[0]?.id ?? null) : null };
  }
}
