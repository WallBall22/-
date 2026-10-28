const test = require('node:test');
const assert = require('node:assert');
const { chunkPages } = require('../src/knowledge/chunk');

test('1200-char page yields chunks <=500 with 80-char overlap', () => {
	const text = Array.from({ length: 1200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
	const chunks = chunkPages('doc', [{ page: 1, text }]);
	assert.ok(chunks.length > 1);
	for (const c of chunks) assert.ok(c.text.length <= 500);
	for (let i = 1; i < chunks.length; i++) {
		assert.strictEqual(chunks[i - 1].text.slice(-80), chunks[i].text.slice(0, 80));
	}
});

test('chunks keep docName and page', () => {
	const chunks = chunkPages('d', [{ page: 7, text: 'x'.repeat(900) }]);
	for (const c of chunks) {
		assert.strictEqual(c.docName, 'd');
		assert.strictEqual(c.page, 7);
	}
});

test('empty or whitespace pages produce no chunks', () => {
	assert.deepStrictEqual(chunkPages('d', [{ page: 1, text: '' }, { page: 2, text: '  \n\t ' }]), []);
});

test('short page yields one chunk equal to trimmed text', () => {
	const chunks = chunkPages('d', [{ page: 1, text: '  hello world \n' }]);
	assert.strictEqual(chunks.length, 1);
	assert.strictEqual(chunks[0].text, 'hello world');
});

test('chunk ids are unique across pages', () => {
	const chunks = chunkPages('d', [
		{ page: 1, text: 'a'.repeat(1200) },
		{ page: 2, text: 'b'.repeat(1200) },
	]);
	const ids = chunks.map((c) => c.id);
	assert.strictEqual(new Set(ids).size, ids.length);
	assert.strictEqual(ids[0], 'd#p1#0');
});
