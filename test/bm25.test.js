const test = require('node:test');
const assert = require('node:assert');
const { buildIndex, searchIndex } = require('../src/knowledge/bm25');

const chunks = [
  { id: 'prices', docName: 'd', page: 1, text: 'سعر الباقة الشهرية 500 جنيه' },
  { id: 'hours', docName: 'd', page: 2, text: 'مواعيد العمل من التاسعة صباحا حتى الخامسة مساء' },
  { id: 'refunds', docName: 'd', page: 3, text: 'سياسة الاسترجاع تسمح باسترداد المبلغ خلال سبعة ايام' },
  { id: 'social', docName: 'd', page: 4, text: 'ادارة وسائل التواصل الاجتماعي وانشاء المحتوى' },
];
const idx = buildIndex(chunks);

test('finds the prices chunk', () => {
  assert.strictEqual(searchIndex(idx, 'كام سعر الباقة الشهرية', 3)[0].chunk.id, 'prices');
});
test('tashkeel variant matches', () => {
  // Query is only the diacritized term: it can match the prices chunk solely
  // if tashkeel is stripped (raw 'سَعْر' is not a posting key).
  const r = searchIndex(idx, 'سَعْر', 3);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].chunk.id, 'prices');
  const plain = searchIndex(idx, 'سعر', 3);
  assert.deepStrictEqual(r.map((x) => x.chunk.id), plain.map((x) => x.chunk.id));
});
test('stopword mixed with real terms is dropped', () => {
  const withStop = searchIndex(idx, 'في الباقة من', 3);
  const without = searchIndex(idx, 'الباقة', 3);
  assert.deepStrictEqual(withStop.map((x) => x.chunk.id), without.map((x) => x.chunk.id));
  assert.deepStrictEqual(withStop.map((x) => x.score), without.map((x) => x.score));
});
test('stopword-only query returns []', () => {
  assert.deepStrictEqual(searchIndex(idx, 'the of في من and', 3), []);
});
test('no shared terms returns []', () => {
  assert.deepStrictEqual(searchIndex(idx, 'zebra quantum', 3), []);
});
test('result length is capped at k', () => {
  // The query matches all 4 fixture chunks, so k=2 yields exactly 2.
  assert.strictEqual(searchIndex(idx, 'الباقة العمل الاسترجاع التواصل', 4).length, 4);
  assert.strictEqual(searchIndex(idx, 'الباقة العمل الاسترجاع التواصل', 2).length, 2);
});
test('scores positive and sorted descending; index is JSON-serializable', () => {
  const r = searchIndex(JSON.parse(JSON.stringify(idx)), 'الباقة الشهرية العمل', 4);
  assert.ok(r.length > 1);
  for (let i = 0; i < r.length; i++) {
    assert.ok(r[i].score > 0);
    if (i) assert.ok(r[i - 1].score >= r[i].score);
  }
});
