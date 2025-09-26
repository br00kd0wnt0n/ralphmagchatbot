const OpenAI = require('openai');
const pLimit = require('p-limit');

const BATCH_SIZE = 64;
const CONCURRENCY = 2;

async function providerOpenAI(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large';
  const res = await client.embeddings.create({ model, input: texts });
  return res.data.map((d) => d.embedding);
}

async function providerVoyage(texts) {
  const key = process.env.VOYAGE_API_KEY;
  const model = process.env.VOYAGE_MODEL || 'voyage-3';
  if (!key) throw new Error('Missing VOYAGE_API_KEY');
  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ input: texts, model }),
  });
  if (!resp.ok) throw new Error(`Voyage embeddings error ${resp.status}`);
  const json = await resp.json();
  return json.data.map((d) => d.embedding);
}

async function withRetry(fn, { tries = 3, baseMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i === tries - 1) break;
      const delay = baseMs * Math.pow(2, i) + Math.random() * 200;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function getEmbeddings(texts) {
  const provider = (process.env.EMBEDDINGS_PROVIDER || 'OPENAI').toUpperCase();
  const runBatch = provider === 'OPENAI' ? providerOpenAI : provider === 'VOYAGE' ? providerVoyage : null;
  if (!runBatch) throw new Error(`Unsupported EMBEDDINGS_PROVIDER: ${provider}`);

  if (texts.length <= BATCH_SIZE) {
    return withRetry(() => runBatch(texts));
  }

  const limit = pLimit(CONCURRENCY);
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) batches.push(texts.slice(i, i + BATCH_SIZE));
  const results = await Promise.all(batches.map(batch => limit(() => withRetry(() => runBatch(batch)))));
  return results.flat();
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

module.exports = { getEmbeddings, cosineSim };
