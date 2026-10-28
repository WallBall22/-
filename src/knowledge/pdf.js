const fs = require('node:fs');
const { PDFParse } = require('pdf-parse');

const EMPTY_PAGE_MIN_CHARS = 20;

// pdf-parse 2.x exposes a class API: getText() returns per-page results.
async function extractPages(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const pages = result.pages.map((p) => ({ page: p.num, text: p.text }));
    const emptyPages = pages
      .filter((p) => p.text.trim().length < EMPTY_PAGE_MIN_CHARS)
      .map((p) => p.page);
    return { pages, emptyPages };
  } finally {
    await parser.destroy();
  }
}

module.exports = { extractPages };
