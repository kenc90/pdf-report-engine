/**
 * Example 03 — feed the engine HTML instead of hand-written IR.
 *
 *   node examples/03-from-html.mjs
 *
 * `htmlToReportDoc(html, options)` parses a forgiving HTML/CSS subset into the
 * same ReportDoc the layout engine consumes, so a JS caller can author reports
 * with markup (or accept it from elsewhere) and still get vector, searchable,
 * paginated PDFs. Pass `{ baseDir }` so relative `<img src>` paths resolve.
 */
import fs from 'node:fs';
import { renderToBuffer, htmlToReportDoc } from 'pdf-report-engine';

const html = `<!doctype html>
<html>
  <head><style>
    body { font-family: Helvetica; font-size: 11pt; color: #222; }
    h1 { color: #1a3d6d; }
    table { border-collapse: collapse; }
    th { background: #1a3d6d; color: #fff; }
    td, th { border: 1px solid #ccd6e0; padding: 3pt 6pt; }
  </style></head>
  <body>
    <h1>Invoice #A-1001</h1>
    <p>Rendered from <b>HTML</b> through the built-in adapter — note the styled table.</p>
    <table>
      <tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th></tr>
      <tr><td>Widget</td><td style="text-align:right">2</td><td style="text-align:right">$19.00</td></tr>
      <tr><td>Gadget</td><td style="text-align:right">1</td><td style="text-align:right">$42.50</td></tr>
      <tr><td><b>Total</b></td><td></td><td style="text-align:right"><b>$80.50</b></td></tr>
    </table>
  </body>
</html>`;

const report = htmlToReportDoc(html, { style: { fontFamily: 'Helvetica', fontSize: 11 } });
const pdf = await renderToBuffer(report);
fs.mkdirSync('output/examples', { recursive: true });
fs.writeFileSync('output/examples/03-from-html.pdf', pdf);
console.log(`wrote output/examples/03-from-html.pdf (${pdf.length} bytes)`);
