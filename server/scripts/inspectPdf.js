#!/usr/bin/env node
// Quick PDF suitability checker for RAG
// Usage: node server/scripts/inspectPdf.js "/path/to/file.pdf"

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

async function main() {
  const file = process.argv.slice(2).join(' ').trim();
  if (!file) {
    console.error('Usage: node server/scripts/inspectPdf.js "/path/to/file.pdf"');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('File not found:', file);
    process.exit(1);
  }
  const stat = fs.statSync(file);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  const buf = fs.readFileSync(file);

  // Collect per-page text via pagerender
  const pages = [];
  const parsed = await pdfParse(buf, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      const strings = content.items.map(i => i.str);
      const pageText = strings.join(' ').replace(/\s{2,}/g, ' ').trim();
      pages.push(pageText);
      return pageText + '\n';
    }
  });

  const text = parsed.text || pages.join('\n\n');
  const numPages = parsed.numpages || pages.length || 'unknown';
  const totalChars = text.length;
  const alphaCount = (text.match(/[A-Za-z]/g) || []).length;
  const wordCount = (text.match(/[A-Za-z0-9']+/g) || []).length;
  const wordsPerPage = numPages && Number.isFinite(numPages) ? (wordCount / numPages) : 'n/a';

  // Simple heuristics
  const alphaRatio = totalChars ? (alphaCount / totalChars) : 0;
  const likelyScanned = (wordsPerPage !== 'n/a' && wordsPerPage < 50) || alphaRatio < 0.05; // very low text density
  const recommendation = likelyScanned ? 'Likely needs OCR (scanned or minimal selectable text)' : 'Good candidate for RAG (extractable text present)';

  console.log('PDF:', path.basename(file));
  console.log('Path:', file);
  console.log('Size:', sizeMB, 'MB');
  console.log('Pages:', numPages);
  console.log('Total characters (extracted):', totalChars);
  console.log('Words (approx):', wordCount);
  console.log('Words per page (approx):', wordsPerPage);
  console.log('Alpha ratio:', alphaRatio.toFixed(3));
  console.log('Assessment:', recommendation);
  console.log('\nSample (first ~500 chars):');
  console.log((text || '').slice(0, 500).replace(/\s+/g, ' ').trim());
}

main().catch((e) => {
  console.error('Failed to inspect PDF:', e.message);
  process.exit(1);
});

