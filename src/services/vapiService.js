const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.vapi.apiBase,
  headers: {
    Authorization: `Bearer ${config.vapi.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

async function createOutboundCall({ phoneNumber, contactId, name, firstName, metadata = {} }) {
  if (!config.vapi.assistantId) throw new Error('VAPI assistantId not configured');
  if (!config.vapi.phoneNumberId) throw new Error('VAPI phoneNumberId not configured');

  const payload = {
    assistantId: config.vapi.assistantId,
    phoneNumberId: config.vapi.phoneNumberId,
    customer: {
      number: phoneNumber,
      name: name || undefined,
    },
    assistantOverrides: {
      variableValues: {
        first_name: name || 'there',
      },
    },
    metadata: {
      ghlContactId: contactId,
      ...metadata,
    },
  };

  const { data } = await client.post('/call', payload);
  return data;
}

async function getCall(callId) {
  const { data } = await client.get(`/call/${callId}`);
  return data;
}

module.exports = { createOutboundCall, getCall };
