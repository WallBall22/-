const { normalizeArabic } = require('./arabic');
const { STOPWORDS } = require('./stopwords');

const K1 = 1.5;
const B = 0.75;

function tokenize(text) {
  return normalizeArabic(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t));
}

function buildIndex(chunks) {
  const postings = Object.create(null); // term -> { docIdx: tf }
  const docLengths = [];
  let total = 0;
  chunks.forEach((chunk, i) => {
    const tokens = tokenize(chunk.text);
    docLengths.push(tokens.length);
    total += tokens.length;
    for (const t of tokens) {
      const p = postings[t] || (postings[t] = {});
      p[i] = (p[i] || 0) + 1;
    }
  });
  return {
    chunks,
    postings,
    docLengths,
    avgLength: chunks.length ? total / chunks.length : 0,
  };
}

function searchIndex(index, query, k) {
  const n = index.chunks.length;
  const scores = new Map();
  for (const term of new Set(tokenize(query))) {
    const p = index.postings[term];
    if (!p) continue;
    const df = Object.keys(p).length;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (const [doc, tf] of Object.entries(p)) {
      const len = index.docLengths[doc];
      const norm = 1 - B + B * (len / (index.avgLength || 1));
      const s = idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
      scores.set(doc, (scores.get(doc) || 0) + s);
    }
  }
  return [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([doc, score]) => ({ chunk: index.chunks[doc], score }));
}

module.exports = { buildIndex, searchIndex };
