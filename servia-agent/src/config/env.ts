import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool(true),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(10, 1, 100),

  AI_PROVIDER: z.enum(['openai', 'offline']).default('openai'),
  AI_MODEL: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  AI_TIMEOUT_MS: int(20_000, 1_000, 120_000),
  AI_MAX_RETRIES: int(2, 0, 5),
  AI_MAX_OUTPUT_TOKENS: int(500, 50, 4_000),
  AI_HISTORY_MESSAGES: int(10, 0, 50),

  KNOWLEDGE_DIR: z.string().default('./knowledge'),
  RETRIEVAL_TOP_K: int(4, 1, 20),
  RETRIEVAL_MIN_RANK: z.coerce.number().min(0).default(0.01),

  MAX_INBOUND_CHARS: int(2_000, 100, 20_000),
  MAX_MESSAGES_PER_CONTACT_PER_HOUR: int(30, 1, 10_000),
  HUMAN_FOLLOWUP_TIMEFRAME: optionalSecret,
  RETENTION_DAYS: int(180, 1, 3_650),

  ADMIN_API_TOKEN: optionalSecret,
  SIMULATOR_ENABLED: bool(false),

  WORKER_ENABLED: bool(true),
  WORKER_POLL_INTERVAL_MS: int(1_000, 50, 60_000),
  JOB_MAX_ATTEMPTS: int(5, 1, 20),
  JOB_BACKOFF_BASE_MS: int(2_000, 10, 600_000),
  CONVERSATION_LOCK_RETRY_MS: int(3_000, 10, 60_000),

  REQUEST_BODY_LIMIT_BYTES: int(1_048_576, 1_024, 10_485_760),
  RATE_LIMIT_MAX: int(300, 1, 100_000),
  RATE_LIMIT_WINDOW_MS: int(60_000, 1_000, 3_600_000),

  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'expected a version like v25.0').default('v25.0'),
  META_GRAPH_BASE_URL: z.url().default('https://graph.facebook.com'),
  META_SEND_TIMEOUT_MS: int(10_000, 1_000, 60_000),
  META_APP_SECRET: optionalSecret,

  WHATSAPP_ENABLED: bool(false),
  WHATSAPP_VERIFY_TOKEN: optionalSecret,
  WHATSAPP_ACCESS_TOKEN: optionalSecret,
  WHATSAPP_PHONE_NUMBER_ID: optionalSecret,

  MESSENGER_ENABLED: bool(false),
  MESSENGER_VERIFY_TOKEN: optionalSecret,
  MESSENGER_PAGE_ACCESS_TOKEN: optionalSecret,

  INSTAGRAM_ENABLED: bool(false),
  INSTAGRAM_VERIFY_TOKEN: optionalSecret,
  INSTAGRAM_ACCESS_TOKEN: optionalSecret,
  INSTAGRAM_APP_SECRET: optionalSecret,
  INSTAGRAM_GRAPH_BASE_URL: z.url().default('https://graph.instagram.com'),
});

type Env = z.infer<typeof envSchema>;

