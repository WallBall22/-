const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ingestFolder } = require('../src/knowledge/ingest');
const { loadIndex } = require('../src/knowledge/store');
const { searchIndex } = require('../src/knowledge/bm25');

const FIX = path.join(__dirname, 'fixtures');

const dirs = [];

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servia-ingest-'));
  dirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('ingestFolder indexes PDFs, ignores other files, and loadIndex is searchable', async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(FIX, 'sample.pdf'), path.join(dir, 'sample.pdf'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'monthly plan notes that must be ignored');
  const out = path.join(dir, 'out', 'index.json');
  const res = await ingestFolder(dir, out);
  assert.strictEqual(res.documents, 1);
  assert.ok(res.chunks >= 2);
  assert.ok(fs.existsSync(out));
  const index = await loadIndex(out);
  const hits = searchIndex(index, 'monthly plan', 3);
  assert.ok(hits.length > 0);
  assert.ok(JSON.stringify(hits).includes('sample'));
  assert.ok(!JSON.stringify(index).includes('notes'));
});

test('loadIndex on a missing path rejects telling the user to run npm run ingest', async () => {
  const missing = path.join(tmp(), 'nope.json');
  await assert.rejects(() => loadIndex(missing), (err) => err.message.includes('npm run ingest'));
});

test('empty folder yields zero documents and still writes an index', async () => {
  const dir = tmp();
  const out = path.join(dir, 'index.json');
  const res = await ingestFolder(dir, out);
  assert.strictEqual(res.documents, 0);
  assert.strictEqual(res.chunks, 0);
  assert.ok(fs.existsSync(out));
});

test('blank (scanned-like) page is reported in emptyPages and does not throw', async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(FIX, 'blank-page.pdf'), path.join(dir, 'blank-page.pdf'));
  const out = path.join(dir, 'index.json');
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let res;
  try {
    res = await ingestFolder(dir, out);
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(res.documents, 1);
  assert.deepStrictEqual(res.emptyPages, [{ docName: 'blank-page', page: 1 }]);
  assert.ok(
    warnings.some((m) => m.includes('blank-page') && /page\s*1\b/i.test(m)),
    `expected a warning mentioning blank-page and page 1, got: ${JSON.stringify(warnings)}`
  );
});
