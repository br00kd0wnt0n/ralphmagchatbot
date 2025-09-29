const express = require('express');
const { getAllChunks } = require('../services/store');
const { getEmbeddings, cosineSim } = require('../services/embeddings');
const { getOpenAIClient, getModel } = require('../services/openaiClient');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Missing message' });
    if (message.length > 2000) return res.status(413).json({ error: 'Message too long' });

    // Retrieve
    const all = getAllChunks();
    if (!all.length) return res.status(400).json({ error: 'Index is empty. No content has been indexed yet.' });
    const [qEmb] = await getEmbeddings([message]);

    // Keyword gating for very short queries to boost precision
    const tokens = (message.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1);
    const isVeryShort = tokens.length <= 2;
    let pool = all;
    if (isVeryShort && tokens.length) {
      const termSet = new Set(tokens);
      pool = all.filter(c => {
        const t = c.text.toLowerCase();
        for (const term of termSet) { if (t.includes(term)) return true; }
        return false;
      });
      if (!pool.length) pool = all; // fallback if no hits
    }

    const scored = pool.map((c) => ({ c, score: cosineSim(qEmb, c.embedding) }))
                       .sort((a, b) => b.score - a.score);
    const baseTopK = Number(process.env.RETRIEVAL_TOP_K || 8);
    const topK = isVeryShort ? Math.max(baseTopK, 12) : baseTopK;
    // Deduplicate by document for variety
    const seenDocs = new Set();
    const selected = [];
    for (const s of scored) {
      if (seenDocs.has(s.c.doc_id)) continue;
      selected.push(s.c);
      seenDocs.add(s.c.doc_id);
      if (selected.length >= topK) break;
    }

    // Build prompt with citations
    const contextBlocks = selected.map((s, idx) => {
      const meta = s.meta || {};
      const label = `#${idx + 1}`;
      const cite = [
        meta.title ? `“${meta.title}”` : undefined,
        meta.author ? `by ${meta.author}` : undefined,
        meta.issue ? `Issue ${meta.issue}` : undefined,
        (s.page || meta.page) ? `p.${s.page || meta.page}` : undefined
      ].filter(Boolean).join(' · ');
      return `[[${label} | ${cite}]]\n${s.text}`;
    }).join('\n\n---\n\n');

    const systemMessage = `You're Ralph Magazine's AI assistant! You help readers dig into our archive.

Write in a conversational, magazine-style voice. Use only the provided context excerpts.

IMPORTANT - Format responses like this:
1. Start with an engaging opener like "Found something!" or "Ralph's covered this!"
2. Add bullet points with "- " format
3. Quote or paraphrase key insights from the context
4. End each bullet with citation [#3]

Example format:
Found something! Ralph's explored sustainable fashion from multiple angles.
- Designers are increasingly drawn to recycled fabrics as consumers demand eco-friendly options [#1]
- The fast fashion industry generates a staggering 92 million tons of waste every year [#2]
- Vintage clothing sales jumped 30% last year as style-conscious shoppers embrace secondhand [#3]

Keep it engaging and informative. If there's not enough info, suggest what else they might search for.

For follow-up suggestions, add a line like: "For more specifics, try searching: artist interviews, cultural impact discussions, or fashion trends" - these will become clickable search suggestions.`;

    const userMessage = `User question: ${message}\n\nContext:\n\n${contextBlocks}`;

    const openai = getOpenAIClient();
    const model = getModel();

    // Stream via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model,
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      stream: true,
    });

    // Keepalive ping
    const keepalive = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch {}
    }, 15000);
    req.on('close', () => {
      try { stream.controller.abort(); } catch {}
      clearInterval(keepalive);
    });

    let assistantText = '';
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          assistantText += delta;
          res.write(`data: ${JSON.stringify({ type: 'text', delta })}\n\n`);
        }
      }

      // Send sources at end
      const citedIdx = new Set();
      try {
        const re = /\[#(\d+)\]/g;
        let m;
        while ((m = re.exec(assistantText)) !== null) {
          const n = parseInt(m[1], 10);
          if (!isNaN(n) && n >= 1 && n <= selected.length) citedIdx.add(n - 1);
        }
      } catch {}
      const cited = [];
      const also = [];
      selected.forEach((s, i) => {
        const buildUrl = () => {
          const base = s.meta?.url || undefined;
          if (!base) return undefined;
          const page = s.page || s.meta?.page;
          if (!page) return base;
          // Use #page for direct PDF links; use ?page for Drive web links
          const isPdf = /\.pdf(\?|#|$)/i.test(base) || base.startsWith('/pdfs/');
          if (isPdf) return `${base}#page=${page}`;
          const sep = base.includes('?') ? '&' : '?';
          return `${base}${sep}page=${page}`;
        };
        const obj = {
          ref: `#${i + 1}`,
          title: s.meta?.title || 'Untitled',
          author: s.meta?.author || undefined,
          issue: s.meta?.issue || undefined,
          page: s.page || s.meta?.page || undefined,
          url: buildUrl(),
          source: s.meta?.source || undefined,
        };
        if (citedIdx.has(i)) cited.push(obj); else also.push(obj);
      });
      res.write(`data: ${JSON.stringify({ type: 'sources', cited, also })}\n\n`);
      clearInterval(keepalive);
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      clearInterval(keepalive);
      res.end();
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