export interface ChannelSecrets {
  enabled: boolean;
  verifyToken?: string;
  accessToken?: string;
  appSecret?: string;
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  trustProxy: boolean;
  database: { url: string; poolMax: number };
  ai: {
    provider: Env['AI_PROVIDER'];
    model?: string;
    apiKey?: string;
    timeoutMs: number;
    maxRetries: number;
    maxOutputTokens: number;
    historyMessages: number;
  };
  knowledge: { dir: string; topK: number; minRank: number };
  conversation: {
    maxInboundChars: number;
    maxMessagesPerContactPerHour: number;
    humanFollowupTimeframe?: string;
    retentionDays: number;
  };
  admin: { token?: string; simulatorEnabled: boolean };
  worker: {
    enabled: boolean;
    pollIntervalMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
    lockRetryMs: number;
  };
  http: { bodyLimit: number; rateLimitMax: number; rateLimitWindowMs: number };
  meta: { graphVersion: string; graphBaseUrl: string; sendTimeoutMs: number };
  whatsapp: ChannelSecrets & { phoneNumberId?: string };
  messenger: ChannelSecrets;
  instagram: ChannelSecrets & { graphBaseUrl: string };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Reads and validates configuration. The only place `process.env` is read. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];

  if (e.AI_PROVIDER === 'openai') {
    if (!e.OPENAI_API_KEY) issues.push('OPENAI_API_KEY is required when AI_PROVIDER=openai');
    if (!e.AI_MODEL) issues.push('AI_MODEL is required when AI_PROVIDER=openai');
  }
  if (e.NODE_ENV === 'production' && e.AI_PROVIDER === 'offline') {
    issues.push('AI_PROVIDER=offline is for local simulation only and is not allowed in production');
  }
  if (e.ADMIN_API_TOKEN && e.ADMIN_API_TOKEN.length < 32) {
    issues.push('ADMIN_API_TOKEN must be at least 32 characters');
  }
  if (e.SIMULATOR_ENABLED && e.NODE_ENV === 'production' && !e.ADMIN_API_TOKEN) {
    issues.push('SIMULATOR_ENABLED in production requires ADMIN_API_TOKEN');
  }
  const require = (enabled: boolean, name: string, vars: Record<string, string | undefined>) => {
    if (!enabled) return;
    for (const [key, value] of Object.entries(vars)) {
      if (!value) issues.push(`${key} is required when ${name}_ENABLED=true`);
    }
  };
  require(e.WHATSAPP_ENABLED, 'WHATSAPP', {
    META_APP_SECRET: e.META_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: e.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_ACCESS_TOKEN: e.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: e.WHATSAPP_PHONE_NUMBER_ID,
  });
  require(e.MESSENGER_ENABLED, 'MESSENGER', {
    META_APP_SECRET: e.META_APP_SECRET,
    MESSENGER_VERIFY_TOKEN: e.MESSENGER_VERIFY_TOKEN,
    MESSENGER_PAGE_ACCESS_TOKEN: e.MESSENGER_PAGE_ACCESS_TOKEN,
  });
  require(e.INSTAGRAM_ENABLED, 'INSTAGRAM', {
    'INSTAGRAM_APP_SECRET or META_APP_SECRET': e.INSTAGRAM_APP_SECRET ?? e.META_APP_SECRET,
    INSTAGRAM_VERIFY_TOKEN: e.INSTAGRAM_VERIFY_TOKEN,
    INSTAGRAM_ACCESS_TOKEN: e.INSTAGRAM_ACCESS_TOKEN,
  });
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    ai: {
      provider: e.AI_PROVIDER,
      model: e.AI_MODEL,
      apiKey: e.OPENAI_API_KEY,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxRetries: e.AI_MAX_RETRIES,
      maxOutputTokens: e.AI_MAX_OUTPUT_TOKENS,
      historyMessages: e.AI_HISTORY_MESSAGES,
    },
    knowledge: { dir: e.KNOWLEDGE_DIR, topK: e.RETRIEVAL_TOP_K, minRank: e.RETRIEVAL_MIN_RANK },
    conversation: {
      maxInboundChars: e.MAX_INBOUND_CHARS,
      maxMessagesPerContactPerHour: e.MAX_MESSAGES_PER_CONTACT_PER_HOUR,
      humanFollowupTimeframe: e.HUMAN_FOLLOWUP_TIMEFRAME,
      retentionDays: e.RETENTION_DAYS,
    },
    admin: { token: e.ADMIN_API_TOKEN, simulatorEnabled: e.SIMULATOR_ENABLED },
    worker: {
      enabled: e.WORKER_ENABLED,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      maxAttempts: e.JOB_MAX_ATTEMPTS,
      backoffBaseMs: e.JOB_BACKOFF_BASE_MS,
      lockRetryMs: e.CONVERSATION_LOCK_RETRY_MS,
    },
    http: {
      bodyLimit: e.REQUEST_BODY_LIMIT_BYTES,
      rateLimitMax: e.RATE_LIMIT_MAX,
      rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    },
    meta: {
      graphVersion: e.META_GRAPH_API_VERSION,
      graphBaseUrl: e.META_GRAPH_BASE_URL,
      sendTimeoutMs: e.META_SEND_TIMEOUT_MS,
    },
    whatsapp: {
      enabled: e.WHATSAPP_ENABLED,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      appSecret: e.META_APP_SECRET,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
    },
    messenger: {
      enabled: e.MESSENGER_ENABLED,
      verifyToken: e.MESSENGER_VERIFY_TOKEN,
      accessToken: e.MESSENGER_PAGE_ACCESS_TOKEN,
      appSecret: e.META_APP_SECRET,
    },
    instagram: {
      enabled: e.INSTAGRAM_ENABLED,
      verifyToken: e.INSTAGRAM_VERIFY_TOKEN,
      accessToken: e.INSTAGRAM_ACCESS_TOKEN,
      appSecret: e.INSTAGRAM_APP_SECRET ?? e.META_APP_SECRET,
      graphBaseUrl: e.INSTAGRAM_GRAPH_BASE_URL,
    },
  };
}
