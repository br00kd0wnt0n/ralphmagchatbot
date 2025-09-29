const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const pdfParse = require('pdf-parse');

function sanitizeTitle(title) {
  if (!title) return title;
  let t = String(title);
  t = t.replace(/\.[^.]+$/, '');
  t = t.replace(/\b(low\s*res|hi\s*res|lowres|hires|final|draft|copy|export|proof)\b/gi, '');
  t = t.replace(/\bv\d+\b/gi, '');
  t = t.replace(/[\-_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t;
}

function getOAuthClient(withRedirectUri) {
  const credsPath = process.env.GOOGLE_OAUTH_CREDENTIALS || './credentials/google-oauth.json';
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN || './credentials/google-token.json';

  // Support credentials from env var (for Railway)
  let creds;
  if (process.env.GOOGLE_OAUTH_JSON) {
    creds = JSON.parse(process.env.GOOGLE_OAUTH_JSON);
  } else if (fs.existsSync(credsPath)) {
    creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  } else {
    throw new Error(`Missing Google OAuth credentials. Set GOOGLE_OAUTH_JSON env var or provide file at ${credsPath}`);
  }
  const { client_secret, client_id, redirect_uris } = creds.installed || creds.web || {};
  // Use provided redirect URI (for web flow), otherwise default to first from credentials
  const chosenRedirect = withRedirectUri || (redirect_uris && redirect_uris[0]);
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, chosenRedirect);
  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    oAuth2Client.setCredentials(token);
  }
  return { oAuth2Client, tokenPath };
}

function getAuthUrl(redirectUri) {
  const { oAuth2Client } = getOAuthClient(redirectUri);
  const scopes = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly'
  ];
  const opts = { access_type: 'offline', scope: scopes, prompt: 'consent' };
  if (redirectUri) opts.redirect_uri = redirectUri;
  return oAuth2Client.generateAuthUrl(opts);
}

async function storeToken(code, redirectUri) {
  const { oAuth2Client, tokenPath } = getOAuthClient(redirectUri);
  const { tokens } = await oAuth2Client.getToken(code);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch {}
  return true;
}

async function listFilesRecursive(drive, folderId) {
  const results = [];
  async function walk(id) {
    let pageToken = undefined;
    do {
      const res = await drive.files.list({
        q: `'${id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, md5Checksum, size)',
        pageToken
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          await walk(f.id);
        } else {
          results.push(f);
        }
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }
  await walk(folderId);
  return results;
}

async function fetchFileText(auth, file) {
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });
  // Supported types: Google Doc, text/plain, text/markdown, PDF (TODO basic fallback)
  if (file.mimeType === 'application/vnd.google-apps.document') {
    // Export Google Doc to plain text via Docs API
    const doc = await docs.documents.get({ documentId: file.id });
    const content = (doc.data.body.content || [])
      .map(b => b.paragraph?.elements?.map(e => e.textRun?.content || '').join('') || '')
      .join('');
    const title = sanitizeTitle(doc.data.title || file.name);
    return { text: content, title };
  }
  if (file.mimeType === 'text/plain' || file.mimeType === 'text/markdown') {
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
    const text = await streamToString(res.data);
    return { text };
  }
  if (file.mimeType === 'application/pdf') {
    // Download PDF and extract text via pdf-parse (also collect per-page text)
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
    const buffer = await streamToBuffer(res.data);
    const pages = [];
    const parsed = await pdfParse(buffer, {
      pagerender: async (pageData) => {
        const content = await pageData.getTextContent();
        const strings = content.items.map(i => i.str);
        const pageText = strings.join(' ').replace(/\s{2,}/g, ' ').trim();
        pages.push(pageText);
        return pageText + '\n';
      }
    });
    return { text: parsed.text || pages.join('\n\n'), pages };
  }
  return { text: '' };
}

function parseMetaFromName(name) {
  // Heuristic: Issue_12_p34_Title by Author.ext
  const base = name.replace(/\.[^.]+$/, '');
  const meta = { issue: undefined, page: undefined, author: undefined, title: base };
  const mIssue = base.match(/issue[_\-\s]?(\d+)/i);
  if (mIssue) meta.issue = mIssue[1];
  const mPage = base.match(/p(age)?[_\-\s]?(\d+)/i);
  if (mPage) meta.page = mPage[2] || mPage[1];
  const byIdx = base.toLowerCase().indexOf(' by ');
  if (byIdx > -1) {
    meta.title = base.slice(0, byIdx).trim();
    meta.author = base.slice(byIdx + 4).trim();
  }
  meta.title = sanitizeTitle(meta.title);
  return meta;
}

function streamToString(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (d) => chunks.push(Buffer.from(d)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (d) => chunks.push(Buffer.from(d)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = { getOAuthClient, getAuthUrl, storeToken, listFilesRecursive, fetchFileText, parseMetaFromName };
