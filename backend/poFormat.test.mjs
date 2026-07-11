import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { amountInWords, computeTotals } = require('./poFormat.js');

test('amountInWords: Indian numbering uses lakh and crore', () => {
  assert.equal(amountInWords(0, 'INR'), 'Indian Rupees Zero Only');
  assert.equal(amountInWords(50, 'INR'), 'Indian Rupees Fifty Only');
  assert.equal(amountInWords(1234, 'INR'), 'Indian Rupees One Thousand Two Hundred Thirty Four Only');
  assert.equal(
    amountInWords(123450, 'INR'),
    'Indian Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Only'
  );
  assert.equal(
    amountInWords(10000000, 'INR'),
    'Indian Rupees One Crore Only'
  );
});

test('amountInWords: paise are spelt out as the minor unit', () => {
  assert.equal(
    amountInWords(1250.75, 'INR'),
    'Indian Rupees One Thousand Two Hundred Fifty and Seventy Five Paise Only'
  );
});

test('amountInWords: international numbering uses thousand and million', () => {
  assert.equal(amountInWords(1000000, 'USD'), 'US Dollars One Million Only');
  assert.equal(
    amountInWords(2500.5, 'USD'),
    'US Dollars Two Thousand Five Hundred and Fifty Cents Only'
  );
  assert.equal(amountInWords(99, 'EUR'), 'Euros Ninety Nine Only');
});

test('amountInWords: rounds to two decimals', () => {
  assert.equal(amountInWords(9.999, 'USD'), 'US Dollars Ten Only');
});

test('computeTotals: derives line totals, tax and grand total', () => {
  const r = computeTotals(
    [
      { description: 'Laptop', quantity: 2, unitPrice: 50000, taxPercent: 18 },
      { description: 'Mouse', quantity: 4, unitPrice: 500, taxPercent: 18 }
    ],
    { discountType: 'amount', discountValue: 0 }
  );
  assert.equal(r.subtotal, 102000);
  assert.equal(r.taxTotal, 18360);
  assert.equal(r.grandTotal, 120360);
  assert.equal(r.lines[0].lineTotal, 100000);
});

test('computeTotals: percentage discount is applied to the subtotal', () => {
  const r = computeTotals(
    [{ description: 'Item', quantity: 1, unitPrice: 1000, taxPercent: 10 }],
    { discountType: 'percent', discountValue: 10 }
  );
  assert.equal(r.subtotal, 1000);
  assert.equal(r.taxTotal, 100);
  assert.equal(r.discountAmount, 100);
  assert.equal(r.grandTotal, 1000); // 1000 + 100 - 100
});

test('computeTotals: discount can never exceed the subtotal', () => {
  const r = computeTotals(
    [{ description: 'Item', quantity: 1, unitPrice: 100, taxPercent: 0 }],
    { discountType: 'amount', discountValue: 9999 }
  );
  assert.equal(r.discountAmount, 100);
  assert.equal(r.grandTotal, 0);
});

test('computeTotals: blank line items are dropped', () => {
  const r = computeTotals(
    [
      { description: '', quantity: 5, unitPrice: 100 },
      { description: 'Real', quantity: 1, unitPrice: 100 }
    ],
    {}
  );
  assert.equal(r.lines.length, 1);
  assert.equal(r.subtotal, 100);
});
