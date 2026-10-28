const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { extractPages } = require('../src/knowledge/pdf');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample.pdf');

test('extractPages returns two pages with page 1 text', async () => {
  const { pages } = await extractPages(FIXTURE);
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(pages[0].page, 1);
  assert.strictEqual(pages[1].page, 2);
  assert.ok(pages[0].text.includes('monthly plan costs 500'));
});

test('emptyPages is empty for the fixture', async () => {
  const { emptyPages } = await extractPages(FIXTURE);
  assert.deepStrictEqual(emptyPages, []);
});

test('missing path rejects with an error naming the path', async () => {
  const missing = path.join(__dirname, 'fixtures', 'nope.pdf');
  await assert.rejects(() => extractPages(missing), (err) => err.message.includes(missing));
});
