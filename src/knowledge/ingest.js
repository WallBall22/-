const fs = require('node:fs');
const path = require('node:path');
const { extractPages } = require('./pdf');
const { chunkPages } = require('./chunk');
const { buildIndex } = require('./bm25');
const { saveIndex } = require('./store');

async function ingestFolder(dir, outPath) {
  const entries = await fs.promises.readdir(dir);
  const pdfs = entries.filter((f) => /\.pdf$/i.test(f)).sort();
  const chunks = [];
  const emptyPages = [];
  for (const file of pdfs) {
    const docName = file.replace(/\.pdf$/i, '');
    const { pages, emptyPages: empties } = await extractPages(path.join(dir, file));
    for (const page of empties) {
      console.warn(`Warning: ${docName} page ${page} has no extractable text (scanned?)`);
      emptyPages.push({ docName, page });
    }
    chunks.push(...chunkPages(docName, pages));
  }
  await saveIndex(outPath, buildIndex(chunks));
  return { documents: pdfs.length, chunks: chunks.length, emptyPages };
}

module.exports = { ingestFolder };
