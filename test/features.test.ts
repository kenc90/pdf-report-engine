/**
 * Tests for the newer report features: QR / Code 128 / EAN-13, vector charts,
 * the stylesheet cascade, hyperlinks, TOC generation and PDF bookmarks.
 *
 * Layout is driven through `HeuristicFontHandle` so measurements are exact and
 * reproducible without font files; the HTML-side checks exercise the adapter.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import { encodeQR } from '../src/barcode/qr.js';
import { encodeCode128 } from '../src/barcode/code128.js';
import { encodeEan13, normalizeEan13 } from '../src/barcode/ean13.js';
import { formatNumber } from '../src/expr/format.js';
import { htmlToReportDoc } from '../src/adapter/html.js';
import { createReport, renderToBuffer } from '../src/index.js';
import type {
  BarcodeBlock,
  ChartBlock,
  ContentSpan,
  HeadingBlock,
  ParagraphBlock,
  ReportDoc,
  TocBlock,
} from '../src/ir/schema.js';
import type { Fragment } from '../src/layout/flow.js';

function makeCtx(): LayoutContext {
  const registry = new FontRegistry();
  registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
  const baseStyle = resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined);
  return new LayoutContext({ registry, baseStyle });
}

const opts = (contentWidth: number) => ({ contentWidth, scope: {} });

function fragmentText(f: Fragment): string {
  const parts: string[] = [];
  for (const c of f.commands) if (c.op === 'text') parts.push(c.runs.map((r) => r.text).join(''));
  return parts.join('');
}

/** Shoelace area; its sign is the polygon's winding direction. */
function signedArea(points: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function pageText(page: ReturnType<typeof createReport>['pages'][number]): string {
  return page.body.map((pf) => fragmentText(pf.fragment)).join('');
}

// --- barcode encoders ------------------------------------------------------

describe('barcode encoders', () => {
  it('builds a QR symbol with finder, timing and alignment structure', () => {
    const qr = encodeQR('HELLO WORLD');
    expect(qr.size).toBe(21 + 4 * (qr.version - 1));
    expect(qr.modules).toHaveLength(qr.size);
    expect(qr.modules[0]).toHaveLength(qr.size);

    // Three 7x7 finder patterns (dark border, light ring, dark core).
    for (const [r, c] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]] as const) {
      expect(qr.modules[r]![c]).toBe(true);
      expect(qr.modules[r + 1]![c + 1]).toBe(false);
      expect(qr.modules[r + 3]![c + 3]).toBe(true);
      expect(qr.modules[r + 6]![c + 6]).toBe(true);
    }
    // Horizontal timing pattern alternates between the finders.
    for (let x = 8; x < qr.size - 8; x += 1) expect(qr.modules[6]![x]).toBe(x % 2 === 0);
  });

  it('honours every error-correction level and rejects oversized input', () => {
    for (const ec of ['L', 'M', 'Q', 'H'] as const) {
      const qr = encodeQR('https://example.com/report/2026-Q3', ec);
      expect(qr.size % 4).toBe(1);
      expect(qr.modules.flat().some(Boolean)).toBe(true);
    }
    expect(() => encodeQR('x'.repeat(3000), 'H')).toThrow();
  });

  it('encodes Code 128 subset B with a modulo-103 checksum and stop symbol', () => {
    const bits = encodeCode128('ABC');
    expect(bits).toMatch(/^[01]+$/);
    expect(bits.startsWith('11010010000')).toBe(true); // START B
    expect(bits.endsWith('1100011101011')).toBe(true); // STOP
    // start + 3 data symbols + checksum, then the 13-module stop.
    expect(bits).toHaveLength(11 * 5 + 13);
    // checksum = (104 + 33*1 + 34*2 + 35*3) mod 103 = 1
    expect(bits.slice(44, 55)).toBe('11001101100');
  });

  it('computes and validates EAN-13 check digits', () => {
    expect(normalizeEan13('590123412345')).toBe('5901234123457');
    const bits = encodeEan13('5901234123457');
    expect(bits).toHaveLength(95);
    expect(bits.slice(0, 3)).toBe('101');
    expect(bits.slice(45, 50)).toBe('01010'); // centre guard
    expect(bits.slice(92)).toBe('101');
    expect(() => normalizeEan13('5901234123450')).toThrow(/checksum/);
    expect(() => normalizeEan13('123')).toThrow();
  });
});

