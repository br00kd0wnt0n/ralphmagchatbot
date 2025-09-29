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

module.exports = { ensureDb, upsertDocument, replaceChunks, getAllChunks, getDocument, DB_PATH };
