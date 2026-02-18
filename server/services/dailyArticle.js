const crypto = require('crypto');
const store = require('./store');
const { getOpenAIClient, getModel } = require('./openaiClient');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Day-of-week category rotation
const DAY_CATEGORIES = [
  'Interview',    // Sunday (0)
  'Interview',    // Monday (1)
  'Feature',      // Tuesday (2)
  'Culture',      // Wednesday (3)
  'Fashion',      // Thursday (4)
  'Editorial',    // Friday (5)
  'Profile',      // Saturday (6)
];

// Fallback order when primary category has no articles
const FALLBACK_CATEGORIES = [
  'Feature', 'Interview', 'Culture', 'Editorial',
  'Fashion', 'Profile', 'Review', 'Photo Essay'
];

/**
 * Simple hash of a string to a number for deterministic selection.
 */
function hashToIndex(str, max) {
  const hash = crypto.createHash('md5').update(str).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return num % max;
}

/**
 * Deterministic daily article selection.
 * Same date always returns the same article.
 */
function pickArticleForDate(date) {
  const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
  const dayOfWeek = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  const preferredCategory = DAY_CATEGORIES[dayOfWeek];

  const allArticles = store.getAllArticles();
  if (!allArticles || allArticles.length === 0) return null;

  // Try preferred category first
  let pool = allArticles.filter(a =>
    a.category && a.category.toLowerCase() === preferredCategory.toLowerCase()
  );

  // Try fallback categories
  if (pool.length === 0) {
    for (const cat of FALLBACK_CATEGORIES) {
      pool = allArticles.filter(a =>
        a.category && a.category.toLowerCase() === cat.toLowerCase()
      );
      if (pool.length > 0) break;
    }
  }

  // Last resort: all articles
  if (pool.length === 0) pool = allArticles;

  const idx = hashToIndex(dateStr, pool.length);
  return pool[idx];
}

/**
 * Assemble raw text for an article from its chunks.
 */
function getArticleText(article) {
  const chunks = store.getChunksByDocAndPageRange(
    article.doc_id,
    article.start_page,
    article.end_page
  );

  if (!chunks || chunks.length === 0) return '';
  return chunks.map(c => c.text).join('\n\n');
}

/**
 * Format article using GPT-4o.
 * Returns structured JSON with clean HTML and metadata.
 */
async function formatArticle(article, rawText, issueNumber) {
  const client = getOpenAIClient();
  const model = getModel();

  const prompt = `You are a magazine article formatter for Ralph Magazine, a premium culture and fashion publication.

Given the raw OCR-extracted text of an article, reformat it into clean, well-structured semantic HTML.

Article metadata:
- Title: ${article.title || 'Untitled'}
- Author: ${article.author || 'Ralph Magazine'}
- Category: ${article.category || 'Feature'}
- Issue: ${issueNumber || article.issue || ''}
- Pages: ${article.start_page}-${article.end_page}

Instructions:
1. Clean up OCR artifacts (broken words, random characters, misplaced line breaks)
2. Add proper paragraph breaks (<p> tags)
3. Create section headers where appropriate (<h3> tags)
4. Identify the single best pull quote from the article (a compelling, standalone sentence)
5. Ensure proper typography (em dashes, smart quotes where appropriate)
6. Output semantic HTML only - no <html>, <head>, <body> wrapper tags
7. Do NOT invent or add content not present in the original text
8. If the title in the text differs from metadata, prefer the in-text title

Return a JSON object with these exact fields:
{
  "headline": "The article headline",
  "subtitle": "A brief subtitle or deck (1 sentence, can be derived from the opening)",
  "author": "Author name",
  "category": "Category",
  "issue": "Issue number/name",
  "bodyHtml": "<p>Formatted HTML body...</p>",
  "pullQuote": "A compelling quote from the article"
}

Return ONLY valid JSON, no markdown code fences.`;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: rawText.substring(0, 15000) } // Limit to avoid token overflow
    ],
    temperature: 0.3,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  });

  const text = response.choices[0].message.content;
  try {
    return JSON.parse(text);
  } catch (e) {
    logger.error({ error: e.message }, 'Failed to parse GPT-4o formatting response');
    // Return a basic fallback
    return {
      headline: article.title || 'Untitled Article',
      subtitle: '',
      author: article.author || 'Ralph Magazine',
      category: article.category || 'Feature',
      issue: article.issue || '',
      bodyHtml: rawText.split('\n\n').map(p => `<p>${p.trim()}</p>`).join('\n'),
      pullQuote: ''
    };
  }
}

/**
 * Resolve the cover image path for an issue number.
 */
function getCoverImageUrl(issue) {
  if (!issue) return '/covers/Issue1cover.png';
  // Extract number from issue string (e.g. "1", "Issue 3", "No. 5")
  const match = String(issue).match(/(\d+)/);
  const num = match ? match[1] : '1';
  return `/covers/Issue${num}cover.png`;
}

/**
 * Resolve the PDF URL for a document.
 */
