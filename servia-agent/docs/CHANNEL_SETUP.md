# Channel setup (WhatsApp, Instagram, Messenger)

> **Read this first.** These steps follow Meta's official documentation as it could be reached while building
> (search summaries only; developers.facebook.com could not be opened directly from the build environment).
> Meta renames menus and changes requirements often. Confirm each step against the current docs linked below
> before relying on it. **No channel has been tested end-to-end with real credentials yet.**

Each channel is independent. Enable only the ones you have set up (`*_ENABLED=true`). A disabled channel has no
webhook route.

## Prerequisites for all channels

1. The service is deployed with **HTTPS** on a public domain (Meta does not deliver webhooks to plain HTTP or localhost).
   See [DEPLOYMENT.md](DEPLOYMENT.md).
2. `GET https://<domain>/ready` returns `200`.
3. A **Meta Business portfolio** (business.facebook.com) and a **Meta developer app** (developers.facebook.com, app type *Business*).
4. Pick one random **verify token** per channel, for example `openssl rand -hex 16`. You enter it both in `.env` and in
   the Meta app's webhook settings.
5. Expect **business verification** and **App Review** before the app can message people who have no role
   on the app. Until then you can test only with users added as developers or testers of the app.

The webhook URLs are:

| Channel | Callback URL | Signing secret (`X-Hub-Signature-256`) |
|---|---|---|
| WhatsApp | `https://<domain>/webhooks/whatsapp` | Meta app secret (`META_APP_SECRET`) |
| Messenger | `https://<domain>/webhooks/messenger` | Meta app secret (`META_APP_SECRET`) |
| Instagram | `https://<domain>/webhooks/instagram` | Instagram app secret (`INSTAGRAM_APP_SECRET`) |

The service rejects any POST whose signature does not match, with `401`. It answers the GET handshake only when
`hub.verify_token` matches, and returns `403` otherwise.

---

## WhatsApp Business Platform (Cloud API)

Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

1. In the Meta app, add the **WhatsApp** product. This creates or links a **WhatsApp Business Account (WABA)**.
2. Add and verify the business **phone number**. Note its **Phone number ID** (not the phone number itself).
3. Create a **System User** in Business Settings. Give it the app and the WABA, and generate a **permanent
   access token** with `whatsapp_business_messaging` (and `whatsapp_business_management` for setup).
   Temporary tokens from the "API Setup" page expire within about a day; do not deploy with them.
4. Copy the **App secret** (App settings → Basic).
5. Set in `.env`:
   ```
   WHATSAPP_ENABLED=true
   META_APP_SECRET=...
   WHATSAPP_VERIFY_TOKEN=...
   WHATSAPP_ACCESS_TOKEN=...
   WHATSAPP_PHONE_NUMBER_ID=...
   ```
   Restart the service.
6. In the app's WhatsApp → Configuration, set the callback URL and verify token, click **Verify and save**,
   then **subscribe to the `messages` field**. Also make sure the app is subscribed to your WABA
   (Meta documents a `subscribed_apps` call for this).
7. Business requirements: business verification, display-name approval, and messaging limits that grow with
   quality. Check them in WhatsApp Manager.

Behaviour notes:
- Only events for `WHATSAPP_PHONE_NUMBER_ID` are processed; other numbers on the same app are ignored.
- Text, button replies and interactive list/button replies are read. Images, audio and stickers get a short
  "please type your question" reply. Reactions are ignored.
- Delivery receipts (`sent`, `delivered`, `read`, `failed`) update the stored reply's status.
- Free-form replies are allowed only within the **24-hour customer service window** after the customer's last
  message. The bot replies immediately, so this holds for automatic replies. A human answering a handed-off
  conversation after 24 hours needs an approved **message template**, which this MVP does not send.

## Facebook Messenger

Docs: https://developers.facebook.com/docs/messenger-platform

