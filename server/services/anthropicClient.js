const Anthropic = require('@anthropic-ai/sdk');

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
  return new Anthropic({ apiKey: key });
}

function getModel() {
  return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620';
}

module.exports = { getAnthropicClient, getModel };