function getPdfUrl(doc) {
  if (!doc) return null;
  const baseUrl = process.env.PDF_BASE_URL || null;
  const rawUrl = doc.url || '';
  // url field is like "/pdfs/Ralph%20Magazine%20No4%20Visual%20LR.pdf"
  // Strip the /pdfs/ prefix if present, then decode to get the filename
  const filename = decodeURIComponent(rawUrl.replace(/^\/pdfs\//, ''));
  if (baseUrl) return `${baseUrl}/${encodeURIComponent(filename)}`;
  return `/pdfs/${encodeURIComponent(filename)}`;
}

/**
 * Extract issue number from document metadata or title.
 */
function resolveIssueNumber(doc) {
  if (!doc) return '';
  if (doc.issue) return doc.issue;
  // Try to extract from title: "Ralph Magazine 1", "Ralph Magazine No4 Visual LR"
  const title = doc.title || '';
  const match = title.match(/(?:No\.?\s*|Magazine\s+)(\d+)/i);
  return match ? match[1] : '';
}

/**
 * Main entry point: get today's daily article, formatted and cached.
 */
async function getDailyArticle(date) {
  const dateStr = date || new Date().toISOString().split('T')[0];

  // Check cache first
  const cached = store.getCachedDailyArticle(dateStr);
  if (cached) {
    return {
      headline: cached.headline,
      subtitle: cached.subtitle,
      author: cached.author,
      category: cached.category,
      issue: cached.issue,
      bodyHtml: cached.body_html,
      pullQuote: cached.pull_quote,
      coverImage: cached.cover_image,
      pdfUrl: cached.pdf_url,
      pageRange: `${cached.start_page}-${cached.end_page}`,
      date: cached.date,
      cached: true
    };
  }

  // Pick article for this date
  const article = pickArticleForDate(dateStr);
  if (!article) {
    return null;
  }

  logger.info({ date: dateStr, article: article.title, category: article.category }, 'Picked daily article');

  // Get raw text
  const rawText = getArticleText(article);
  if (!rawText) {
    logger.warn({ articleId: article.id }, 'No text found for article');
    return null;
  }

  // Resolve assets
  const doc = store.getDocument(article.doc_id);
  const issueNum = resolveIssueNumber(doc);

  // Format with GPT-4o
  const formatted = await formatArticle(article, rawText, issueNum);
  const coverImage = getCoverImageUrl(issueNum);
  const pdfUrl = getPdfUrl(doc);

  // Cache the result
  const cacheId = `daily-${dateStr}`;
  const fmtIssue = formatted.issue && formatted.issue.toLowerCase() !== 'unknown' ? formatted.issue : '';
  const issueVal = issueNum || fmtIssue || '';
  store.cacheDailyArticle({
    id: cacheId,
    article_id: article.id,
    date: dateStr,
    headline: formatted.headline || article.title,
    subtitle: formatted.subtitle || '',
    author: formatted.author || article.author || '',
    category: formatted.category || article.category || '',
    issue: issueVal,
    body_html: formatted.bodyHtml || '',
    pull_quote: formatted.pullQuote || '',
    cover_image: coverImage,
    pdf_url: pdfUrl,
    start_page: article.start_page,
    end_page: article.end_page
  });

  return {
    headline: formatted.headline || article.title,
    subtitle: formatted.subtitle || '',
    author: formatted.author || article.author || '',
    category: formatted.category || article.category || '',
    issue: issueVal,
    bodyHtml: formatted.bodyHtml || '',
    pullQuote: formatted.pullQuote || '',
    coverImage,
    pdfUrl,
    pageRange: `${article.start_page}-${article.end_page}`,
    date: dateStr,
    cached: false
  };
}

/**
 * Force refresh: clear cache for a date and regenerate.
 */
async function refreshDailyArticle(date) {
  const dateStr = date || new Date().toISOString().split('T')[0];
  store.clearCachedDailyArticle(dateStr);
  return getDailyArticle(dateStr);
}

/**
 * Preview articles for a date range (no GPT-4o calls).
 * Returns metadata only: deterministic pick + cache status.
 */
function previewArticlesForRange(startDate, days) {
  const results = [];
  const start = new Date(startDate + 'T12:00:00Z');

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

    const article = pickArticleForDate(dateStr);
    if (!article) {
      results.push({ date: dateStr, dayName, category: null, title: null, author: null, issue: null, pageRange: null, isCached: false });
      continue;
    }

    const doc = store.getDocument(article.doc_id);
    const issueNum = resolveIssueNumber(doc);
    const cached = store.getCachedDailyArticle(dateStr);

    results.push({
      date: dateStr,
      dayName,
      category: article.category || '',
      title: article.title || 'Untitled',
      author: article.author || '',
      issue: issueNum,
      pageRange: `${article.start_page}-${article.end_page}`,
      isCached: !!cached
    });
  }

  return results;
}

module.exports = {
  getDailyArticle,
  refreshDailyArticle,
  pickArticleForDate,
  previewArticlesForRange,
  resolveIssueNumber
};
