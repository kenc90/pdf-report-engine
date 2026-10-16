/**
 * End-to-end demo: build a multi-page, Jasper-style report from the IR and write
 * a real PDF to `output/demo.pdf`. Fonts are read from the Windows font folder
 * when present; without them the standard PDF base-14 fonts still render, so the
 * demo never hard-fails on a machine with no system fonts.
 *
 * Run with: `npm run demo`
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToBuffer, readFontFiles, setImageFileReader, type FontFileEntry, type ReportDoc } from '../index.js';

const FONT_DIR = 'C:/Windows/Fonts';

const CANDIDATE_FONTS: FontFileEntry[] = [
  { family: 'Arial', path: path.join(FONT_DIR, 'arial.ttf'), weight: 400 },
  { family: 'Arial', path: path.join(FONT_DIR, 'arialbd.ttf'), weight: 700 },
  { family: 'Arial', path: path.join(FONT_DIR, 'ariali.ttf'), weight: 400, style: 'italic' },
  { family: 'Georgia', path: path.join(FONT_DIR, 'georgia.ttf'), weight: 400 },
  { family: 'Microsoft YaHei', path: path.join(FONT_DIR, 'msyh.ttc'), postscriptName: 'MicrosoftYaHei' },
];

/** Keep only fonts that actually exist on this machine. */
function availableFonts(): FontFileEntry[] {
  return CANDIDATE_FONTS.filter((f) => f.path && fs.existsSync(f.path));
}

interface SaleRow {
  region: string;
  product: string;
  qty: number;
  unit: number;
  amount: number;
}

const PRODUCTS = ['Widget', 'Gadget', 'Gizmo', 'Doohickey', 'Thingamajig', 'Sprocket'];
const REGIONS = ['North', 'South', 'East', 'West'];

/** Deterministic pseudo-data so the demo output is stable across runs. */
function makeRows(count: number): SaleRow[] {
  const rows: SaleRow[] = [];
  let seed = 42;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < count; i += 1) {
    const qty = 1 + Math.floor(rnd() * 12);
    const unit = Math.round((5 + rnd() * 95) * 100) / 100;
    const region = REGIONS[i % REGIONS.length]!;
    const product = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)]!;
    rows.push({ region, product, qty, unit, amount: Math.round(qty * unit * 100) / 100 });
  }
  // Sort by region so grouping produces contiguous bands.
  return rows.sort((a, b) => a.region.localeCompare(b.region));
}

function buildReport(rows: SaleRow[]): ReportDoc {
  return {
    info: {
      title: 'Quarterly Sales Report',
      author: 'pdf-report-engine demo',
      subject: 'A Jasper-style paginated PDF built from the IR',
    },
    page: { size: 'a4', margin: [18 * 72 / 25.4] },
    style: { fontFamily: ['Arial', 'Helvetica'], fontSize: 10, color: '#222' },
    data: { rows, generatedOn: new Date('2026-10-13T09:00:00Z') },
    variables: { grandTotal: rows.reduce((s, r) => s + r.amount, 0) },
    bands: {
      pageHeader: {
        height: 34,
        style: { fontSize: 9, color: '#666' },
        blocks: [
          {
            type: 'heading',
            level: 1,
            content: 'Quarterly Sales Report',
            fontSize: 16,
            fontWeight: 700,
            color: '#1a3d6d',
            marginBottom: 2,
          },
          {
            type: 'paragraph',
            content: [{ bind: 'generatedOn', format: 'yyyy-MM-dd HH:mm' }],
            fontSize: 8,
            color: '#999',
          },
        ],
      },
      pageFooter: {
        height: 22,
        style: { fontSize: 8, color: '#666' },
        // Running tokens: resolved against `$page` during Pass C.
        blocks: [
          {
            type: 'paragraph',
            align: 'right',
            content: ['Page ', { bind: '$page.number' }, ' of ', { bind: '$page.total' }],
          },
        ],
      },
      summary: {
        style: { fontSize: 10, fontWeight: 700 },
        // A JS-precomputed report-level variable (aggregate totals live in `$group`
        // for per-group footers; a whole-report total is easiest as a variable).
        text: [{ bind: "concat('Grand total: ', money($vars.grandTotal))" }],
      },
    },
    body: [
      {
        type: 'paragraph',
        content:
          'This report was produced entirely in JavaScript: the IR below is laid out, paginated and ' +
          'written to a vector PDF with selectable, searchable text — no browser, no screenshots. ' +
          'Column headers repeat on every page, groups carry subtotal footers, and the page footer ' +
          'shows running page numbers.',
        marginBottom: 10,
      },
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
          { key: 'qty', width: 46, align: 'right' },
          { key: 'unit', width: 70, align: 'right', style: { features: { tnum: true } } },
          { key: 'amount', width: 90, align: 'right', style: { features: { tnum: true } } },
        ],
        headerRows: [
          {
            kind: 'header',
            cells: ['Region', 'Product', 'Qty', 'Unit Price', 'Amount'].map((label) => ({
              content: label,
              style: { fontWeight: 700, color: '#fff' },
              backgroundColor: '#1a3d6d',
            })),
          },
        ],
        groups: [
          {
            by: '$row.region',
            // No explicit `header`: the band shows the group value (the region).
            headerStyle: { backgroundColor: '#dce6f2' },
            // Group footers get `$group.<key>_sum` from the layout engine.
            footer: [{ bind: "concat('Subtotal: ', money($group.amount_sum))" }],
            footerStyle: { fontWeight: 700, backgroundColor: '#f2f2f2', align: 'right' },
          },
        ],
        detail: {
          cells: [
            { bind: 'region' },
            { bind: 'product' },
            { bind: 'qty' },
            { bind: 'unit', format: '#,##0.00' },
            { bind: 'amount', format: '#,##0.00' },
          ],
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  setImageFileReader((p) => new Uint8Array(fs.readFileSync(p)));
  const fonts = availableFonts();
  const sources = fonts.length ? await readFontFiles(fonts) : [];
  const report = buildReport(makeRows(48));
  const buffer = await renderToBuffer(report, { fonts: sources, now: () => new Date('2026-10-13T09:00:00Z') });

  const outDir = path.resolve('output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'demo.pdf');
  fs.writeFileSync(outFile, buffer);

  const pages = (buffer.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
  console.log(`[demo] fonts embedded : ${sources.length ? sources.map((f) => f.family).join(', ') : '(base-14 fallback)'}`);
  console.log(`[demo] wrote ${buffer.length} bytes, ~${pages || '?'} pages -> ${outFile}`);
}

main().catch((err) => {
  console.error('[demo] failed:', err);
  process.exitCode = 1;
});
