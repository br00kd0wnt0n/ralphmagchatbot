const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getOAuthClient, getAuthUrl, storeToken, listFilesRecursive, fetchFileText, parseMetaFromName } = require('../services/googleDrive');
const { upsertDocument, replaceChunks, getDocument } = require('../services/store');
const { chunkText } = require('../services/chunk');
const { getEmbeddings } = require('../services/embeddings');
const { randomUUID } = require('crypto');

const router = express.Router();

// Basic Auth middleware for admin-only endpoints
router.use((req, res, next) => {
  const user = process.env.ADMIN_USER || '';
  const pass = process.env.ADMIN_PASS || '';
  const header = req.headers['authorization'] || '';
  if (!user || !pass) {
    return res.status(503).json({ error: 'Sync disabled: set ADMIN_USER and ADMIN_PASS' });
  }
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  if (header === expected) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).json({ error: 'Unauthorized' });
});

router.get('/auth-url', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', (req, res) => {
  try {
    const credsPath = process.env.GOOGLE_OAUTH_CREDENTIALS || './credentials/google-oauth.json';
    const tokenPath = process.env.GOOGLE_OAUTH_TOKEN || './credentials/google-token.json';
    const hasCreds = !!process.env.GOOGLE_OAUTH_JSON || fs.existsSync(credsPath);
    const hasToken = fs.existsSync(tokenPath);
    const folderIds = (process.env.GOOGLE_DRIVE_FOLDER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const canSync = hasToken && folderIds.length > 0;
    res.json({ admin: true, hasCreds, hasToken, folderIds, canSync });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/oauth2/callback', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string' || code.length > 2048) {
      return res.status(400).json({ error: 'Invalid code' });
    }
    await storeToken(code);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/google-drive', async (req, res) => {
  const folderIdsStr = process.env.GOOGLE_DRIVE_FOLDER_IDS || '';
  const folderIds = folderIdsStr.split(',').map(s => s.trim()).filter(Boolean);
  if (!folderIds.length) return res.status(400).json({ error: 'Set GOOGLE_DRIVE_FOLDER_IDS' });
  const mimeWhitelist = (process.env.INGEST_MIME_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const { oAuth2Client } = getOAuthClient();
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    const all = [];
    for (const fid of folderIds) {
      const files = await listFilesRecursive(drive, fid);
      all.push(...files);
    }
    const targets = mimeWhitelist.length ? all.filter(f => mimeWhitelist.includes(f.mimeType)) : all;
    const results = [];
    let skipped = 0;
    for (const file of targets) {
      // Incremental: skip unchanged by modifiedTime
      const existing = getDocument(file.id);
      const sameTime = existing && existing.modified_time && existing.modified_time === file.modifiedTime;
      const sameChecksum = existing && existing.checksum && file.md5Checksum && existing.checksum === file.md5Checksum;
      if (sameTime || sameChecksum) {
        skipped++;
        continue;
      }
      const text = await fetchFileText(oAuth2Client, file);
      if (!text || !text.trim()) continue;
      const meta = parseMetaFromName(file.name);
      const docId = file.id;
      upsertDocument({
        id: docId,
        source: 'google-drive',
        title: meta.title,
        issue: meta.issue,
        page: meta.page,
        author: meta.author,
        url: file.webViewLink,
        mime_type: file.mimeType,
        modified_time: file.modifiedTime,
        checksum: file.md5Checksum || null,
      });
      const chunks = chunkText(text);
      const embeddings = await getEmbeddings(chunks);
      const rows = chunks.map((c, i) => ({
        id: randomUUID(),
        doc_id: docId,
        chunk_index: i,
        text: c,
        embedding: embeddings[i]
      }));
      replaceChunks(docId, rows);
      results.push({ id: docId, name: file.name, chunks: rows.length });
    }
    res.json({ ok: true, files_processed: results.length, files_skipped: skipped, details: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
