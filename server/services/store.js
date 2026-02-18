const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.resolve(process.env.DB_DIR || path.join(__dirname, '..', '..', 'data'));
const DB_PATH = path.join(DB_DIR, 'index.sqlite');

let db;

function ensureDb() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  } catch (e) {
    throw new Error(`Failed to create DB_DIR at ${DB_DIR}: ${e.message}`);
  }
  try {
    fs.accessSync(DB_DIR, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`DB_DIR not writable: ${DB_DIR}. Set DB_DIR to a writable mounted path (e.g., /app/data). Details: ${e.message}`);
  }
  db = new Database(DB_PATH);
  // Tune pragmas with safe fallbacks
  try { db.pragma(`synchronous = NORMAL`); } catch {}
  const journal = (process.env.DB_JOURNAL || 'WAL').toUpperCase();
  try { db.pragma(`journal_mode = ${journal}`); } catch {}
  // Fallback if WAL not supported on mounted FS
  try {
    const mode = db.pragma('journal_mode', { simple: true });
    if (mode && mode.toString().toUpperCase() !== journal) {
      db.pragma('journal_mode = DELETE');
    }
  } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      issue TEXT,
      page TEXT,
      author TEXT,
      url TEXT,
      mime_type TEXT,
      modified_time TEXT,
      checksum TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  // Backfill migrations: ensure modified_time column exists
  const cols = db.prepare("PRAGMA table_info(documents)").all();
  const hasModified = cols.some(c => c.name === 'modified_time');
  if (!hasModified) {
    db.exec("ALTER TABLE documents ADD COLUMN modified_time TEXT");
  }
  const hasChecksum = cols.some(c => c.name === 'checksum');
  if (!hasChecksum) {
    db.exec("ALTER TABLE documents ADD COLUMN checksum TEXT");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified_time)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      page INTEGER,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);');
  // Migration: add page column if missing
  const colsC = db.prepare("PRAGMA table_info(chunks)").all();
  const hasPage = colsC.some(c => c.name === 'page');
  if (!hasPage) {
    db.exec('ALTER TABLE chunks ADD COLUMN page INTEGER');
  }

  // Articles table - detected articles within each issue
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      title TEXT,
      author TEXT,
      start_page INTEGER,
      end_page INTEGER,
      category TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_doc ON articles(doc_id)');

  // Insights table - key takeaways per article
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      insight_text TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      model_used TEXT,
      extracted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_insights_article ON insights(article_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_insights_doc ON insights(doc_id)');

  // Formatted articles cache - stores GPT-4o reformatted daily articles
  db.exec(`
    CREATE TABLE IF NOT EXISTS formatted_articles (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      date TEXT NOT NULL,
      headline TEXT,
      subtitle TEXT,
      author TEXT,
      category TEXT,
      issue TEXT,
      body_html TEXT,
      pull_quote TEXT,
      cover_image TEXT,
      pdf_url TEXT,
      start_page INTEGER,
      end_page INTEGER,
      formatted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (article_id) REFERENCES articles(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_formatted_articles_date ON formatted_articles(date)');
}

function upsertDocument(doc) {
  const stmt = db.prepare(`
    INSERT INTO documents (id, source, title, issue, page, author, url, mime_type, modified_time, checksum)
    VALUES (@id, @source, @title, @issue, @page, @author, @url, @mime_type, @modified_time, @checksum)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source,
      title=excluded.title,
      issue=excluded.issue,
      page=excluded.page,
      author=excluded.author,
      url=excluded.url,
      mime_type=excluded.mime_type,
      modified_time=excluded.modified_time,
      checksum=excluded.checksum
  `);
  stmt.run(doc);
}

function replaceChunks(docId, chunks) {
  const del = db.prepare('DELETE FROM chunks WHERE doc_id = ?');
  del.run(docId);
  const insert = db.prepare('INSERT INTO chunks (id, doc_id, chunk_index, text, embedding, page) VALUES (?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(r.id, r.doc_id, r.chunk_index, r.text, JSON.stringify(r.embedding), r.page ?? null);
  });
  tx(chunks);
}

function getAllChunks() {
  const rows = db.prepare('SELECT c.*, d.title, d.issue, d.page as doc_page, d.author, d.url, d.source, d.mime_type FROM chunks c JOIN documents d ON d.id = c.doc_id').all();
  return rows.map((r) => ({
    id: r.id,
    doc_id: r.doc_id,
    chunk_index: r.chunk_index,
    text: r.text,
    embedding: JSON.parse(r.embedding),
    page: r.page,
    meta: {
      title: r.title,
      issue: r.issue,
      page: r.doc_page,
      author: r.author,
      url: r.url,
      source: r.source,
      mime_type: r.mime_type,
    }
  }));
}

function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function getAllDocuments() {
  return db.prepare('SELECT * FROM documents ORDER BY issue, title').all();
}

// Articles CRUD
function upsertArticle(article) {
  const stmt = db.prepare(`
    INSERT INTO articles (id, doc_id, title, author, start_page, end_page, category)
    VALUES (@id, @doc_id, @title, @author, @start_page, @end_page, @category)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      author=excluded.author,
      start_page=excluded.start_page,
      end_page=excluded.end_page,
      category=excluded.category
  `);
  stmt.run(article);
}

function deleteArticlesByDocument(docId) {
  db.prepare('DELETE FROM articles WHERE doc_id = ?').run(docId);
}

function getArticlesByDocument(docId) {
  return db.prepare('SELECT * FROM articles WHERE doc_id = ? ORDER BY start_page').all(docId);
}

function getAllArticles() {
  return db.prepare(`
    SELECT a.*, d.title as doc_title, d.issue
    FROM articles a
    JOIN documents d ON d.id = a.doc_id
    ORDER BY d.issue, a.start_page
  `).all();
}

// Insights CRUD
function upsertInsight(insight) {
  const stmt = db.prepare(`
    INSERT INTO insights (id, article_id, doc_id, insight_text, confidence, model_used)
    VALUES (@id, @article_id, @doc_id, @insight_text, @confidence, @model_used)
    ON CONFLICT(id) DO UPDATE SET
      insight_text=excluded.insight_text,
      confidence=excluded.confidence,
      model_used=excluded.model_used,
      extracted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  stmt.run(insight);
}

function deleteInsightsByDocument(docId) {
  db.prepare('DELETE FROM insights WHERE doc_id = ?').run(docId);
}

function getInsightsByDocument(docId) {
  return db.prepare(`
    SELECT i.*, a.title as article_title, a.author as article_author,
           a.start_page, a.end_page, a.category
    FROM insights i
    JOIN articles a ON a.id = i.article_id
    WHERE i.doc_id = ?
    ORDER BY a.start_page
  `).all(docId);
}

function getAllInsights(filters = {}) {
  let query = `
    SELECT i.*, a.title as article_title, a.author as article_author,
           a.start_page, a.end_page, a.category, d.issue, d.title as doc_title
    FROM insights i
    JOIN articles a ON a.id = i.article_id
    JOIN documents d ON d.id = i.doc_id
  `;
  const conditions = [];
  const params = {};

  if (filters.issue) {
    conditions.push('d.issue = @issue');
    params.issue = filters.issue;
  }
  if (filters.category) {
    conditions.push('a.category = @category');
    params.category = filters.category;
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY d.issue, a.start_page';

  if (filters.limit) {
    query += ' LIMIT @limit';
    params.limit = filters.limit;
  }

  return db.prepare(query).all(params);
}

function getArticlesWithInsights(filters = {}) {
  let query = `
    SELECT a.*, d.issue, d.title as doc_title,
           (SELECT insight_text FROM insights WHERE article_id = a.id LIMIT 1) as insight_text
    FROM articles a
    JOIN documents d ON d.id = a.doc_id
  `;
  const params = {};

  if (filters.issue) {
    query += ' WHERE d.issue = @issue';
    params.issue = filters.issue;
  }
  query += ' ORDER BY d.issue, a.start_page';

  return db.prepare(query).all(params);
}

// Daily Article cache functions
function getCachedDailyArticle(date) {
  return db.prepare('SELECT * FROM formatted_articles WHERE date = ?').get(date);
}

function cacheDailyArticle(data) {
  const stmt = db.prepare(`
    INSERT INTO formatted_articles (id, article_id, date, headline, subtitle, author, category, issue, body_html, pull_quote, cover_image, pdf_url, start_page, end_page)
    VALUES (@id, @article_id, @date, @headline, @subtitle, @author, @category, @issue, @body_html, @pull_quote, @cover_image, @pdf_url, @start_page, @end_page)
    ON CONFLICT(id) DO UPDATE SET
      headline=excluded.headline,
      subtitle=excluded.subtitle,
      author=excluded.author,
      category=excluded.category,
      issue=excluded.issue,
      body_html=excluded.body_html,
      pull_quote=excluded.pull_quote,
      cover_image=excluded.cover_image,
      pdf_url=excluded.pdf_url,
      start_page=excluded.start_page,
      end_page=excluded.end_page,
      formatted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  stmt.run(data);
}

function clearCachedDailyArticle(date) {
  db.prepare('DELETE FROM formatted_articles WHERE date = ?').run(date);
}

function getChunksByDocAndPageRange(docId, startPage, endPage) {
  return db.prepare(`
    SELECT text, page FROM chunks
    WHERE doc_id = ? AND page >= ? AND page <= ?
    ORDER BY page, chunk_index
  `).all(docId, startPage, endPage);
}

module.exports = {
  ensureDb,
  upsertDocument,
  replaceChunks,
  getAllChunks,
  getDocument,
  getAllDocuments,
  upsertArticle,
  deleteArticlesByDocument,
  getArticlesByDocument,
  getAllArticles,
  upsertInsight,
  deleteInsightsByDocument,
  getInsightsByDocument,
  getAllInsights,
  getArticlesWithInsights,
  getCachedDailyArticle,
  cacheDailyArticle,
  clearCachedDailyArticle,
  getChunksByDocAndPageRange,
  DB_PATH
};
