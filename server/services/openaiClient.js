const OpenAI = require('openai');

function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY');
  return new OpenAI({ apiKey: key });
}

function getModel() {
  return process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
}

module.exports = { getOpenAIClient, getModel };

