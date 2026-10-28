const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeArabic } = require('../src/knowledge/arabic');

test('removes tashkeel and unifies alef', () => {
  assert.strictEqual(normalizeArabic('أَسْعَار'), 'اسعار');
});
test('unifies alef variants', () => {
  assert.strictEqual(normalizeArabic('إعلان آخر'), 'اعلان اخر');
});
test('alef maksura to ya', () => {
  assert.strictEqual(normalizeArabic('مستشفى'), 'مستشفي');
});
test('ta marbuta to ha', () => {
  assert.strictEqual(normalizeArabic('خدمة'), 'خدمه');
});
test('removes tatweel', () => {
  assert.strictEqual(normalizeArabic('ســعر'), 'سعر');
});
test('lowercases latin and collapses whitespace', () => {
  assert.strictEqual(normalizeArabic('  Price   PDF  '), 'price pdf');
});
