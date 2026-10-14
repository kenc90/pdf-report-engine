/**
 * End-to-end integration test for the full pipeline (IR -> layout -> pagination
 * -> pdfkit writer). Two things are verified:
 *
 *  1. Behaviour of the paginated model: a body long enough to spill across pages
 *     really paginates, and running tokens (`{PAGE}` / `{TOTAL}` via `$page`)
 *     resolve to distinct per-page values in the footer band.
 *  2. The bytes are a real, vector PDF with *selectable/searchable* text: when a
 *     TrueType font is embedded, pdfkit emits a `/Type0` composite font with a
 *     `/CIDFontType2` descendant and a `/ToUnicode` CMap — the exact structures a
 *     viewer/extractor needs to map glyphs back to characters.
 *
 * The font-dependent assertions self-skip on machines without the reference
 * font, so the model-level checks always run.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createReport, renderToBuffer, readFontFiles, type ReportDoc, type FontSource } from '../src/index.js';

const ARIAL = 'C:/Windows/Fonts/arial.ttf';
const hasArial = fs.existsSync(ARIAL);

/** A report with enough detail rows to force several pages, plus running tokens. */
function multiPageReport(rows: number): ReportDoc {
  return {
    page: { size: 'a4', margin: 51 },
    data: { rows: Array.from({ length: rows }, (_, i) => ({ n: i + 1, label: `Row ${i + 1}` })) },
    bands: {
      pageHeader: { height: 20, text: 'Header' },
      pageFooter: {
        height: 18,
        // Running tokens: Page N of TOTAL, resolved against `$page` per page.
        text: ['Page ', { bind: '$page.number' }, ' of ', { bind: '$page.total' }],
      },
    },
    body: [
      {
        type: 'table',
        id: 'rows',
        dataSource: { bind: '$data.rows' },
        columns: [{ key: 'n', width: 60, align: 'right' }, { key: 'label', grow: 1 }],
        headerRows: [{ cells: [{ content: '#', style: { fontWeight: 700 } }, { content: 'Label', style: { fontWeight: 700 } }] }],
        repeatHeader: true,
        showGrid: true,
        detail: { cells: [{ bind: 'n' }, { bind: 'label' }] },
      },
    ],
  };
}

function footerText(page: ReturnType<typeof createReport>['pages'][number]): string {
  let out = '';
  for (const placed of page.footer) {
    for (const cmd of placed.fragment.commands) {
      if (cmd.op === 'text') out += cmd.runs.map((r) => r.text).join('');
    }
  }
  return out;
}

describe('pagination + running tokens', () => {
  it('splits a long table across multiple pages', () => {
    const { pages } = createReport(multiPageReport(80), {});
    expect(pages.length).toBeGreaterThan(1);
  });

  it('keeps every body fragment inside its page box', () => {
    const { pages } = createReport(multiPageReport(80), {});
    const pageHeight = pages[0]!.height;
    for (const p of pages) {
      for (const placed of p.body) {
        expect(placed.y).toBeGreaterThanOrEqual(0);
        expect(placed.y + placed.fragment.height).toBeLessThanOrEqual(pageHeight + 0.5);
      }
    }
  });

  it('renders distinct page numbers and a shared total in the footer', () => {
    const { pages } = createReport(multiPageReport(80), {});
    const total = pages.length;
    expect(total).toBeGreaterThan(1);
    pages.forEach((p, i) => {
      const text = footerText(p);
      expect(text).toContain('Page');
      expect(text).toContain('of');
      expect(text).toContain(String(i + 1)); // this page's logical number
      expect(text).toContain(String(total)); // {TOTAL}
    });
  });
});

describe(hasArial ? 'selectable-text PDF (real font)' : 'selectable-text PDF (SKIPPED: no arial.ttf)', () => {
  const maybe = hasArial ? it : it.skip;

  maybe('embeds a Type0 / CIDFontType2 font with a ToUnicode CMap', async () => {
    const fonts: FontSource[] = await readFontFiles([{ family: 'Arial', path: ARIAL, weight: 400 }]);
    const report = multiPageReport(6);
    report.style = { fontFamily: 'Arial' };
    const buffer = await renderToBuffer(report, { fonts });
    const latin = buffer.toString('latin1');

    expect(latin.startsWith('%PDF-')).toBe(true);
    expect(latin).toContain('/Type0'); // composite font
    expect(latin).toContain('/CIDFontType2'); // TrueType descendant
    expect(latin).toContain('/ToUnicode'); // glyph->unicode map = selectable/searchable
    expect(latin).toContain('%%EOF');
  });
});