1. You need a **Facebook Page** for SERVIA, managed in your Business portfolio.
2. In the Meta app, add the **Messenger** product, connect the Page, and generate a **Page access token**.
   The send API needs `pages_messaging`. Webhook subscription typically also needs `pages_manage_metadata`.
3. Set in `.env`:
   ```
   MESSENGER_ENABLED=true
   META_APP_SECRET=...
   MESSENGER_VERIFY_TOKEN=...
   MESSENGER_PAGE_ACCESS_TOKEN=...
   ```
   Restart.
4. In Messenger settings → Webhooks, set the callback URL and verify token, subscribe to **`messages`**
   (optionally `message_deliveries`), and **subscribe the Page** to the app.
5. Submit `pages_messaging` for **App Review** to message the public. Before approval, only people with a role
   on the app can test.

Behaviour notes:
- Replies use `messaging_type: RESPONSE`, which is valid inside the 24-hour standard messaging window.
- Echoes of the Page's own messages are ignored. Attachments get the "please type" reply. Postbacks
  (button payloads) are ignored in this MVP.
- Text replies are capped at Messenger's 2000-character limit.

## Instagram (Instagram API with Instagram Login)

Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api

1. The SERVIA Instagram account must be a **professional account** (Business or Creator).
2. In the Meta app, add the **Instagram** product with **API setup with Instagram login**, and connect the account.
   Generate an **Instagram user access token** with `instagram_business_basic` and `instagram_business_manage_messages`.
3. Copy the **Instagram app secret** from the Instagram product's settings. It is different from the Meta app secret.
4. Set in `.env`:
   ```
   INSTAGRAM_ENABLED=true
   INSTAGRAM_APP_SECRET=...
   INSTAGRAM_VERIFY_TOKEN=...
   INSTAGRAM_ACCESS_TOKEN=...
   ```
   Restart.
5. Configure the webhook (callback URL and verify token) in the Instagram product and subscribe to **`messages`**.
6. On the Instagram account, allow access to messages for connected tools (Settings → Messages and story replies →
   Message controls / Connected tools; the wording varies).
7. App Review is needed for **Advanced Access** to `instagram_business_manage_messages` before messaging the public.

Behaviour notes:
- Sends go to `graph.instagram.com/<version>/me/messages` with the Instagram token.
- Text must be at most **1000 bytes** (about 500 Arabic characters). Longer replies are shortened.
- **Instagram user tokens expire.** Long-lived tokens last about 60 days and must be refreshed. Put a reminder in
  place, or add automatic refresh before production. When the token expires, sends fail with an OAuth error
  (see TROUBLESHOOTING.md).
- If you connect Instagram through a Facebook Page instead (Instagram via Facebook Login), the host and token
  differ. That variant is not implemented.

---

## Verifying a channel end to end

Do this for each channel before calling it live:

1. `GET /ready` → `200`, and the channel is listed in `channels`.
2. Webhook **Verify and save** succeeds in the Meta dashboard. The server log shows no `webhook verification rejected`.
3. From a test account, send `What does SERVIA do?`. Within seconds you get an answer. The server log shows
   `webhook processed`, then `reply generated` and `job finished` with `status: replied`.
4. `GET /admin/conversations/<id>/messages` shows the inbound message, then the outbound reply with
   `deliveryStatus` of `sent`, later `delivered` or `read` where the platform reports it, plus its `knowledgeSourceIds`.
5. Ask for a person (`I want to talk to someone`). The conversation appears in `GET /admin/conversations?status=handoff`
   and the bot stops replying there.
6. Resend the same message ID? You can't do this from the app, but Meta's own retries are absorbed: you never get
   two replies to one message.
7. Record the date, channel and result in `PROJECT_STATUS.md`. Only then mark the channel as verified.

The Graph API version is set by `META_GRAPH_API_VERSION` (default `v25.0`). Check Meta's changelog for the
current version when you set up, and update the variable rather than the code.
