# Railway Deployment Guide

## Prerequisites
- Railway account
- OpenAI API key

## Environment Variables Required

Set these in Railway dashboard under your project settings:

```
CONTENT_SOURCE=PDFS
PDFS_DIR=./data/pdfs
COVERS_DIR=./data/covers
DB_DIR=/app/credentials
OPENAI_API_KEY=your-openai-api-key
OPENAI_CHAT_MODEL=gpt-4o
OPENAI_EMBEDDING_MODEL=text-embedding-3-large
EMBEDDINGS_PROVIDER=OPENAI
CHUNK_SIZE_CHARS=1500
CHUNK_OVERLAP_CHARS=200
RETRIEVAL_TOP_K=8
CORS_ORIGIN=https://your-app-name.up.railway.app
ADMIN_USER=admin
ADMIN_PASS=secure-password
NODE_ENV=production
```

Notes:
- Mount your Railway Volume at `/app/credentials` and keep `DB_DIR=/app/credentials` so the SQLite DB is writable without hiding bundled PDFs/covers.
- Do not mount a volume at `/app/data` — that path contains the packaged `data/pdfs` and `data/covers` shipped in the image.

## Deployment Steps

1. **Create Railway Project**
   ```bash
   railway login
   railway init
   ```

2. **Set Environment Variables**
   - Go to Railway dashboard
   - Navigate to your project
   - Go to Variables tab
   - Add each variable from the list above

3. **Deploy**
   ```bash
   git push origin main
   railway up
   ```

4. **Verify Deployment**
   - Visit your app URL
   - Check that covers are displaying
   - Try sending a chat message
   - Verify PDFs are auto-indexed on page load

## Features Included

- 3 Ralph Magazine PDFs with covers
- Auto-indexing on page load
- PDF and cover serving
- Search functionality with citations
- Magazine-style chat responses

## Volumes and Static Data

- If you need persistence, add a Railway Volume and set its mount path to `/app/credentials`.
- The app serves static PDFs from `PDFS_DIR` (default `/app/data/pdfs`) and covers from `COVERS_DIR` (default `/app/data/covers`). These live inside the image and should not be mounted over.

## Troubleshooting

- If chat returns 400 error: Check that CONTENT_SOURCE=PDFS is set
- If covers don't show: Verify `COVERS_DIR=./data/covers` is set and no volume is mounted at `/app/data`.
- If indexing finds 0 files: You likely mounted a volume at `/app/data`. Move the volume to `/app/credentials` and set `DB_DIR=/app/credentials`.
- If indexing fails with an error: Check your `OPENAI_API_KEY` is set and has credits.
