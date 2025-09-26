const express = require('express');
const { getAllChunks } = require('../services/store');
const { getEmbeddings, cosineSim } = require('../services/embeddings');
const { getAnthropicClient, getModel } = require('../services/anthropicClient');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Missing message' });
    if (message.length > 2000) return res.status(413).json({ error: 'Message too long' });

    // Retrieve
    const all = getAllChunks();
    if (!all.length) return res.status(400).json({ error: 'Index is empty. Run /api/sync/google-drive first.' });
    const [qEmb] = await getEmbeddings([message]);
    const scored = all.map((c) => ({ c, score: cosineSim(qEmb, c.embedding) }))
                     .sort((a, b) => b.score - a.score);
    const topK = Number(process.env.RETRIEVAL_TOP_K || 8);
    const selected = scored.slice(0, topK).map(s => s.c);

    // Build prompt with citations
    const contextBlocks = selected.map((s, idx) => {
      const meta = s.meta || {};
      const label = `#${idx + 1}`;
      const cite = [
        meta.title ? `“${meta.title}”` : undefined,
        meta.author ? `by ${meta.author}` : undefined,
        meta.issue ? `Issue ${meta.issue}` : undefined,
        meta.page ? `p.${meta.page}` : undefined
      ].filter(Boolean).join(' · ');
      return `[[${label} | ${cite}]]\n${s.text}`;
    }).join('\n\n---\n\n');

    const system = `You are a helpful research assistant for Ralph Magazine. Answer using only the provided context excerpts. Quote exact sentences and include bracketed citations like [#3] that refer to the numbered context blocks. If you don't find the answer, say you don't have it.`;

    const user = [
      { type: 'text', text: `User question: ${message}` },
      { type: 'text', text: `Context:\n\n${contextBlocks}` }
    ];

    const anthropic = getAnthropicClient();
    const model = getModel();

    // Stream via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await anthropic.messages.stream({
      model,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });

    // Keepalive ping
    const keepalive = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch {}
    }, 15000);
    req.on('close', () => {
      try { stream.abort(); } catch {}
      clearInterval(keepalive);
    });

    stream.on('text', (delta) => {
      res.write(`data: ${JSON.stringify({ type: 'text', delta })}\n\n`);
    });
    stream.on('message_stop', () => {
      // Send sources at end
      res.write(`data: ${JSON.stringify({ type: 'sources', sources: selected.map((s, i) => ({
        ref: `#${i + 1}`,
        title: s.meta?.title || 'Untitled',
        author: s.meta?.author || undefined,
        issue: s.meta?.issue || undefined,
        page: s.meta?.page || undefined,
        url: s.meta?.url || undefined,
        source: s.meta?.source || undefined,
      })) })}\n\n`);
      clearInterval(keepalive);
      res.end();
    });
    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      clearInterval(keepalive);
      res.end();
    });
    stream.on('abort', () => res.end());
    await stream.start();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
