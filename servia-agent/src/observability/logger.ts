import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Paths that must never reach log output. Message bodies are also kept out: log lengths, not text. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-hub-signature"]',
  '*.access_token',
  '*.accessToken',
  '*.apiKey',
  '*.api_key',
  '*.appSecret',
  '*.app_secret',
  '*.token',
  '*.password',
  '*.authorization',
];

const SECRET_PATTERNS: RegExp[] = [
  /(access_token=)[^&\s"']+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g,
  /\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g,
  /\b(EAA[A-Za-z0-9]{4})[A-Za-z0-9]+/g,
];

/** Removes tokens that may appear inside free text, such as error messages or URLs. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '$1[REDACTED]'), text);
}

export function createLogger(level: LoggerOptions['level'] = 'info'): Logger {
  return pino({
    level,
    base: { service: 'servia-agent' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** A short, safe description of an error for persistence: no stack, secrets scrubbed, bounded length. */
export function safeErrorDetail(error: unknown, max = 500): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSecrets(message).slice(0, max);
}
