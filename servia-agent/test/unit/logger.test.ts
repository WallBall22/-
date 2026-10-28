import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, redactSecrets, safeErrorDetail } from '../../src/observability/logger.js';

describe('redactSecrets', () => {
  it('removes tokens from URLs, bearer headers and API keys', () => {
    const out = redactSecrets(
      'GET https://graph.facebook.com/v25.0/me/messages?access_token=EAAB123secret Bearer abc.def sk-proj-ABCDEFGH12345678',
    );
    expect(out).not.toContain('EAAB123secret');
    expect(out).not.toContain('abc.def');
    expect(out).not.toContain('12345678');
    expect(out).toContain('access_token=[REDACTED]');
  });
});

describe('safeErrorDetail', () => {
  it('is bounded and scrubbed', () => {
    const detail = safeErrorDetail(new Error(`failed access_token=secret ${'x'.repeat(1000)}`), 100);
    expect(detail.length).toBeLessThanOrEqual(100);
    expect(detail).not.toContain('secret');
  });
});

describe('logger redaction paths', () => {
  it('censors configured secret fields', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);
    log.info({ req: { headers: { authorization: 'Bearer x', 'x-hub-signature-256': 'sha256=abc' } }, ctx: { accessToken: 't' } });
    const out = lines.join('');
    expect(out).not.toContain('Bearer x');
    expect(out).not.toContain('sha256=abc');
    expect(out).not.toContain('"t"');
  });
});
