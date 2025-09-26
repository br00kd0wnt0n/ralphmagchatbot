function estimateTokens(str) {
  // Rough heuristic: ~4 chars/token
  return Math.ceil((str || '').length / 4);
}

function chunkText(text, opts = {}) {
  const size = Number(process.env.CHUNK_SIZE_CHARS || 1500);
  const overlap = Number(process.env.CHUNK_OVERLAP_CHARS || 200);
  const paragraphs = (text || '').split(/\n\n+/);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if (estimateTokens(buf + '\n\n' + p) <= size) {
      buf = buf ? buf + '\n\n' + p : p;
    } else {
      if (buf) chunks.push(buf);
      // Start next chunk with overlap
      const tail = buf.slice(Math.max(0, buf.length - overlap));
      buf = tail + (tail ? '\n' : '') + p;
      if (estimateTokens(buf) > size) {
        // Hard wrap long paragraph
        for (let i = 0; i < p.length; i += size) {
          chunks.push(p.slice(i, i + size));
        }
        buf = '';
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

module.exports = { chunkText };

