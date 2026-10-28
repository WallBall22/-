import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai';
import { REPLY_JSON_SCHEMA } from './prompt.js';
import { AiError, type AiProvider, type AiRequest, type AiResult } from './provider.js';

/** The slice of the OpenAI client this provider uses, so tests can inject a fake. */
export interface ResponsesClient {
  responses: {
    create(
      body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
      options?: { timeout?: number; maxRetries?: number },
    ): Promise<OpenAI.Responses.Response>;
  };
}

export interface OpenAiProviderOptions {
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function createOpenAiClient(apiKey: string, options: OpenAiProviderOptions): OpenAI {
  // The SDK retries connection errors, 408/409/429 and 5xx with exponential backoff, bounded by maxRetries.
  return new OpenAI({ apiKey, timeout: options.timeoutMs, maxRetries: options.maxRetries });
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  constructor(
    private readonly client: ResponsesClient,
    private readonly options: OpenAiProviderOptions,
  ) {}

  async generate(request: AiRequest): Promise<AiResult> {
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create(
        {
          model: this.options.model,
          instructions: request.instructions,
          input: [
            ...request.history.map((t) => ({ role: t.role, content: t.content })),
            { role: 'developer' as const, content: request.knowledgeBlock },
            { role: 'user' as const, content: request.customerMessage },
          ],
          max_output_tokens: request.maxOutputTokens,
          // Do not keep customer conversations on the provider side.
          store: false,
          text: {
            format: { type: 'json_schema', name: 'servia_reply', strict: true, schema: { ...REPLY_JSON_SCHEMA } },
          },
        },
        { timeout: this.options.timeoutMs, maxRetries: this.options.maxRetries },
      );
    } catch (error) {
      throw classifyOpenAiError(error);
    }

    if (response.status === 'incomplete') {
      throw new AiError('incomplete', `response incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`);
    }
    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((c) => c.type === 'refusal');
    if (refusal) throw new AiError('refused', 'model refused to answer');
    if (!response.output_text) throw new AiError('incomplete', 'empty model output');

    return {
      rawOutput: response.output_text,
      model: response.model,
      usage: {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
    };
  }
}

export function classifyOpenAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  const opts = { cause: error };
  if (error instanceof APIConnectionTimeoutError) return new AiError('timeout', 'model request timed out', opts);
  if (error instanceof APIConnectionError) return new AiError('unavailable', 'could not reach the model API', opts);
  if (error instanceof RateLimitError) return new AiError('rate_limited', 'model API rate limit or quota exceeded', opts);
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new AiError('auth', 'model API rejected the credentials', opts);
  }
  if (error instanceof BadRequestError) return new AiError('invalid_request', 'model API rejected the request', opts);
  if (error instanceof APIError) return new AiError('unavailable', `model API error (status ${error.status ?? 'n/a'})`, opts);
  return new AiError('unavailable', 'unexpected model error', opts);
}
