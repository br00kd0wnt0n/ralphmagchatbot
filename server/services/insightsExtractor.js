const crypto = require('crypto');
const { getOpenAIClient, getModel } = require('./openaiClient');

const ARTICLE_DETECTION_PROMPT = `You are analyzing Ralph Magazine, a fashion and culture publication. Given the text from consecutive pages, identify distinct articles/stories.

For each article found, provide:
- title: The article's headline or title
- author: Author/interviewer name if mentioned (null if not found)
- startPage: Page number where article begins
- endPage: Page number where article ends
- category: One of ["Interview", "Feature", "Editorial", "Fashion", "Culture", "Profile", "Review", "Photo Essay"]

Rules:
- Look for clear article boundaries: new headlines, bylines, topic shifts
- Table of contents, masthead, credits, and ads should be SKIPPED
- Combine multi-page articles (don't split them)
- Minimum article length: content spanning at least half a page

Return ONLY valid JSON object with an "articles" key: { "articles": [{ "title": "...", "author": "...", "startPage": N, "endPage": N, "category": "..." }] }`;

const INSIGHT_EXTRACTION_PROMPT = `You are reading an article from Ralph Magazine, a fashion and culture publication known for incisive perspectives.

Article Title: {{title}}
Author: {{author}}
Category: {{category}}
Pages: {{startPage}}-{{endPage}}

Article Text:
{{articleText}}

Task: Extract the KEY TAKEAWAY or THESIS of this article in 1-2 sentences.

Guidelines:
- Capture the central argument, insight, or unique perspective
- Be specific and substantive - avoid generic statements
- Use engaging, quotable language
- For interviews: what is the subject's core message or revelation?
- For features: what trend, insight, or cultural observation is being made?
- For profiles: what defines this person or makes them significant?

Return ONLY valid JSON: { "insight": "Your 1-2 sentence takeaway", "confidence": 0.0-1.0 }`;

/**
 * Detect article boundaries within a document's pages
 * @param {Array<{page: number, text: string}>} pages - Array of page objects
 * @param {Object} docMeta - Document metadata (title, issue)
 * @returns {Promise<Array>} - Detected articles
 */
async function detectArticleBoundaries(pages, docMeta) {
  const openai = getOpenAIClient();
  const model = process.env.INSIGHTS_MODEL || getModel();

  // Prepare page summaries for detection (truncate very long pages)
  const pagesSummary = pages.map(p => {
    const text = p.text.slice(0, 2000); // Limit per page
    return `--- Page ${p.page} ---\n${text}`;
  }).join('\n\n');

  const systemPrompt = ARTICLE_DETECTION_PROMPT;
  const userPrompt = `Magazine: ${docMeta.title || 'Ralph Magazine'} (Issue ${docMeta.issue || 'Unknown'})
Total Pages: ${pages.length}

Content:
${pagesSummary}`;

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content || '[]';
    // Parse JSON - handle both array and object with articles key
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn('[insightsExtractor] Failed to parse article detection response');
      return [];
    }

    // Handle if response is { articles: [...] } or just [...]
    const articles = Array.isArray(parsed) ? parsed : (parsed.articles || Object.values(parsed).find(v => Array.isArray(v)) || []);
    return articles.filter(a => a.title && a.startPage && a.endPage);
  } catch (err) {
    console.error('[insightsExtractor] Article detection failed:', err.message);
    return [];
  }
}

/**
 * Extract insight for a single article
 * @param {string} articleText - Combined text of the article
 * @param {Object} articleMeta - Article metadata
 * @returns {Promise<Object>} - Extracted insight
 */
async function extractInsight(articleText, articleMeta) {
  const openai = getOpenAIClient();
  const model = process.env.INSIGHTS_MODEL || getModel();

  const prompt = INSIGHT_EXTRACTION_PROMPT
    .replace('{{title}}', articleMeta.title || 'Untitled')
    .replace('{{author}}', articleMeta.author || 'Unknown')
    .replace('{{category}}', articleMeta.category || 'Feature')
    .replace('{{startPage}}', articleMeta.startPage || '?')
    .replace('{{endPage}}', articleMeta.endPage || '?')
    .replace('{{articleText}}', articleText.slice(0, 12000)); // Limit context

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      insight: parsed.insight || null,
      confidence: parsed.confidence || 0.8,
      model_used: model
    };
  } catch (err) {
    console.error('[insightsExtractor] Insight extraction failed for:', articleMeta.title, err.message);
    return { insight: null, confidence: 0, model_used: model };
  }
}

/**
 * Process a full document: detect articles and extract insights
 * @param {string} docId - Document ID
 * @param {Array<{page: number, text: string}>} pages - Page content
 * @param {Object} docMeta - Document metadata
 * @returns {Promise<{articles: Array, insights: Array}>}
 */
async function processDocumentInsights(docId, pages, docMeta) {
  console.log(`[insightsExtractor] Processing ${docMeta.title || docId} (${pages.length} pages)`);

  // Step 1: Detect article boundaries
  const detectedArticles = await detectArticleBoundaries(pages, docMeta);
  console.log(`[insightsExtractor] Detected ${detectedArticles.length} articles`);

  if (detectedArticles.length === 0) {
    return { articles: [], insights: [] };
  }

  const articles = [];
  const insights = [];

  // Step 2: Extract insight for each article
  for (const article of detectedArticles) {
    // Generate article ID
    const articleId = crypto.createHash('sha1')
      .update(`${docId}-${article.startPage}-${article.title}`)
      .digest('hex');

    // Gather article text from relevant pages
    const articlePages = pages.filter(p =>
      p.page >= article.startPage && p.page <= article.endPage
    );
    const articleText = articlePages.map(p => p.text).join('\n\n');

    // Store article record
    const articleRecord = {
      id: articleId,
      doc_id: docId,
      title: article.title,
      author: article.author || null,
      start_page: article.startPage,
      end_page: article.endPage,
      category: article.category || 'Feature'
    };
    articles.push(articleRecord);

    // Extract insight
    const result = await extractInsight(articleText, article);

    if (result.insight) {
      const insightId = crypto.createHash('sha1')
        .update(`${articleId}-insight`)
        .digest('hex');

      insights.push({
        id: insightId,
        article_id: articleId,
        doc_id: docId,
        insight_text: result.insight,
        confidence: result.confidence,
        model_used: result.model_used
      });

      console.log(`[insightsExtractor] "${article.title}" -> "${result.insight.slice(0, 60)}..."`);
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  return { articles, insights };
}

module.exports = {
  detectArticleBoundaries,
  extractInsight,
  processDocumentInsights
};
