const express = require('express');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { getAllInsights, getInsightsByDocument, getArticlesWithInsights, getAllDocuments, upsertArticle, upsertInsight, deleteArticlesByDocument, deleteInsightsByDocument } = require('../services/store');
const { processDocumentInsights } = require('../services/insightsExtractor');

const router = express.Router();

// GET /api/insights - List all insights with optional filters
router.get('/', (req, res) => {
  try {
    const { issue, category, limit } = req.query;
    const filters = {};
    if (issue) filters.issue = issue;
    if (category) filters.category = category;
    if (limit) filters.limit = parseInt(limit, 10);

    const insights = getAllInsights(filters);
    res.json({ insights, count: insights.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/insights/issues - List available issues for filtering
router.get('/issues', (req, res) => {
  try {
    const docs = getAllDocuments();
    const issues = [...new Set(docs.map(d => d.issue).filter(Boolean))].sort((a, b) => {
      const numA = parseInt(a, 10) || 0;
      const numB = parseInt(b, 10) || 0;
      return numA - numB;
    });
    res.json({ issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/insights/doc/:docId - Get insights for a specific document
router.get('/doc/:docId', (req, res) => {
  try {
    const insights = getInsightsByDocument(req.params.docId);
    res.json({ insights, count: insights.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/insights/articles - List articles with their insights
router.get('/articles', (req, res) => {
  try {
    const { issue } = req.query;
    const filters = {};
    if (issue) filters.issue = issue;

    const articles = getArticlesWithInsights(filters);
    res.json({ articles, count: articles.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/insights/extract - Extract insights from all existing documents
router.post('/extract', async (req, res) => {
  const PDFS_DIR = process.env.PDFS_DIR || path.join(__dirname, '..', '..', 'data', 'pdfs');

  try {
    const docs = getAllDocuments();
    const results = [];

    for (const doc of docs) {
      // Skip if already has insights
      const existing = getInsightsByDocument(doc.id);
      if (existing.length > 0) {
        results.push({ id: doc.id, title: doc.title, status: 'skipped', insights: existing.length });
        continue;
      }

      // Find the PDF file
      const pdfPath = path.join(PDFS_DIR, doc.url.replace('/pdfs/', '').replace(/%20/g, ' '));
      if (!fs.existsSync(pdfPath)) {
        results.push({ id: doc.id, title: doc.title, status: 'file_not_found' });
        continue;
      }

      // Parse PDF to get pages
      const data = fs.readFileSync(pdfPath);
      const pages = [];
      await pdfParse(data, {
        pagerender: async (pageData) => {
          const content = await pageData.getTextContent();
          const strings = content.items.map(i => i.str);
          const pageText = strings.join(' ').replace(/\s{2,}/g, ' ').trim();
          pages.push(pageText);
          return pageText + '\n';
        }
      });

      // Extract insights
      const pagesForExtractor = pages.map((text, i) => ({ page: i + 1, text }));
      const docMeta = { title: doc.title, issue: doc.issue };

      const result = await processDocumentInsights(doc.id, pagesForExtractor, docMeta);

      // Store articles and insights
      for (const article of result.articles) {
        upsertArticle(article);
      }
      for (const insight of result.insights) {
        upsertInsight(insight);
      }

      results.push({ id: doc.id, title: doc.title, status: 'processed', insights: result.insights.length, articles: result.articles.length });
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
