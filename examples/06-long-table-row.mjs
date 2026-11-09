/**
 * Example 06 — a single oversized text row that continues across pages.
 *
 *   node examples/06-long-table-row.mjs
 */
import fs from 'node:fs';
import { createReport } from 'pdf-report-engine';

const notes = Array.from({ length: 72 }, (_, i) =>
  `Checkpoint ${i + 1}: supporting documents were reviewed against the original request, source records, and approved policy. The reviewer recorded the evidence, any discrepancy, its owner, and the next action before closing the item.`,
).join(' ');

const report = {
  info: { title: 'Long table row pagination' },
  page: { size: 'a4', margin: 52 },
  style: { fontFamily: 'Helvetica', fontSize: 10, color: '#24303f' },
  bands: {
    pageFooter: {
      height: 20,
      style: { fontSize: 8, color: '#64748b' },
      blocks: [{
        type: 'paragraph',
        align: 'right',
        content: ['Page ', { bind: '$page.number' }, ' of ', { bind: '$page.total' }],
      }],
    },
  },
  body: [
    { type: 'heading', level: 1, content: 'Long table row', color: '#0f2f57', marginBottom: 4 },
    {
      type: 'paragraph',
      content: 'This report has one unusually long, text-only table row. It continues at safe line boundaries, and the table header repeats on each page.',
      marginBottom: 10,
    },
    {
      type: 'table',
      id: 'review-notes',
      columns: [{ grow: 1 }, { width: 92 }],
      headerRows: [{
        kind: 'header',
        cells: [
          { content: 'Review notes', backgroundColor: '#0f2f57', style: { color: '#ffffff', fontWeight: 'bold' }, paddingTop: 6, paddingBottom: 6 },
          { content: 'Reference', backgroundColor: '#0f2f57', style: { color: '#ffffff', fontWeight: 'bold' }, paddingTop: 6, paddingBottom: 6 },
        ],
      }],
      staticRows: [{
        cells: [
          { content: notes, paddingTop: 5, paddingBottom: 5 },
          { content: 'CASE-2026-041', paddingTop: 5, paddingBottom: 5 },
        ],
      }],
      showGrid: true,
    },
  ],
};

const { doc, pages } = createReport(report);
console.log(`paginated into ${pages.length} page(s)`);

fs.mkdirSync('output/examples', { recursive: true });
const out = fs.createWriteStream('output/examples/06-long-table-row.pdf');
doc.pipe(out);
doc.end();
await new Promise((resolve, reject) => {
  out.on('finish', resolve);
  out.on('error', reject);
});
console.log('wrote output/examples/06-long-table-row.pdf');
