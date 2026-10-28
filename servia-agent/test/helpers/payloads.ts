/** Webhook payload builders in the documented Meta shapes. */

export function waPayload(phoneNumberId: string, messages: unknown[], statuses: unknown[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Customer' }, wa_id: '2011' }],
              ...(messages.length ? { messages } : {}),
              ...(statuses.length ? { statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

export function messengerPayload(pageId: string, messaging: unknown[]) {
  return { object: 'page', entry: [{ id: pageId, time: Date.now(), messaging }] };
}

export function igPayload(igId: string, messaging: unknown[]) {
  return { object: 'instagram', entry: [{ id: igId, time: Date.now(), messaging }] };
}
