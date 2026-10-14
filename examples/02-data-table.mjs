/**
 * Example 02 — a real report: data-driven table with row grouping, per-group
 * subtotals, a whole-report grand total, and running page numbers.
 *
 *   node examples/02-data-table.mjs
 *
 * This is the JS-library equivalent of the HTML samples: you feed a plain array
 * into `dataSource`, and the engine expands `detail` once per row, repeats the
 * column header across pages, and resolves `{PAGE}`/`{TOTAL}` tokens per page.
 */
import fs from 'node:fs';
import { renderToBuffer } from 'pdf-report-engine';

const rows = [
  { region: 'North', product: 'Widget', qty: 12, amount: 2400 },
  { region: 'North', product: 'Gadget', qty: 5, amount: 750 },
  { region: 'North', product: 'Sprocket', qty: 20, amount: 600 },
  { region: 'South', product: 'Widget', qty: 9, amount: 1800 },
  { region: 'South', product: 'Gizmo', qty: 3, amount: 990 },
  { region: 'East', product: 'Gadget', qty: 7, amount: 1050 },
  { region: 'East', product: 'Doohickey', qty: 15, amount: 450 },
  { region: 'East', product: 'Widget', qty: 4, amount: 800 },
  { region: 'West', product: 'Gizmo', qty: 6, amount: 1980 },
  { region: 'West', product: 'Sprocket', qty: 30, amount: 900 },
];

const report = {
  info: { title: 'Sales by Region' },
  page: { size: 'a4', margin: 48 },
  style: { fontFamily: 'Helvetica', fontSize: 10, color: '#222' },
  data: { rows },
  variables: { grandTotal: rows.reduce((s, r) => s + r.amount, 0) },
  bands: {
    // A repeated page footer carrying running tokens (only resolved inside bands).
    pageFooter: {
      height: 20,
      style: { fontSize: 8, color: '#666' },
      blocks: [
        {
          type: 'paragraph',
          align: 'right',
          content: ['Page ', { bind: '$page.number' }, ' of ', { bind: '$page.total' }],
        },
      ],
    },
    // A once-at-the-end summary band. Aggregate totals are simplest as a variable.
    summary: {
      style: { fontSize: 11, fontWeight: 'bold' },
      text: [{ bind: "concat('Grand total: ', money($vars.grandTotal))" }],
    },
  },
  body: [
    { type: 'heading', level: 1, content: 'Sales by Region', fontSize: 16, color: '#1a3d6d', marginBottom: 8 },
    {
      type: 'table',
      id: 'sales',
      showGrid: true,
      striped: true,
      repeatHeader: true,
      dataSource: { bind: '$data.rows' },
      columns: [
        { key: 'region', grow: 1 },
        { key: 'product', grow: 2 },
        { key: 'qty', width: 50, align: 'right' },
        { key: 'amount', width: 110, align: 'right' },
      ],
      headerRows: [
        {
          kind: 'header',
          cells: ['Region', 'Product', 'Qty', 'Amount'].map((label, i) => ({
            content: label,
            align: i >= 2 ? 'right' : 'left',
            style: { fontWeight: 'bold', color: '#fff' },
            backgroundColor: '#1a3d6d',
          })),
        },
      ],
      groups: [
        {
          by: '$row.region', // a new group starts whenever the region changes
          headerStyle: { backgroundColor: '#dce6f2', fontWeight: 'bold' },
          footer: [{ bind: "concat('Subtotal — ', money($group.amount_sum))" }],
          footerStyle: { fontWeight: 'bold', align: 'right', backgroundColor: '#f2f2f2' },
        },
      ],
      detail: {
        cells: [
          { bind: 'region' },
          { bind: 'product' },
          { bind: 'qty' },
          { bind: 'amount', format: '#,##0.00' },
        ],
      },
    },
  ],
};

const pdf = await renderToBuffer(report, { now: () => new Date('2026-01-01T00:00:00Z') });
fs.mkdirSync('output/examples', { recursive: true });
fs.writeFileSync('output/examples/02-data-table.pdf', pdf);
console.log(`wrote output/examples/02-data-table.pdf (${pdf.length} bytes)`);
