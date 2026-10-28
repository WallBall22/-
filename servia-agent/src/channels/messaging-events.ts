import { z } from 'zod';
import type { Channel } from '../database/schema.js';
import type { DeliveryStatusUpdate, NormalizedInbound, ParsedWebhook } from './types.js';

/**
 * Messenger and Instagram messaging webhooks share the `entry[].messaging[]` event shape
 * (sender, recipient, timestamp, message{mid,text,is_echo,attachments}, delivery, read, postback…).
 */
const eventSchema = z.looseObject({
  sender: z.looseObject({ id: z.string() }),
  recipient: z.looseObject({ id: z.string() }),
  timestamp: z.number().optional(),
  message: z
    .looseObject({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      attachments: z.array(z.looseObject({ type: z.string().optional() })).optional(),
      quick_reply: z.looseObject({ payload: z.string().optional() }).optional(),
    })
    .optional(),
  delivery: z.looseObject({ mids: z.array(z.string()).optional() }).optional(),
});

export function parseMessagingEntries(
  channel: Extract<Channel, 'messenger' | 'instagram'>,
  object: string,
  payload: unknown,
): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [], ignored: 0 };
  const parsed = z
    .looseObject({
      object: z.literal(object),
      entry: z.array(z.looseObject({ id: z.string(), messaging: z.array(z.unknown()).default([]) })),
    })
    .safeParse(payload);
  if (!parsed.success) {
    result.ignored += 1;
    return result;
  }

  for (const entry of parsed.data.entry) {
    for (const raw of entry.messaging) {
      const e = eventSchema.safeParse(raw);
      if (!e.success) {
        result.ignored += 1;
        continue;
      }
      const ev = e.data;
      if (ev.delivery?.mids) {
        for (const mid of ev.delivery.mids) {
          const update: DeliveryStatusUpdate = { channel, platformMessageId: mid, status: 'delivered', errorCode: null };
          result.statuses.push(update);
        }
        continue;
      }
      // Echoes of our own replies, and anything sent by the business account itself, are not customer messages.
      if (!ev.message || ev.message.is_echo || ev.sender.id === entry.id) {
        result.ignored += 1;
        continue;
      }
      const text = ev.message.text ?? null;
      const inbound: NormalizedInbound = {
        channel,
        platformAccountId: entry.id,
        senderId: ev.sender.id,
        senderName: null,
        platformMessageId: ev.message.mid,
        text,
        contentType: text !== null ? 'text' : (ev.message.attachments?.[0]?.type ?? 'unknown'),
        timestamp: ev.timestamp ? new Date(ev.timestamp) : null,
      };
      result.messages.push(inbound);
    }
  }
  return result;
}
