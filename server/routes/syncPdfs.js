const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const { upsertDocument, replaceChunks, getDocument } = require('../services/store');
const { getEmbeddings } = require('../services/embeddings');
const { parseMetaFromName } = require('../services/googleDrive');

const router = express.Router();

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
      yield full;
    }
  }
}

function hashString(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

router.get('/status', async (req, res) => {
  const PDFS_DIR = process.env.PDFS_DIR || path.join(__dirname, '..', '..', 'data', 'pdfs');
  let count = 0;
  try {
    for (const _ of walk(PDFS_DIR)) count++;
  } catch (e) {
    // ignore
  }
  res.json({ dir: PDFS_DIR, files_detected: count });
});

router.post('/run', async (req, res) => {
  const PDFS_DIR = process.env.PDFS_DIR || path.join(__dirname, '..', '..', 'data', 'pdfs');
  const baseUrl = process.env.PDF_BASE_URL || null;
  try {
    const processed = [];
    let skipped = 0;
    for (const filePath of walk(PDFS_DIR)) {
      const rel = path.relative(PDFS_DIR, filePath).split(path.sep).join('/');
      const data = await fsp.readFile(filePath);
      const checksum = crypto.createHash('md5').update(data).digest('hex');
      const stat = await fsp.stat(filePath);
      const mtime = stat.mtime.toISOString();
      const id = hashString(rel);

      const existing = getDocument(id);
      if (existing && existing.checksum === checksum) { skipped++; continue; }

      // Parse per-page text
      const pages = [];
      const parsed = await pdfParse(data, {
        pagerender: async (pageData) => {
          const content = await pageData.getTextContent();
          const strings = content.items.map(i => i.str);
          const pageText = strings.join(' ').replace(/\s{2,}/g, ' ').trim();
          pages.push(pageText);
          return pageText + '\n';
        }
      });
      const text = parsed.text || pages.join('\n\n');
      if (!text || !text.trim()) continue;

      const meta = parseMetaFromName(path.basename(rel));
      // Build URL: CDN or static route
      const encPath = rel.split('/').map(encodeURIComponent).join('/');
      const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/${encPath}` : `/pdfs/${encPath}`;

      upsertDocument({
        id,
        source: 'pdfs-local',
        title: meta.title,
        issue: meta.issue,
        page: meta.page,
        author: meta.author,
        url,
        mime_type: 'application/pdf',
        modified_time: mtime,
        checksum,
      });

      const chunkTexts = pages.length ? pages : text.split(/\n\n+/);
      const pageNums = pages.length ? pages.map((_, i) => i + 1) : chunkTexts.map(() => null);
      const embeddings = await getEmbeddings(chunkTexts);
      const rows = chunkTexts.map((c, i) => ({
        id: hashString(id + ':' + i),
        doc_id: id,
        chunk_index: i,
        text: c,
        embedding: embeddings[i],
        page: pageNums[i]
      }));
      replaceChunks(id, rows);
      processed.push({ id, rel, pages: rows.length });
    }
    res.json({ ok: true, files_processed: processed.length, files_skipped: skipped, details: processed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

