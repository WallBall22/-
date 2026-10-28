import type { AppConfig } from '../config/env.js';
import type { Channel } from '../database/schema.js';
import { InstagramAdapter } from './instagram/adapter.js';
import type { FetchLike } from './meta.js';
import { MessengerAdapter } from './messenger/adapter.js';
import type { ChannelAdapter } from './types.js';
import { WhatsAppAdapter } from './whatsapp/adapter.js';

/** Builds adapters for the channels enabled in configuration. Configuration validation guarantees the secrets exist. */
export function createChannelAdapters(config: AppConfig, fetchImpl: FetchLike = fetch): Map<Channel, ChannelAdapter> {
  const adapters = new Map<Channel, ChannelAdapter>();
  const { meta } = config;
  if (config.whatsapp.enabled) {
    adapters.set(
      'whatsapp',
      new WhatsAppAdapter(
        {
          appSecret: config.whatsapp.appSecret!,
          verifyToken: config.whatsapp.verifyToken!,
          accessToken: config.whatsapp.accessToken!,
          phoneNumberId: config.whatsapp.phoneNumberId!,
          graphBaseUrl: meta.graphBaseUrl,
          graphVersion: meta.graphVersion,
          sendTimeoutMs: meta.sendTimeoutMs,
        },
        fetchImpl,
      ),
    );
  }
  if (config.messenger.enabled) {
    adapters.set(
      'messenger',
      new MessengerAdapter(
        {
          appSecret: config.messenger.appSecret!,
          verifyToken: config.messenger.verifyToken!,
          pageAccessToken: config.messenger.accessToken!,
          graphBaseUrl: meta.graphBaseUrl,
          graphVersion: meta.graphVersion,
          sendTimeoutMs: meta.sendTimeoutMs,
        },
        fetchImpl,
      ),
    );
  }
  if (config.instagram.enabled) {
    adapters.set(
      'instagram',
      new InstagramAdapter(
        {
          appSecret: config.instagram.appSecret!,
          verifyToken: config.instagram.verifyToken!,
          accessToken: config.instagram.accessToken!,
          graphBaseUrl: config.instagram.graphBaseUrl,
          graphVersion: meta.graphVersion,
          sendTimeoutMs: meta.sendTimeoutMs,
        },
        fetchImpl,
      ),
    );
  }
  return adapters;
}