describe('barcode layout', () => {
  it('paints QR modules as merged vector rectangles and adds no caption', () => {
    const block: BarcodeBlock = { type: 'barcode', symbology: 'qr', value: 'HELLO', moduleSize: 2 };
    const frags = layoutBlock(block, makeCtx(), opts(300));
    expect(frags).toHaveLength(1);
    expect(frags[0]!.avoidSplit).toBe(true);
    const rects = frags[0]!.commands.filter((c) => c.op === 'fillRect');
    expect(rects.length).toBeGreaterThan(20);
    expect(fragmentText(frags[0]!)).toBe('');
  });

  it('draws a 1D code with a human-readable value', () => {
    const block: BarcodeBlock = { type: 'barcode', symbology: 'code128', value: 'RPT-2026-Q3-0042' };
    const f = layoutBlock(block, makeCtx(), opts(300))[0]!;
    expect(f.avoidSplit).toBe(true);
    expect(f.height).toBeGreaterThan(46);
    expect(fragmentText(f)).toContain('RPT-2026-Q3-0042');
  });

  it('reports the symbology when the value is invalid', () => {
    const block: BarcodeBlock = { type: 'barcode', symbology: 'ean13', value: '5901234123450' };
    expect(() => layoutBlock(block, makeCtx(), opts(300))).toThrow(/barcode \(ean13\)/);
  });
});

// --- charts ----------------------------------------------------------------

describe('chart layout', () => {
  const chart = (kind: ChartBlock['kind'], extra: Partial<ChartBlock> = {}): ChartBlock => ({
    type: 'chart',
    kind,
    title: 'Quarterly revenue',
    categories: ['Q1', 'Q2', 'Q3'],
    series: [
      { name: 'Actual', values: [12, 18, 15] },
      { name: 'Plan', values: [10, 14, 16] },
    ],
    height: 140,
    ...extra,
  });

  it('renders bars as rectangles plus axis, category and legend text', () => {
    const f = layoutBlock(chart('bar'), makeCtx(), opts(320))[0]!;
    expect(f.avoidSplit).toBe(true);
    const rects = f.commands.filter((c) => c.op === 'fillRect');
    expect(rects.length).toBeGreaterThanOrEqual(6); // two series x three categories
    const text = fragmentText(f);
    expect(text).toContain('Quarterly revenue');
    for (const label of ['Q1', 'Q2', 'Q3', 'Actual', 'Plan']) expect(text).toContain(label);
  });

  it('renders line and area series as polylines', () => {
    const line = layoutBlock(chart('line'), makeCtx(), opts(320))[0]!;
    expect(line.commands.some((c) => c.op === 'line')).toBe(true);
    const area = layoutBlock(chart('area', { stacked: true }), makeCtx(), opts(320))[0]!;
    expect(area.commands.some((c) => c.op === 'poly')).toBe(true);
  });

  it('samples pie and donut slices as polygons', () => {
    const pie = layoutBlock(
      chart('pie', { series: [{ name: 'Share', values: [50, 30, 20] }], legend: 'right' }),
      makeCtx(),
      opts(320),
    )[0]!;
    const slices = pie.commands.filter((c) => c.op === 'poly');
    expect(slices.length).toBeGreaterThanOrEqual(3);
    expect(fragmentText(pie)).toContain('50%');

    const donut = layoutBlock(
      chart('donut', { series: [{ name: 'Share', values: [50, 30, 20] }], innerRadius: 0.5 }),
      makeCtx(),
      opts(320),
    )[0]!;
    expect(donut.commands.filter((c) => c.op === 'poly').length).toBeGreaterThanOrEqual(3);
  });

  it('winds donut holes opposite to the outer ring so the hole punches out', () => {
    const f = layoutBlock(
      chart('donut', {
        series: [{ name: 'Share', values: [50, 30, 20] }],
        innerRadius: 0.5,
        legend: 'none',
      }),
      makeCtx(),
      opts(320),
    )[0]!;
    const slice = f.commands.find((c) => c.op === 'poly');
    if (!slice || slice.op !== 'poly') throw new Error('donut slice polygon missing');
    const pts = slice.points;
    const half = pts.length / 2;
    expect(pts.length % 2).toBe(0);
    // First half walks the outer arc, second half the inner arc. Equal winding
    // would fill the hole instead of cancelling it under the nonzero rule.
    const outer = signedArea(pts.slice(0, half));
    const hole = signedArea(pts.slice(half));
    expect(Math.sign(outer)).toBe(-Math.sign(hole));
  });

  it('keeps a bottom legend inside the fragment so it cannot collide with the next block', () => {
    const f = layoutBlock(chart('bar', { legend: 'bottom' }), makeCtx(), opts(320))[0]!;
    const baselines: number[] = [];
    for (const c of f.commands) if (c.op === 'text') baselines.push(c.baselineY);
    expect(baselines.length).toBeGreaterThan(0);
    expect(Math.max(...baselines)).toBeLessThanOrEqual(f.height);
  });

  it('formats tick labels with the value-axis pattern', () => {
    const f = layoutBlock(
      chart('bar', { valueAxis: { format: '#,##0', ticks: 4 }, showValues: true }),
      makeCtx(),
      opts(320),
    )[0]!;
    const text = fragmentText(f);
    // Domain is 0..20; no data value equals 20, so this proves the axis ticks.
    expect(text).toContain('20');
    expect(text).toContain('12');
  });
});

