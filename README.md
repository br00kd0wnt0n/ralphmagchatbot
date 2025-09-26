Ralph Magazine Chatbot
======================

A lightweight web app to chat with Ralph Magazine content. It syncs Issues from Google Drive, chunks and embeds the text for retrieval, and uses Claude to answer questions with quoted excerpts and citations (issue, page, author).

Quick Start
-----------

1) Prereqs
- Node.js 18+
- API keys: Anthropic (Claude), plus embeddings provider (OpenAI or Voyage)
- Google Cloud project with Drive and Docs APIs enabled; OAuth client credentials (Desktop App type works for local testing)

2) Setup
- Copy `.env.example` to `.env` and fill values
- Place Google OAuth JSON at the path set by `GOOGLE_OAUTH_CREDENTIALS` (e.g., `credentials/google-oauth.json`)
- Install dependencies:
  - `cd ralphmagchatbot && npm install`

3) Initialize DB (first time)
- `npm run init-db`

4) Run the app
- `npm run dev`
- Open `http://localhost:3000`

5) Authorize Google Drive
- Click “Connect Google Drive” link in the left sidebar; finish the OAuth consent flow and copy the code back only if prompted by server logs (for Desktop creds). For this app, we store tokens at `GOOGLE_OAUTH_TOKEN`.

6) Sync content
- Set `GOOGLE_DRIVE_FOLDER_IDS` (comma-separated) in `.env` to the root Issue folders
- Click “Sync Google Drive”. Indexed files will be reported.

7) Ask questions
- Use the prompt bar to query across issues; the assistant will quote and cite sources like [#3]. Sources appear below with titles, authors, issue and page numbers when available.

How It Works
------------

- Ingestion: Lists files recursively from your Drive Issue folders. Supported types now:
  - Google Docs: exported to raw text via Docs API
  - text/plain, text/markdown: downloaded as text
  - PDF: placeholder only (needs a parser/OCR; see Next Steps)
- Chunking: Splits text into overlapping chunks (configurable via env)
- Embeddings: Configurable provider via `EMBEDDINGS_PROVIDER` (OpenAI or Voyage). Embeddings are stored in SQLite.
- Retrieval: Cosine similarity against stored vectors; top-K chunks are sent to Claude.
- Answering: Claude streams an answer, quoting lines and using bracketed references [#N] matching the listed context blocks.

Environment Variables
---------------------

See `.env.example` for all options. Key ones:
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- `EMBEDDINGS_PROVIDER` = `OPENAI` or `VOYAGE`
- `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`
- `VOYAGE_API_KEY`, `VOYAGE_MODEL`
- `GOOGLE_OAUTH_CREDENTIALS`, `GOOGLE_OAUTH_TOKEN`
- `GOOGLE_DRIVE_FOLDER_IDS`
- `CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS`, `RETRIEVAL_TOP_K`

Google Drive Hookup — Automatic Ingestion
----------------------------------------

Yes. This app connects directly to Google Drive via OAuth. It now performs basic incremental sync using Drive `modifiedTime` to skip unchanged files. Options:
- Manual sync (built-in): Click “Sync Google Drive”.
- Scheduled sync: Run `POST /api/sync/google-drive` from a cron (e.g., GitHub Actions, Render cron, or a small server-side cron job) to index new/changed items.
- Webhook-like: Drive doesn’t push directly, but you can poll with `files.list` using `modifiedTime` filters.

PDFs and Assets
---------------

- PDFs are supported via `pdf-parse` for embedded text extraction.
- Image-only or scanned PDFs may still need OCR (e.g., Google Cloud Vision) to produce text.
- Design assets/photography are skipped; they do not provide text content.

Deploying
---------

- Provide environment variables in your hosting platform
- Ensure Google OAuth redirect URI matches your deployment URL if using a web client ID
- For team-wide access, consider a Google Workspace service account with domain-wide delegation (advanced setup), or keep Desktop OAuth and share the token file securely on the server.

Docker
------

- Build: `docker build -t ralphmagchatbot .`
- Run (local):
  - `docker run --rm -p 3000:3000 \
     -e ANTHROPIC_API_KEY=... \
     -e EMBEDDINGS_PROVIDER=OPENAI -e OPENAI_API_KEY=... \
     -e GOOGLE_DRIVE_FOLDER_IDS=<folder_ids> \
     -v $(pwd)/data:/app/data -v $(pwd)/credentials:/app/credentials \
     ralphmagchatbot`
- Compose (recommended locally):
  - Copy `.env.example` to `.env` (fill secrets)
  - `docker compose up --build`

Railway (GitHub + Docker)
-------------------------

1) Push repo to GitHub with `ralphmagchatbot/` at the root or as a subfolder.
2) In Railway:
   - New Project → Deploy from GitHub Repo
   - If the repo root contains multiple projects, set the “Root Directory” to `ralphmagchatbot` so Railway uses the Dockerfile there.
   - Railway autodetects Dockerfile; otherwise, choose Docker as the builder.
3) Volumes (persistence):
   - Add a Volume and mount it to `/app/data` for SQLite
   - Add another Volume (or use the same) and mount it to `/app/credentials` for OAuth tokens
4) Environment variables:
   - `ANTHROPIC_API_KEY`
   - `EMBEDDINGS_PROVIDER=OPENAI` (or `VOYAGE`)
   - `OPENAI_API_KEY` (if using OpenAI)
   - `GOOGLE_DRIVE_FOLDER_IDS=<id1,id2>`
   - Optional tuning: `RETRIEVAL_TOP_K`, `CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS`
   - The container defaults for OAuth paths are `/app/credentials/google-oauth.json` and `/app/credentials/google-token.json`.
5) Provide OAuth credentials:
   - In Railway, create a Secret File or otherwise place your Google OAuth JSON into the mounted volume path `/app/credentials/google-oauth.json` (you can upload via shell or initial deploy artifact).
6) Deploy and authorize Google:
   - Open your Railway service URL → “Connect Google Drive” to start the consent flow.
   - If you receive a code (Desktop OAuth), send it to the server:
     - `curl -X POST https://<railway-url>/api/sync/oauth2/callback -H 'content-type: application/json' -d '{"code":"<paste_code>"}'`
   - This writes `/app/credentials/google-token.json` in the volume.
7) Sync:
   - Click “Sync Google Drive” in the UI or `curl -X POST https://<railway-url>/api/sync/google-drive`

Notes for Railway
- Ensure both `/app/data` and `/app/credentials` are mounted as volumes; otherwise data and tokens won’t persist across deploys.
- Railway sets `PORT` automatically; the Dockerfile listens on `PORT` (default 3000) and exposes 3000.

Next Steps (Recommended Enhancements)
-------------------------------------

- Add OCR for scanned PDFs (e.g., Cloud Vision)
- Improve incremental sync granularity and change detection
- Store and display page numbers reliably by parsing source docs or adding page metadata in filenames
- Add admin view to inspect indexed documents and reindex selectively
- Add re-ranking or hybrid search (keyword + vector) for improved recall
