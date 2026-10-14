/**
 * Example 01 — the smallest possible report, built from the JS IR.
 *
 * Run it (build the package once first so `pdf-report-engine` resolves):
 *   npm run build
 *   node examples/01-basic.mjs
 *
 * No fonts are registered, so the standard PDF base-14 fonts (Helvetica here)
 * render out of the box — the report never needs anything installed.
 */
import fs from 'node:fs';
import { renderToBuffer } from 'pdf-report-engine';

const report = {
  info: { title: 'Hello, PDF' },
  page: { size: 'a4', margin: 56 },
  style: { fontFamily: 'Helvetica', fontSize: 11, color: '#222' },
  body: [
    { type: 'heading', level: 1, content: 'Quarterly Snapshot', fontSize: 20, color: '#1a3d6d', marginBottom: 6 },
    {
      type: 'paragraph',
      content: 'Built entirely in JavaScript from the report IR — no HTML, no browser, no screenshots.',
      marginBottom: 12,
    },
    {
      type: 'table',
      showGrid: true,
      striped: true,
      columns: [
        { key: 'label', grow: 2 },
        { key: 'value', width: 120, align: 'right' },
      ],
      headerRows: [
        {
          kind: 'header',
          cells: [
            { content: 'Metric', style: { fontWeight: 'bold', color: '#fff' }, backgroundColor: '#1a3d6d' },
            { content: 'Value', align: 'right', style: { fontWeight: 'bold', color: '#fff' }, backgroundColor: '#1a3d6d' },
          ],
        },
      ],
      // `staticRows` are literal rows with their own cell styling — no dataSource needed.
      staticRows: [
        { cells: [{ content: 'Revenue' }, { content: '$1,240,000' }] },
        { cells: [{ content: 'Units shipped' }, { content: '18,402' }] },
        { cells: [{ content: 'Return rate' }, { content: '0.9%' }] },
      ],
    },
  ],
};

const pdf = await renderToBuffer(report);
fs.mkdirSync('output/examples', { recursive: true });
fs.writeFileSync('output/examples/01-basic.pdf', pdf);
console.log(`wrote output/examples/01-basic.pdf (${pdf.length} bytes)`);
