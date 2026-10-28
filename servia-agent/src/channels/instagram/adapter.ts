import { z } from 'zod';
import { parseMessagingEntries } from '../messaging-events.js';
import { graphPost, graphUrl, verifyHubChallenge, verifyHubSignature, type FetchLike } from '../meta.js';
import type { ChannelAdapter, ParsedWebhook, SendContext, SendResult } from '../types.js';

export interface InstagramConfig {
  appSecret: string;
  verifyToken: string;
  accessToken: string;
  /** Instagram API with Instagram Login uses graph.instagram.com. */
  graphBaseUrl: string;
  graphVersion: string;
  sendTimeoutMs: number;
}

const sendResponseSchema = z.looseObject({ message_id: z.string().optional() });

/** Instagram professional account messaging (Instagram API with Instagram Login) adapter. */
export class InstagramAdapter implements ChannelAdapter {
  readonly channel = 'instagram' as const;
  // Instagram text messages must be UTF-8 and at most 1000 bytes.
  readonly maxMessageBytes = 1_000;

  constructor(
    private readonly config: InstagramConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  verifySubscription(query: Record<string, unknown>): string | null {
    return verifyHubChallenge(query, this.config.verifyToken);
  }

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    return verifyHubSignature(rawBody, header, this.config.appSecret);
  }

  parse(payload: unknown): ParsedWebhook {
    return parseMessagingEntries('instagram', 'instagram', payload);
  }

  async send(recipientId: string, text: string, _context: SendContext): Promise<SendResult> {
    const url = graphUrl(this.config.graphBaseUrl, this.config.graphVersion, 'me/messages');
    const response = await graphPost<unknown>(
      this.fetchImpl,
      url,
      this.config.accessToken,
      { recipient: { id: recipientId }, message: { text } },
      this.config.sendTimeoutMs,
    );
    const parsed = sendResponseSchema.safeParse(response);
    return { platformMessageId: parsed.success ? (parsed.data.message_id ?? null) : null };
  }
}