// --- stylesheet cascade ----------------------------------------------------

describe('html stylesheet cascade', () => {
  it('applies tag, class and id selectors with specificity', () => {
    const doc = htmlToReportDoc(`
      <style>
        p { color: #111111; }
        .a { color: #222222; }
        p.a { color: #333333; }
        #x { color: #444444; }
      </style>
      <p id="x" class="a">text</p>`);
    expect((doc.body![0] as ParagraphBlock).color).toBe('#444444');
  });

  it('lets inline style beat every selector', () => {
    const doc = htmlToReportDoc(
      '<style>#x { color: #444444; }</style><p id="x" style="color:#555555">text</p>',
    );
    expect((doc.body![0] as ParagraphBlock).color).toBe('#555555');
  });

  it('supports descendant and child combinators', () => {
    const doc = htmlToReportDoc(`
      <style>
        section p { background-color: #010203; }
        section > p { color: #0a0b0c; }
        @media print { p { color: #ff0000; } }
      </style>
      <section><div><p>deep</p></div><p>direct</p></section>`);
    const [deep, direct] = doc.body as ParagraphBlock[];
    expect(deep!.backgroundColor).toBe('#010203');
    expect(deep!.color).toBeUndefined();
    expect(direct!.color).toBe('#0a0b0c');
  });

  it('lets the programmatic class map override the stylesheet', () => {
    const doc = htmlToReportDoc('<style>.a { color: #111111; }</style><p class="a">x</p>', {
      styles: { a: { color: '#999999' } },
    });
    expect((doc.body![0] as ParagraphBlock).color).toBe('#999999');
  });
});

// --- declarative HTML blocks ----------------------------------------------

