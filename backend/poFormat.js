/**
 * Purchase Order money formatting and totals.
 *
 * These are the authoritative computations: the server recomputes totals and the
 * amount-in-words from the raw line items on every save, so a tampered or stale
 * client payload can never produce a document whose figures disagree with its math.
 *
 * amountInWords supports two numbering systems because the app quotes POs in both
 * Indian (lakh / crore) and international (thousand / million) currencies.
 */

const CURRENCY_WORDS = {
  INR: { major: 'Indian Rupees', minor: 'Paise', system: 'indian' },
  USD: { major: 'US Dollars', minor: 'Cents', system: 'international' },
  EUR: { major: 'Euros', minor: 'Cents', system: 'international' },
  GBP: { major: 'Pounds Sterling', minor: 'Pence', system: 'international' },
  AED: { major: 'UAE Dirhams', minor: 'Fils', system: 'international' },
  SGD: { major: 'Singapore Dollars', minor: 'Cents', system: 'international' }
};

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

/** Words for 0..999. Returns '' for 0 so callers can omit empty groups. */
function belowThousand(n) {
  if (n === 0) return '';
  let words = '';
  if (n >= 100) {
    words += `${ONES[Math.floor(n / 100)]} Hundred`;
    n %= 100;
    if (n > 0) words += ' ';
  }
  if (n >= 20) {
    words += TENS[Math.floor(n / 10)];
    if (n % 10 > 0) words += ` ${ONES[n % 10]}`;
  } else if (n > 0) {
    words += ONES[n];
  }
  return words;
}

/** International grouping: thousand / million / billion / trillion. */
function internationalWords(num) {
  if (num === 0) return '';
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion', 'Quadrillion'];
  const groups = [];
  let n = num;
  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    parts.push(belowThousand(groups[i]) + (scales[i] ? ` ${scales[i]}` : ''));
  }
  return parts.join(' ');
}

/** Indian grouping: thousand / lakh / crore. */
function indianWords(num) {
  if (num === 0) return '';
  const crore = Math.floor(num / 10000000);
  let rem = num % 10000000;
  const lakh = Math.floor(rem / 100000);
  rem %= 100000;
  const thousand = Math.floor(rem / 1000);
  const hundred = rem % 1000;

  const parts = [];
  // A crore group can itself exceed 999 for very large sums, so recurse.
  if (crore) parts.push(`${crore > 999 ? indianWords(crore) : belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`);
  if (hundred) parts.push(belowThousand(hundred));
  return parts.join(' ');
}

/**
 * "Indian Rupees One Lakh Twenty Three Thousand Four Hundred Fifty and Fifty Paise Only".
 * The minor unit (paise/cents/…) is always < 100, so it is spelt with the
 * international helper regardless of the major unit's numbering system.
 */
function amountInWords(amount, currency) {
  const cfg = CURRENCY_WORDS[currency] || { major: currency || '', minor: '', system: 'international' };
  const value = round2(Math.abs(Number(amount) || 0));
  const whole = Math.floor(value);
  const minor = Math.round((value - whole) * 100);
  const wordsFor = cfg.system === 'indian' ? indianWords : internationalWords;

  let out = cfg.major ? `${cfg.major} ` : '';
  out += whole === 0 ? 'Zero' : wordsFor(whole);
  if (minor > 0 && cfg.minor) {
    out += ` and ${internationalWords(minor)} ${cfg.minor}`;
  }
  out += ' Only';
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Recompute line totals and order totals from raw items and the order-level discount.
 * grand_total = subtotal + tax − discount, with the discount clamped to [0, subtotal]
 * so it can never turn a bill negative or exceed the goods value.
 */
function computeTotals(items, discount = {}) {
  const lines = (items || [])
    .map((it, index) => {
      const quantity = Number(it.quantity) || 0;
      const unitPrice = Number(it.unitPrice) || 0;
      const taxPercent = Number(it.taxPercent) || 0;
      const lineTotal = round2(quantity * unitPrice);
      const taxAmount = round2((lineTotal * taxPercent) / 100);
      return {
        lineNo: index + 1,
        description: (it.description || '').trim(),
        hsnCode: (it.hsnCode || '').trim(),
        unit: (it.unit || 'pcs').trim() || 'pcs',
        quantity,
        unitPrice,
        taxPercent,
        lineTotal,
        taxAmount
      };
    })
    .filter((l) => l.description.length > 0);

  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const taxTotal = round2(lines.reduce((sum, l) => sum + l.taxAmount, 0));

  const discountType = discount.discountType === 'percent' ? 'percent' : 'amount';
  const discountValue = Number(discount.discountValue) || 0;
  let discountAmount = discountType === 'percent'
    ? round2((subtotal * discountValue) / 100)
    : round2(discountValue);
  discountAmount = Math.min(Math.max(discountAmount, 0), subtotal);

  const grandTotal = round2(subtotal + taxTotal - discountAmount);

  return { lines, subtotal, taxTotal, discountType, discountValue, discountAmount, grandTotal };
}

module.exports = { amountInWords, computeTotals, round2, CURRENCY_WORDS };
