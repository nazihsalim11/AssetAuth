// Shared spreadsheet service for the bulk framework: one place that parses uploads and
// writes templates, exports and validation reports. Every bulk-managed entity uses these
// helpers, so file handling is never re-implemented per module. `xlsx` is imported lazily
// (as elsewhere in the app) so it is only pulled into the bundle when a bulk action runs.

async function xlsx() {
  return import('xlsx');
}

// Parse an uploaded .xlsx/.csv File into an array of row objects keyed by column header.
// Blank cells become '' (defval) so downstream mapping sees every declared column.
export async function parseSpreadsheet(file) {
  const XLSX = await xlsx();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// Write an array of header-keyed row objects to a downloaded workbook, preserving the given
// header order (so exports and the template share one column layout).
export async function downloadSheet(filename, sheetName, headers, rows) {
  const XLSX = await xlsx();
  const aoa = [headers, ...rows.map((r) => headers.map((h) => (r[h] ?? '')))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename);
}

// A blank import template: the header row plus one illustrative sample row.
export async function downloadTemplate(entity, headers, sample) {
  await downloadSheet(`${entity}_import_template.xlsx`, `${entity} template`, headers, sample ? [sample] : []);
}

// The current records, shaped into the template columns.
export async function downloadExport(entity, headers, rows) {
  await downloadSheet(`${entity}_export.xlsx`, `${entity} export`, headers, rows);
}

// A downloadable validation report — the full row-level fault list from a validate/import
// pass, so the user can fix the source file offline instead of reading errors on screen.
export async function downloadValidationReport(entity, errors) {
  const headers = ['Row', 'Column', 'Invalid Value', 'Expected', 'Suggested Correction', 'Error'];
  const rows = errors.map((e) => ({
    'Row': e.row,
    'Column': e.column,
    'Invalid Value': e.value,
    'Expected': e.expected,
    'Suggested Correction': e.suggestion || '',
    'Error': e.error,
  }));
  await downloadSheet(`${entity}_validation_report.xlsx`, 'Validation report', headers, rows);
}
