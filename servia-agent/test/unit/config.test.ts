import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AI_PROVIDER: 'offline',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.ai.provider).toBe('offline');
    expect(c.whatsapp.enabled).toBe(false);
    expect(c.meta.graphVersion).toBe('v25.0');
    expect(c.admin.simulatorEnabled).toBe(false);
  });

  it('requires an API key and model for the openai provider', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY.*\n.*AI_MODEL|AI_MODEL/s);
  });

  it('accepts the openai provider when key and model are set, and never hardcodes the model', () => {
    const c = loadConfig({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', AI_MODEL: 'some-model' });
    expect(c.ai.model).toBe('some-model');
  });

  it('rejects the offline provider in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  it('requires channel secrets only for enabled channels', () => {
    expect(() => loadConfig({ ...base, WHATSAPP_ENABLED: 'true' })).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    const c = loadConfig({
      ...base,
      WHATSAPP_ENABLED: 'true',
      META_APP_SECRET: 'secret',
      WHATSAPP_VERIFY_TOKEN: 'verify',
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_PHONE_NUMBER_ID: '123',
    });
    expect(c.whatsapp.enabled).toBe(true);
  });

  it('lets Instagram fall back to the Meta app secret', () => {
    const c = loadConfig({
      ...base,
      INSTAGRAM_ENABLED: 'true',
      META_APP_SECRET: 'meta-secret',
      INSTAGRAM_VERIFY_TOKEN: 'v',
      INSTAGRAM_ACCESS_TOKEN: 't',
    });
    expect(c.instagram.appSecret).toBe('meta-secret');
  });

  it('rejects a short admin token', () => {
    expect(() => loadConfig({ ...base, ADMIN_API_TOKEN: 'short' })).toThrow(/ADMIN_API_TOKEN/);
  });

  it('rejects a malformed Graph API version', () => {
    expect(() => loadConfig({ ...base, META_GRAPH_API_VERSION: '25' })).toThrow(/META_GRAPH_API_VERSION/);
  });

  it('treats blank secrets as missing', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: '  ', AI_MODEL: 'm' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });
});
