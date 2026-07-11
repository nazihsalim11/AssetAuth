/**
 * Client-side Purchase Order PDF generator.
 *
 * The server owns all the figures (totals, amount-in-words, PO number); this only
 * lays them out on the company letterhead. jsPDF's core Helvetica font uses WinAnsi
 * encoding and has no rupee/most currency glyphs, so amounts are drawn as grouped
 * numbers with the currency shown as a 3-letter code — never a symbol.
 *
 * buildPoDoc returns the jsPDF instance; the thin wrappers below turn it into a
 * preview tab, a download, a print job, or a File to upload and version.
 */

import { jsPDF } from 'jspdf';

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_Y = PAGE_H - 12;

const PRIMARY = [30, 58, 138];   // navy
const INK = [17, 24, 39];
const MUTED = [100, 116, 139];
const LINE = [203, 213, 225];
const SOFT = [241, 245, 249];

const money = (amount, currency) => {
  const n = Number(amount) || 0;
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return n.toFixed(2);
  }
};

const fmtDate = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const setFill = (doc, rgb) => doc.setFillColor(rgb[0], rgb[1], rgb[2]);
const setText = (doc, rgb) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
const setDraw = (doc, rgb) => doc.setDrawColor(rgb[0], rgb[1], rgb[2]);

const poFileName = (po) => `${String(po.poNumber || 'purchase-order').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;

/** Draw an image data URL inside a box, preserving aspect ratio. Never throws. */
function drawImage(doc, dataUrl, x, y, maxW, maxH) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return 0;
  try {
    let w = maxW;
    let h = maxH;
    try {
      const props = doc.getImageProperties(dataUrl);
      const ratio = props.width / props.height;
      if (maxW / maxH > ratio) w = maxH * ratio;
      else h = maxW / ratio;
    } catch {
      /* fall back to the box dimensions */
    }
    doc.addImage(dataUrl, x, y, w, h, undefined, 'FAST');
    return h;
  } catch {
    return 0;
  }
}

/* --------------------------------------------------------------- sections */

function drawLetterhead(doc, settings, y) {
  const s = settings || {};
  let textX = MARGIN;
  if (s.logoDataUrl) {
    const h = drawImage(doc, s.logoDataUrl, MARGIN, y, 30, 20);
    if (h > 0) textX = MARGIN + 34;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  setText(doc, INK);
  doc.text(s.companyName || 'Company Name', textX, y + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setText(doc, MUTED);
  const contactBits = [];
  if (s.companyEmail) contactBits.push(s.companyEmail);
  if (s.companyPhone) contactBits.push(s.companyPhone);
  const lines = [];
  if (s.companyAddress) {
    String(s.companyAddress).split('\n').forEach((l) => l.trim() && lines.push(l.trim()));
  }
  if (s.companyGst) lines.push(`GSTIN / VAT: ${s.companyGst}`);
  if (contactBits.length) lines.push(contactBits.join('   •   '));
  if (s.companyWebsite) lines.push(s.companyWebsite);

  let cy = y + 11;
  lines.slice(0, 5).forEach((line) => {
    doc.text(doc.splitTextToSize(line, 120)[0], textX, cy);
    cy += 4;
  });

  // Title on the right.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  setText(doc, PRIMARY);
  doc.text('PURCHASE ORDER', PAGE_W - MARGIN, y + 7, { align: 'right' });

  const bottom = Math.max(cy, y + 24);
  setDraw(doc, PRIMARY);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, bottom, PAGE_W - MARGIN, bottom);
  doc.setLineWidth(0.2);
  return bottom + 6;
}

/** Two side-by-side info panels: vendor (left) and order details (right). */
function drawParties(doc, po, y) {
  const gap = 6;
  const colW = (CONTENT_W - gap) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colW + gap;

  const orderRows = [
    ['PO Number', po.poNumber],
    ['PO Date', fmtDate(po.issueDate)],
    ['Quotation Ref', po.quotationRef || '—'],
    ['Currency', po.currency || 'INR'],
    ['Payment Terms', po.paymentTerms || '—'],
    ['Delivery Schedule', po.deliverySchedule || '—'],
    ['Delivery Location', po.deliveryLocation || '—'],
    ['Contact Person', po.contactPerson || '—'],
    ['Status', po.status || 'Draft']
  ];

  const vendorLines = [];
  if (po.vendorAddress) String(po.vendorAddress).split('\n').forEach((l) => l.trim() && vendorLines.push(l.trim()));
  if (po.vendorGst) vendorLines.push(`GSTIN / VAT: ${po.vendorGst}`);
  if (po.vendorContactPerson) vendorLines.push(`Attn: ${po.vendorContactPerson}`);
  const vc = [];
  if (po.vendorEmail) vc.push(po.vendorEmail);
  if (po.vendorPhone) vc.push(po.vendorPhone);
  if (vc.length) vendorLines.push(vc.join('   •   '));

  // Measure heights so both panels share the taller height.
  const headerH = 6;
  const vendorBodyH = 6 + 5 + vendorLines.length * 4 + 3;
  const orderBodyH = 4 + orderRows.length * 4.6 + 2;
  const boxH = Math.max(vendorBodyH, orderBodyH, 40);

  // Vendor panel
  setDraw(doc, LINE);
  setFill(doc, SOFT);
  doc.rect(leftX, y, colW, headerH, 'F');
  doc.rect(leftX, y, colW, boxH + headerH, 'S');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  setText(doc, PRIMARY);
  doc.text('VENDOR', leftX + 3, y + 4);

  doc.setFontSize(10.5);
  setText(doc, INK);
  doc.text(doc.splitTextToSize(po.vendor || '—', colW - 6)[0], leftX + 3, y + headerH + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setText(doc, MUTED);
  let vy = y + headerH + 10;
  vendorLines.forEach((line) => {
    doc.splitTextToSize(line, colW - 6).forEach((wrapped) => {
      doc.text(wrapped, leftX + 3, vy);
      vy += 4;
    });
  });

  // Order details panel
  setFill(doc, SOFT);
  doc.rect(rightX, y, colW, headerH, 'F');
  doc.rect(rightX, y, colW, boxH + headerH, 'S');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  setText(doc, PRIMARY);
  doc.text('ORDER DETAILS', rightX + 3, y + 4);

  let oy = y + headerH + 4;
  const labelX = rightX + 3;
  const valueX = rightX + colW - 3;
  orderRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.3);
    setText(doc, MUTED);
    doc.text(label, labelX, oy);
    doc.setFont('helvetica', 'bold');
    setText(doc, INK);
    const v = doc.splitTextToSize(String(value ?? '—'), colW - 42)[0];
    doc.text(v, valueX, oy, { align: 'right' });
    oy += 4.6;
  });

  return y + boxH + headerH + 8;
}

const ITEM_COLS = [
  { key: 'no', label: '#', w: 8, align: 'center' },
  { key: 'desc', label: 'Description', w: 64, align: 'left' },
  { key: 'hsn', label: 'HSN/SAC', w: 18, align: 'left' },
  { key: 'qty', label: 'Qty', w: 14, align: 'right' },
  { key: 'unit', label: 'Unit', w: 14, align: 'center' },
  { key: 'price', label: 'Unit Price', w: 26, align: 'right' },
  { key: 'tax', label: 'Tax %', w: 14, align: 'right' },
  { key: 'amt', label: 'Amount', w: 24, align: 'right' }
];

function colX(index) {
  let x = MARGIN;
  for (let i = 0; i < index; i++) x += ITEM_COLS[i].w;
  return x;
}

function drawItemsHeader(doc, y) {
  setFill(doc, PRIMARY);
  doc.rect(MARGIN, y, CONTENT_W, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.2);
  setText(doc, [255, 255, 255]);
  ITEM_COLS.forEach((col, i) => {
    const x = colX(i);
    const tx = col.align === 'right' ? x + col.w - 2 : col.align === 'center' ? x + col.w / 2 : x + 2;
    doc.text(col.label, tx, y + 4.6, { align: col.align === 'left' ? 'left' : col.align });
  });
  return y + 7;
}

function drawItemsTable(doc, po, items, y, newPageTop) {
  y = drawItemsHeader(doc, y);
  const currency = po.currency || 'INR';
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);

  const rows = items && items.length ? items : [];
  rows.forEach((item, idx) => {
    const descLines = doc.splitTextToSize(item.description || '', ITEM_COLS[1].w - 3);
    const rowH = Math.max(6.5, descLines.length * 4 + 2.5);

    if (y + rowH > FOOTER_Y - 6) {
      y = newPageTop();
      y = drawItemsHeader(doc, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
    }

    if (idx % 2 === 1) {
      setFill(doc, [248, 250, 252]);
      doc.rect(MARGIN, y, CONTENT_W, rowH, 'F');
    }
    setText(doc, INK);
    const cells = {
      no: String(idx + 1),
      hsn: item.hsnCode || '',
      qty: money(item.quantity, currency).replace(/\.00$/, ''),
      unit: item.unit || '',
      price: money(item.unitPrice, currency),
      tax: `${Number(item.taxPercent) || 0}`,
      amt: money(item.lineTotal, currency)
    };
    ITEM_COLS.forEach((col, i) => {
      const x = colX(i);
      if (col.key === 'desc') {
        doc.text(descLines, x + 2, y + 4);
      } else {
        const tx = col.align === 'right' ? x + col.w - 2 : col.align === 'center' ? x + col.w / 2 : x + 2;
        doc.text(cells[col.key] ?? '', tx, y + 4, { align: col.align === 'left' ? 'left' : col.align });
      }
    });
    y += rowH;
  });

  if (rows.length === 0) {
    setText(doc, MUTED);
    doc.text('No line items on this purchase order.', MARGIN + 2, y + 5);
    y += 8;
  }

  setDraw(doc, LINE);
  doc.rect(MARGIN, y - (rows.length ? 0 : 0), CONTENT_W, 0.001, 'S');
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  return y;
}

function drawTotals(doc, po, y, newPageTop) {
  const currency = po.currency || 'INR';
  const boxW = 76;
  const boxX = PAGE_W - MARGIN - boxW;
  const rows = [
    ['Subtotal', money(po.subtotal, currency)],
    ['Tax', money(po.taxTotal, currency)]
  ];
  if (Number(po.discountAmount) > 0) {
    const label = po.discountType === 'percent' ? `Discount (${Number(po.discountValue)}%)` : 'Discount';
    rows.push([label, `- ${money(po.discountAmount, currency)}`]);
  }
  const needed = rows.length * 5.5 + 9 + 16;
  if (y + needed > FOOTER_Y) y = newPageTop();

  y += 3;
  doc.setFontSize(9);
  rows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'normal');
    setText(doc, MUTED);
    doc.text(label, boxX, y);
    doc.setFont('helvetica', 'bold');
    setText(doc, INK);
    doc.text(value, PAGE_W - MARGIN, y, { align: 'right' });
    y += 5.5;
  });

  // Grand total bar.
  y += 1;
  setFill(doc, PRIMARY);
  doc.rect(boxX, y, boxW, 9, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  setText(doc, [255, 255, 255]);
  doc.text(`Grand Total (${currency})`, boxX + 2, y + 5.8);
  doc.text(money(po.grandTotal ?? po.amount, currency), PAGE_W - MARGIN, y + 5.8, { align: 'right' });
  y += 13;

  // Amount in words (full width).
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  setText(doc, INK);
  const words = `Amount in words: ${po.amountInWords || ''}`;
  doc.splitTextToSize(words, CONTENT_W).forEach((line) => {
    doc.text(line, MARGIN, y);
    y += 4.2;
  });
  return y + 4;
}

function drawTerms(doc, po, y, newPageTop) {
  const content = po.termsContent || '';
  if (!content.trim()) return y;

  if (y + 14 > FOOTER_Y) y = newPageTop();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  setText(doc, PRIMARY);
  const versionNote = po.termsVersion ? `  (v${po.termsVersion})` : '';
  doc.text(`Terms & Conditions${versionNote}`, MARGIN, y);
  y += 2;
  setDraw(doc, LINE);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  setText(doc, [55, 65, 81]);
  const paragraphs = content.split('\n');
  paragraphs.forEach((para) => {
    const wrapped = doc.splitTextToSize(para.trim() || ' ', CONTENT_W);
    wrapped.forEach((line) => {
      if (y + 4 > FOOTER_Y) {
        y = newPageTop();
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.8);
        setText(doc, [55, 65, 81]);
      }
      doc.text(line, MARGIN, y);
      y += 3.7;
    });
  });
  return y + 4;
}

function drawSignature(doc, settings, y, newPageTop) {
  const s = settings || {};
  const blockH = 34;
  if (y + blockH > FOOTER_Y) y = newPageTop();
  y = Math.max(y, FOOTER_Y - blockH - 4);

  const rightW = 70;
  const rightX = PAGE_W - MARGIN - rightW;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  setText(doc, MUTED);
  doc.text(`For ${s.companyName || 'the Company'}`, rightX, y);

  let sy = y + 4;
  if (s.signatureDataUrl) {
    const h = drawImage(doc, s.signatureDataUrl, rightX, sy, 45, 16);
    sy += (h > 0 ? h : 12) + 2;
  } else {
    sy += 14;
  }
  setDraw(doc, MUTED);
  doc.line(rightX, sy, rightX + rightW, sy);
  sy += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  setText(doc, INK);
  doc.text(s.signatureName || 'Authorised Signatory', rightX, sy);
  if (s.signatureDesignation) {
    sy += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(doc, MUTED);
    doc.text(s.signatureDesignation, rightX, sy);
  }
  sy += 4;
  doc.setFontSize(7.5);
  setText(doc, MUTED);
  doc.text('Authorised Signatory', rightX, sy);
}

function stampFooters(doc) {
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    setDraw(doc, LINE);
    doc.line(MARGIN, FOOTER_Y, PAGE_W - MARGIN, FOOTER_Y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setText(doc, MUTED);
    doc.text(
      'This is a system-generated Purchase Order and is valid without a physical signature.',
      MARGIN,
      FOOTER_Y + 4
    );
    doc.text(`Page ${p} of ${total}`, PAGE_W - MARGIN, FOOTER_Y + 4, { align: 'right' });
  }
}

/* ---------------------------------------------------------------- assembly */

export function buildPoDoc({ po, items, settings }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const lineItems = items || po.items || [];

  const newPageTop = () => {
    doc.addPage();
    return MARGIN;
  };

  let y = MARGIN;
  y = drawLetterhead(doc, settings, y);
  y = drawParties(doc, po, y);
  y = drawItemsTable(doc, po, lineItems, y, newPageTop);
  y = drawTotals(doc, po, y, newPageTop);
  if (po.notes && po.notes.trim()) {
    if (y + 12 > FOOTER_Y) y = newPageTop();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    setText(doc, PRIMARY);
    doc.text('Notes', MARGIN, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(doc, [55, 65, 81]);
    doc.splitTextToSize(po.notes.trim(), CONTENT_W).forEach((line) => {
      if (y + 4 > FOOTER_Y) y = newPageTop();
      doc.text(line, MARGIN, y);
      y += 3.8;
    });
    y += 4;
  }
  y = drawTerms(doc, po, y, newPageTop);
  drawSignature(doc, settings, y, newPageTop);
  stampFooters(doc);
  return doc;
}

/** A File suitable for api.uploadFile(), so the PDF can be stored and versioned. */
export function poPdfFile(args) {
  const doc = buildPoDoc(args);
  const blob = doc.output('blob');
  return new File([blob], poFileName(args.po), { type: 'application/pdf' });
}

export function downloadPoPdf(args) {
  buildPoDoc(args).save(poFileName(args.po));
}

export function previewPoPdf(args) {
  const url = buildPoDoc(args).output('bloburl');
  window.open(url, '_blank', 'noopener');
}

export function printPoPdf(args) {
  const doc = buildPoDoc(args);
  doc.autoPrint();
  window.open(doc.output('bloburl'), '_blank', 'noopener');
}

export { poFileName };