describe('declarative HTML blocks', () => {
  it('maps a data-chart div, including title, series and options', () => {
    const doc = htmlToReportDoc(
      '<div id="c" data-chart="bar" data-title="Revenue" data-categories="Q1,Q2" ' +
        'data-series="Actual:1,2;Plan:3,4" data-legend="bottom" data-stacked ' +
        'data-colors="#111111,#222222" style="height:120pt"></div>',
    );
    const chart = doc.body![0] as ChartBlock;
    expect(chart.type).toBe('chart');
    expect(chart.id).toBe('c');
    expect(chart.kind).toBe('bar');
    expect(chart.title).toBe('Revenue');
    expect(chart.series.map((s) => s.name)).toEqual(['Actual', 'Plan']);
    expect(chart.series[0]!.values).toBe('1,2');
    expect(chart.stacked).toBe(true);
    expect(chart.legend).toBe('bottom');
    expect(chart.colors).toEqual(['#111111', '#222222']);
    expect(String(chart.height)).toBe('120pt');
  });

  it('maps a table to a chart, using the header and first column', () => {
    const doc = htmlToReportDoc(`
      <table data-chart="line" data-title="Trend">
        <thead><tr><th>Month</th><th>Actual</th><th>Plan</th></tr></thead>
        <tbody>
          <tr><td>Jan</td><td>10</td><td>12</td></tr>
          <tr><td>Feb</td><td>14</td><td>13</td></tr>
        </tbody>
      </table>`);
    const chart = doc.body![0] as ChartBlock;
    expect(chart.type).toBe('chart');
    expect(chart.kind).toBe('line');
    expect(chart.title).toBe('Trend');
    expect(chart.categories).toEqual(['Jan', 'Feb']);
    expect(chart.series[0]).toMatchObject({ name: 'Actual', values: [10, 14] });
    expect(chart.series[1]).toMatchObject({ name: 'Plan', values: [12, 13] });
  });

  it('maps a data-toc element to a TOC block', () => {
    const doc = htmlToReportDoc(
      '<div data-toc data-title="Contents" data-level="2" data-leaders="false" ' +
        'data-page-numbers="false" data-indent="8" data-gap="6"></div>',
    );
    const toc = doc.body![0] as TocBlock;
    expect(toc.type).toBe('toc');
    expect(toc.title).toBe('Contents');
    expect(toc.maxLevel).toBe(2);
    expect(toc.leaders).toBe(false);
    expect(toc.pageNumbers).toBe(false);
    expect(toc.indent).toBe(8);
    expect(toc.gap).toBe(6);
  });

  it('maps data-barcode attributes and bindings', () => {
    const doc = htmlToReportDoc(
      '<div data-barcode="ean13" data-value="590123412345" data-color="#123456" ' +
        'data-show-text="false" data-quiet-zone="2"></div>' +
        '<div data-barcode="qr" data-bind="payload" data-error-correction="H" data-module-size="2"></div>',
    );
    const [ean, qr] = doc.body as BarcodeBlock[];
    expect(ean!.symbology).toBe('ean13');
    expect(ean!.value).toBe('590123412345');
    expect(ean!.color).toBe('#123456');
    expect(ean!.showText).toBe(false);
    expect(ean!.quietZone).toBe(2);
    expect(qr!.symbology).toBe('qr');
    expect((qr!.value as ContentSpan[])[0]!.bind).toBe('payload');
    expect(qr!.errorCorrection).toBe('H');
    expect(qr!.moduleSize).toBe(2);
  });
});

// --- links, marks, bands ---------------------------------------------------

describe('inline links, highlights and background bands', () => {
  it('maps <a href> to run links and <mark> to a highlight fill', () => {
    const doc = htmlToReportDoc(
      '<p>See <a href="https://example.com">the site</a> and <mark>this</mark>.</p>' +
        '<h2 id="sec">Section</h2>',
    );
    const p = doc.body![0] as ParagraphBlock;
    const spans = (p.content as ContentSpan[]).filter((c) => typeof c === 'object');
    const link = spans.find((s) => s.link !== undefined)!;
    expect(link.link).toBe('https://example.com');
    expect(link.style?.textDecoration).toContain('underline');
    const mark = spans.find((s) => s.style?.backgroundColor !== undefined)!;
    expect(mark.style!.backgroundColor).toBe('#fff2a8');
    expect((doc.body![1] as HeadingBlock).id).toBe('sec');
  });

  it('renders a translucent background band', () => {
    const doc = htmlToReportDoc(
      '<div data-band="background" style="opacity:0.06; font-size:60pt; color:#000">DRAFT</div><p>x</p>',
    );
    expect((doc.bands!.background!.style as { opacity?: number }).opacity).toBeCloseTo(0.06, 4);
    const { pages } = createReport(doc);
    expect(pages[0]!.background).toHaveLength(1);
    expect(pages[0]!.background[0]!.fragment.opacity).toBeCloseTo(0.06, 4);
  });

  it('paints inline background fills while leaving the block fill to the block', () => {
    const doc = htmlToReportDoc(
      '<p style="background-color:#eef4ff">Tinted <mark>highlight</mark></p>',
    );
    const { pages } = createReport(doc);
    const runs = pages[0]!.body.flatMap((pf) =>
      pf.fragment.commands.flatMap((c) => (c.op === 'text' ? c.runs : [])),
    );
    expect(runs.some((r) => r.style.backgroundColor === '#fff2a8')).toBe(true);
    expect(runs.some((r) => r.style.backgroundColor === '#eef4ff')).toBe(true);
  });
});

