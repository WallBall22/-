INSERT INTO "channels" ("id", "display_name") VALUES
  ('whatsapp', 'WhatsApp Business'),
  ('instagram', 'Instagram'),
  ('messenger', 'Facebook Messenger')
ON CONFLICT ("id") DO NOTHING;
