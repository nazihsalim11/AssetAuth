import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validate, parseDate, closest } = require('./validationEngine.js');

// A representative schema exercising every field type + master/duplicate rules.
const SCHEMA = [
  { key: 'id', column: 'ID', type: 'string', required: true, unique: true, existing: 'ids' },
  { key: 'email', column: 'Email', type: 'email', required: true },
  { key: 'phone', column: 'Phone', type: 'phone' },
  { key: 'age', column: 'Age', type: 'integer', min: 0, max: 120 },
  { key: 'cost', column: 'Cost', type: 'number' },
  { key: 'start', column: 'Start', type: 'date' },
  { key: 'status', column: 'Status', enum: ['Active', 'Inactive'] },
  { key: 'department', column: 'Department', type: 'string', master: 'departments' },
];

const CONTEXT = {
  masters: { departments: new Set(['engineering', 'finance']) },
  existing: { ids: new Set(['emp-001']) },
};

test('accepts a fully valid row and normalises values', () => {
  const rows = [{ id: 'EMP-100', email: 'a@b.com', phone: '9876543210', age: '30', cost: '12.5', start: '2026-01-02', status: 'active', department: 'Engineering' }];
  const { valid, errors, summary } = validate(rows, SCHEMA, CONTEXT);
  assert.equal(errors.length, 0);
  assert.equal(summary.success, 1);
  assert.equal(valid[0].data.phone, '+919876543210'); // normalised
  assert.equal(valid[0].data.age, 30);                 // coerced to number
  assert.equal(valid[0].data.status, 'Active');        // canonical casing
});

test('flags missing required fields with column + expected', () => {
  const rows = [{ id: '', email: '', phone: '', age: '', cost: '', start: '', status: '', department: '' }];
  const { errors, summary } = validate(rows, SCHEMA, CONTEXT);
  assert.equal(summary.failed, 1);
  const cols = errors.map((e) => e.column);
  assert.ok(cols.includes('ID'));
  assert.ok(cols.includes('Email'));
  const idErr = errors.find((e) => e.column === 'ID');
  assert.match(idErr.error, /required/);
});

test('detects invalid formats: email, integer, date, enum', () => {
  const rows = [{ id: 'X1', email: 'not-an-email', age: 'abc', start: 'never', status: 'Archived', department: 'Engineering' }];
  const { errors } = validate(rows, SCHEMA, CONTEXT);
  assert.ok(errors.find((e) => e.column === 'Email' && /valid email/.test(e.error)));
  assert.ok(errors.find((e) => e.column === 'Age' && /whole number/.test(e.error)));
  assert.ok(errors.find((e) => e.column === 'Start' && /valid date/.test(e.error)));
  const statusErr = errors.find((e) => e.column === 'Status');
  assert.match(statusErr.error, /not a valid Status/);
});

test('enum suggests the closest valid value', () => {
  const rows = [{ id: 'X1', email: 'a@b.com', status: 'Activ', department: 'Engineering' }];
  const { errors } = validate(rows, SCHEMA, CONTEXT);
  const statusErr = errors.find((e) => e.column === 'Status');
  assert.equal(statusErr.suggestion, 'Active');
});

test('enforces numeric bounds', () => {
  const rows = [{ id: 'X1', email: 'a@b.com', age: '200', department: 'Finance' }];
  const { errors } = validate(rows, SCHEMA, CONTEXT);
  assert.ok(errors.find((e) => e.column === 'Age' && /at most 120/.test(e.error)));
});

test('validates master-data references and suggests a near match', () => {
  const rows = [{ id: 'X1', email: 'a@b.com', department: 'Engineerng' }];
  const { errors } = validate(rows, SCHEMA, CONTEXT);
  const deptErr = errors.find((e) => e.column === 'Department');
  assert.match(deptErr.error, /not in the department master/);
  assert.equal(deptErr.suggestion, 'engineering');
});

test('does not enforce an empty master (new system)', () => {
  const rows = [{ id: 'X1', email: 'a@b.com', department: 'Anything' }];
  const { errors } = validate(rows, SCHEMA, { existing: { ids: new Set() }, masters: { departments: new Set() } });
  assert.equal(errors.filter((e) => e.column === 'Department').length, 0);
});

test('detects in-batch duplicates and existing-record duplicates separately', () => {
  const rows = [
    { id: 'EMP-001', email: 'a@b.com', department: 'Finance' }, // collides with existing
    { id: 'DUP', email: 'b@b.com', department: 'Finance' },
    { id: 'DUP', email: 'c@b.com', department: 'Finance' },     // collides in-batch
  ];
  const { errors, summary } = validate(rows, SCHEMA, CONTEXT);
  assert.equal(summary.duplicate, 2);
  assert.equal(summary.success, 1);
  assert.ok(errors.find((e) => /already exists/.test(e.error)));
  assert.ok(errors.find((e) => /Duplicate ID/.test(e.error)));
});

test('continues validating all rows rather than stopping at the first error', () => {
  const rows = [
    { id: '', email: 'a@b.com' },
    { id: 'OK', email: 'bad' },
    { id: 'OK2', email: 'c@b.com', department: 'Finance' },
  ];
  const { valid, summary } = validate(rows, SCHEMA, CONTEXT);
  assert.equal(summary.total, 3);
  assert.equal(summary.success, 1);
  assert.equal(valid[0].row, 3);
});

test('applies defaults to blank optional fields', () => {
  const schema = [{ key: 'status', column: 'Status', enum: ['Active', 'Inactive'], default: 'Active' }];
  const { valid } = validate([{ status: '' }], schema, {});
  assert.equal(valid[0].data.status, 'Active');
});

test('row-level cross-field rule', () => {
  const schema = [
    { key: 'start', column: 'Start', type: 'date' },
    { key: 'end', column: 'End', type: 'date' },
  ];
  const ctx = { rowRule: (data) => (data.start && data.end && data.end < data.start ? 'End date must be after start date.' : null) };
  const { errors } = validate([{ start: '2026-02-01', end: '2026-01-01' }], schema, ctx);
  assert.match(errors[0].error, /after start date/);
});

test('parseDate handles ISO, slashes and Excel serials', () => {
  assert.equal(parseDate('2026-03-04').iso, '2026-03-04');
  assert.equal(parseDate('03/04/2026').ok, true);
  assert.equal(parseDate(45000).iso, parseDate('45000').iso);
  assert.equal(parseDate('rubbish').ok, false);
});

test('closest returns null when nothing is near', () => {
  assert.equal(closest('zzzzz', ['engineering', 'finance']), null);
  assert.equal(closest('financ', ['engineering', 'finance']), 'finance');
});