// --- TOC, bookmarks and hyperlinks ----------------------------------------

describe('TOC, bookmarks and hyperlinks', () => {
  function tocReport(): ReportDoc {
    return htmlToReportDoc(`
      <style>@page { size: a4; margin: 40pt; }</style>
      <h1 id="top">Report</h1>
      <div data-toc data-title="Contents"></div>
      <p>Intro <a href="https://example.com">site</a> and <a href="#later">later</a>.</p>
      <p>${'Filler text that forces pagination. '.repeat(400)}</p>
      <h2 id="later">Later</h2>
      <p>Done.</p>`);
  }

  it('fills the TOC with real page numbers and linkable runs', () => {
    const { pages } = createReport(tocReport());
    expect(pages.length).toBeGreaterThan(1);
    const text = pageText(pages[0]!);
    expect(text).toContain('Contents');
    const later = /Later\.*\s*(\d+)/.exec(text);
    expect(later).toBeTruthy();
    expect(Number(later![1])).toBeGreaterThan(1);

    const tocRun = pages[0]!.body
      .flatMap((pf) => pf.fragment.commands)
      .flatMap((c) => (c.op === 'text' ? c.runs : []))
      .find((r) => r.text === 'Later');
    expect(tocRun?.link).toBe('#later');
  });

  it('exposes heading outline entries and block anchors per page', () => {
    const { pages } = createReport(tocReport());
    const outline = pages.flatMap((p) => p.outline.map((o) => ({ ...o, page: p.logical })));
    expect(outline.map((o) => o.title)).toEqual(['Report', 'Later']);
    expect(outline[0]!.level).toBe(1);
    expect(outline[1]!.level).toBe(2);
    expect(outline[1]!.page).toBeGreaterThan(1);
    expect(pages.some((p) => p.anchors.some((a) => a.name === 'top'))).toBe(true);
    expect(pages.some((p) => p.anchors.some((a) => a.name === 'later'))).toBe(true);
  });

  it('emits PDF outline items, link annotations and URI actions', async () => {
    const buffer = await renderToBuffer(tocReport());
    const latin = buffer.toString('latin1');
    expect(latin.startsWith('%PDF-')).toBe(true);
    expect(latin).toContain('/Outlines');
    expect(latin).toContain('/Annots');
    expect(latin).toContain('/URI');
  }, 20000);

  it('omits the bookmark tree when the report opts out', async () => {
    const report = { ...tocReport(), outline: false };
    const { pages } = createReport(report);
    // The TOC still works: its entries come from the paginated headings, not the writer.
    expect(pages.flatMap((p) => p.outline.map((o) => o.title))).toEqual(['Report', 'Later']);
    const latin = (await renderToBuffer(report)).toString('latin1');
    expect(latin).not.toContain('/Outlines');
  }, 20000);
});

// --- misc ------------------------------------------------------------------

describe('number patterns', () => {
  it('trims optional fraction zeros', () => {
    expect(formatNumber(12, '#,##0.###').text).toBe('12');
    expect(formatNumber(1.5, '#,##0.###').text).toBe('1.5');
    expect(formatNumber(1.25, '#,##0.00').text).toBe('1.25');
    expect(formatNumber(1234.5, '#,##0.00').text).toBe('1,234.50');
  });
});

describe('HTML charts and barcodes render to PDF', () => {
  it('writes polygons and code rectangles without error', async () => {
    const doc = htmlToReportDoc(`
      <div data-chart="pie" data-categories="A,B,C" data-values="50,30,20"></div>
      <div data-chart="area" data-categories="Q1,Q2" data-series="S:1,3"></div>
      <div data-barcode="qr" data-value="https://example.com"></div>
      <div data-barcode="code128" data-value="ABC-123"></div>
      <div data-barcode="ean13" data-value="590123412345"></div>`);
    const buffer = await renderToBuffer(doc);
    const latin = buffer.toString('latin1');
    expect(latin.startsWith('%PDF-')).toBe(true);
    expect(latin).toContain('%%EOF');
  }, 20000);
});
