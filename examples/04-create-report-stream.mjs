/**
 * Example 04 — the lower-level `createReport` API: get the live pdfkit doc and
 * the paginated model, then stream the bytes yourself.
 *
 *   node examples/04-create-report-stream.mjs
 *
 * Use `createReport` (synchronous, offline) when you want to pipe the PDF to a
 * response/HDD incrementally, or inspect how the content paginated. Reach for
 * `renderToBuffer` instead when you just want a Buffer.
 */
import fs from 'node:fs';
import { createReport } from 'pdf-report-engine';

const report = {
  info: { title: 'Streaming + page model' },
  page: { size: 'a4', margin: 56 },
  style: { fontFamily: 'Helvetica', fontSize: 11 },
  body: [
    { type: 'heading', level: 1, content: 'Live document', fontSize: 18, color: '#1a3d6d' },
    {
      type: 'paragraph',
      content:
        'createReport returns the pdfkit doc plus the paginated pages array. Pipe the doc ' +
        'to any writable stream, or read pages.length to see how the report flowed.',
      marginBottom: 10,
    },
    // A long body so the report actually spans more than one page.
    ...Array.from({ length: 40 }, (_, i) => ({
      type: 'paragraph',
      content: `Line ${i + 1}: body content that flows down the page and onto the next one.`,
    })),
  ],
};

const { doc, pages } = createReport(report);
console.log(`paginated into ${pages.length} page(s)`);

fs.mkdirSync('output/examples', { recursive: true });
const out = fs.createWriteStream('output/examples/04-create-report-stream.pdf');
doc.pipe(out);
doc.end();
await new Promise((resolve, reject) => {
  out.on('finish', resolve);
  out.on('error', reject);
});
console.log('wrote output/examples/04-create-report-stream.pdf');
