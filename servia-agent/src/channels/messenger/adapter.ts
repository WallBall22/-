import { z } from 'zod';
import { parseMessagingEntries } from '../messaging-events.js';
import { graphPost, graphUrl, verifyHubChallenge, verifyHubSignature, type FetchLike } from '../meta.js';
import type { ChannelAdapter, ParsedWebhook, SendContext, SendResult } from '../types.js';

export interface MessengerConfig {
  appSecret: string;
  verifyToken: string;
  pageAccessToken: string;
  graphBaseUrl: string;
  graphVersion: string;
  sendTimeoutMs: number;
}

const sendResponseSchema = z.looseObject({ message_id: z.string().optional() });

/** Facebook Messenger (Messenger Platform Send API) adapter for one Page. */
export class MessengerAdapter implements ChannelAdapter {
  readonly channel = 'messenger' as const;
  // Messenger text messages are limited to 2000 characters.
  readonly maxMessageBytes = 2_000;

  constructor(
    private readonly config: MessengerConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  verifySubscription(query: Record<string, unknown>): string | null {
    return verifyHubChallenge(query, this.config.verifyToken);
  }

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    return verifyHubSignature(rawBody, header, this.config.appSecret);
  }

  parse(payload: unknown): ParsedWebhook {
    return parseMessagingEntries('messenger', 'page', payload);
  }

  async send(recipientId: string, text: string, _context: SendContext): Promise<SendResult> {
    const url = graphUrl(this.config.graphBaseUrl, this.config.graphVersion, 'me/messages');
    // messaging_type RESPONSE: a reply inside the 24-hour standard messaging window.
    const response = await graphPost<unknown>(
      this.fetchImpl,
      url,
      this.config.pageAccessToken,
      { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
      this.config.sendTimeoutMs,
    );
    const parsed = sendResponseSchema.safeParse(response);
    return { platformMessageId: parsed.success ? (parsed.data.message_id ?? null) : null };
  }
}
