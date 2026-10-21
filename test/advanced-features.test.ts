/**
 * Tests for the three depth features:
 *  - rich table cells (`CellNode.blocks`),
 *  - conditional formatting (`visible`, `styleWhen`, `colorScale`),
 *  - chart depth (combo + secondary axis, 100% stacking, waterfall),
 * plus the declarative HTML attributes that expose them.
 *
 * Layout is driven through `HeuristicFontHandle` so measurements are exact and
 * reproducible without font files.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import { htmlToReportDoc } from '../src/adapter/html.js';
import { toRGB, type ColorInput } from '../src/core/color.js';
import { createReport, renderToBuffer } from '../src/index.js';
import type {
  Block,
  ChartBlock,
  ParagraphBlock,
  RowNode,
  TableBlock,
} from '../src/ir/schema.js';
import type { DrawCommand, Fragment } from '../src/layout/flow.js';
import type { ExprContext } from '../src/expr/eval.js';

function makeCtx(): LayoutContext {
  const registry = new FontRegistry();
  registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
  const baseStyle = resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined);
  return new LayoutContext({ registry, baseStyle });
}

const opts = (contentWidth: number, scope: ExprContext = {}) => ({ contentWidth, scope });

function fragmentText(f: Fragment): string {
  return f.commands
    .filter((c) => c.op === 'text')
    .map((c) => (c.op === 'text' ? c.runs.map((r) => r.text).join('') : ''))
    .join('');
}

type FillRect = Extract<DrawCommand, { op: 'fillRect' }>;

function fillRects(f: Fragment): FillRect[] {
  return f.commands.filter((c): c is FillRect => c.op === 'fillRect');
}

function runOf(f: Fragment, text: string) {
  for (const command of f.commands) {
    if (command.op !== 'text') continue;
    for (const run of command.runs) if (run.text === text) return run;
  }
  return undefined;
}

/** Colour equality with a tolerance: interpolated fills carry float noise. */
function expectColor(actual: ColorInput, expected: string): void {
  const got = toRGB(actual);
  const want = toRGB(expected);
  for (let i = 0; i < 3; i += 1) expect(got[i]).toBeCloseTo(want[i]!, 6);
}

// --- rich cells ------------------------------------------------------------

describe('rich table cells', () => {
  const table = (): TableBlock => ({
    type: 'table',
    columns: [{ grow: 1 }, { grow: 1 }],
    headerRows: [{ kind: 'header', cells: [{ content: 'Item' }, { content: 'Preview' }] }],
    staticRows: [
      {
        kind: 'detail',
        cells: [
          { content: 'Camera' },
          {
            blocks: [
              { type: 'image', src: '/logo.png', intrinsic: { width: 200, height: 100 }, width: 80 },
              { type: 'barcode', symbology: 'qr', value: 'CELL', moduleSize: 1.5 },
              { type: 'paragraph', content: 'In stock' },
            ],
          },
        ],
      },
    ],
  });

  it('stacks images, barcodes and paragraphs inside a cell', () => {
    const frags = layoutBlock(table(), makeCtx(), opts(240));
    expect(frags).toHaveLength(2);
    const row = frags[1]!;

    const image = row.commands.find((c) => c.op === 'image');
    expect(image).toBeDefined();
    if (image?.op === 'image') {
      expect(image.w).toBeCloseTo(80, 3);
      expect(image.h).toBeCloseTo(40, 3);
    }
    // The QR code contributes its module rectangles as nested vector commands.
    expect(fillRects(row).length).toBeGreaterThan(20);
    expect(fragmentText(row)).toContain('In stock');
  });

  it('grows the row to the measured height of the block stack', () => {
    const frags = layoutBlock(table(), makeCtx(), opts(240));
    const header = frags[0]!;
    const row = frags[1]!;
    // Image (40) + QR + caption must exceed a single 10pt text line.
    expect(row.height).toBeGreaterThan(40);
    expect(row.height).toBeGreaterThan(header.height);
    // The cell's inline content stays on the left of the same row.
    expect(fragmentText(row)).toContain('Camera');
  });

  it('honours vertical alignment of the block stack', () => {
    const block = table();
    const other = block.staticRows![0]!.cells[0]!;
    // `content` wins over `blocks`, so clear it before attaching the image.
    other.content = undefined;
    other.blocks = [{ type: 'image', src: '/logo.png', intrinsic: { width: 200, height: 100 }, width: 80 }];
    const cell = block.staticRows![0]!.cells[1]!;
    cell.blocks = [{ type: 'paragraph', content: 'Small' }];
    cell.verticalAlign = 'bottom';
    const row = layoutBlock(block, makeCtx(), opts(240))[1]!;
    const caption = row.commands.find(
      (c) => c.op === 'text' && c.runs.some((r) => r.text === 'Small'),
    );
    const image = row.commands.find((c) => c.op === 'image');
    expect(caption?.op).toBe('text');
    expect(image?.op).toBe('image');
    if (caption?.op === 'text' && image?.op === 'image') {
      // Bottom aligned text sits below the top aligned image's top edge.
      expect(caption.baselineY).toBeGreaterThan(image.y);
    }
  });
});

// --- conditional formatting ------------------------------------------------

describe('conditional formatting', () => {
  it('hides blocks whose visible expression is falsy', () => {
    const block: Block = { type: 'paragraph', content: 'secret', visible: { expr: '$row.show' } };
    const ctx = makeCtx();
    expect(layoutBlock(block, ctx, opts(200, { $row: { show: true } }))).toHaveLength(1);
    expect(layoutBlock(block, ctx, opts(200, { $row: { show: false } }))).toHaveLength(0);
    expect(layoutBlock({ ...block, visible: false }, ctx, opts(200))).toHaveLength(0);
  });

  it('merges styleWhen over the block style', () => {
    const block: Block = {
      type: 'paragraph',
      content: 'Alert',
      styleWhen: [{ when: { expr: '$data.hot' }, style: { backgroundColor: '#ff0000' } }],
    };
    const ctx = makeCtx();
    const hot = layoutBlock(block, ctx, opts(200, { $data: { hot: true } }))[0]!;
    const cold = layoutBlock(block, ctx, opts(200, { $data: { hot: false } }))[0]!;
    expect(fillRects(hot)).toHaveLength(1);
    expectColor(fillRects(hot)[0]!.color, '#ff0000');
    expect(fillRects(cold)).toHaveLength(0);
  });

  it('drops data rows whose visible expression is false', () => {
    const table: TableBlock = {
      type: 'table',
      columns: [{ key: 'name', grow: 1 }, { key: 'qty', width: 40 }],
      headerRows: [{ kind: 'header', cells: [{ content: 'Name' }, { content: 'Qty' }] }],
      dataSource: [
        { name: 'apple', qty: 3, void: false },
        { name: 'banana', qty: 12, void: true },
      ],
      detail: { cells: [{}, {}], visible: { expr: '!$row.void' } },
    };
    const frags = layoutBlock(table, makeCtx(), opts(160));
    expect(frags).toHaveLength(2);
    const text = frags.map(fragmentText).join('');
    expect(text).toContain('apple');
    expect(text).not.toContain('banana');
  });

  it('applies a row condition to every cell of the row', () => {
    const table: TableBlock = {
      type: 'table',
      columns: [{ key: 'name', grow: 1 }, { key: 'growth', width: 50 }],
      dataSource: [{ name: 'Down', growth: -4 }],
      detail: {
        cells: [{}, {}],
        styleWhen: [{ when: { expr: '$row.growth < 0' }, style: { backgroundColor: '#fff5f5' } }],
      },
    };
    const row = layoutBlock(table, makeCtx(), opts(200))[0]!;
    const fills = fillRects(row);
    expect(fills).toHaveLength(2);
    for (const rect of fills) expectColor(rect.color, '#fff5f5');
  });

  it('applies a cell condition after the cell style', () => {
    const table: TableBlock = {
      type: 'table',
      columns: [{ grow: 1 }, { grow: 1 }],
      staticRows: [
        {
          kind: 'detail',
          cells: [
            { content: 'ok' },
            {
              content: 'risk',
              style: { color: '#333333' },
              styleWhen: [{ when: { expr: '$data.alert' }, style: { color: '#ff0000' } }],
            },
          ],
        },
      ],
    };
    const frag = layoutBlock(table, makeCtx(), opts(200, { $data: { alert: true } }))[0]!;
    const run = runOf(frag, 'risk');
    expect(run).toBeDefined();
    expect(toRGB(run!.style.color)).toEqual(toRGB('#ff0000'));
  });

  it('derives a per-column heatmap range and flips dark text to white', () => {
    const table: TableBlock = {
      type: 'table',
      // An inherited table background must not mask the per-column heatmap.
      backgroundColor: '#ffffff',
      columns: [
        { key: 'name', grow: 1 },
        { key: 'score', width: 60, align: 'right', colorScale: { from: '#eef4ff', to: '#1e3a8a' } },
      ],
      headerRows: [{ kind: 'header', cells: [{ content: 'Name' }, { content: 'Score' }] }],
      dataSource: [
        { name: 'low', score: 10 },
        { name: 'high', score: 90 },
      ],
      detail: { cells: [{}, {}] },
    };
    const frags = layoutBlock(table, makeCtx(), opts(200));
    const low = fillRects(frags[1]!);
    const high = fillRects(frags[2]!);
    expect(low).toHaveLength(1);
    expect(high).toHaveLength(1);
    expectColor(low[0]!.color, '#eef4ff');
    expectColor(high[0]!.color, '#1e3a8a');
    // Dark end of the scale: the number is repainted white for contrast.
    const run = runOf(frags[2]!, '90');
    expect(run).toBeDefined();
    expect(toRGB(run!.style.color)).toEqual([1, 1, 1]);
  });

  it('resolves a cell-level scale against the column range', () => {
    const table: TableBlock = {
      type: 'table',
      columns: [{ key: 'name', grow: 1 }, { key: 'score', width: 60 }],
      dataSource: [
        { name: 'a', score: 0 },
        { name: 'b', score: 50 },
        { name: 'c', score: 100 },
      ],
      detail: {
        cells: [{}, { colorScale: { from: '#ffffff', to: '#000000', text: false } }],
      },
    };
    const frags = layoutBlock(table, makeCtx(), opts(200));
    const mids = fillRects(frags[1]!);
    expect(mids).toHaveLength(1);
    // Midpoint of the auto range -> mid-grey, and `text: false` keeps dark text.
    const [r, g, b] = toRGB(mids[0]!.color);
    expect(r).toBeCloseTo(0.5, 2);
    expect(g).toBeCloseTo(0.5, 2);
    expect(b).toBeCloseTo(0.5, 2);
    const run = runOf(frags[1]!, '50');
    expect(run).toBeDefined();
    expect(toRGB(run!.style.color)).not.toEqual([1, 1, 1]);
  });
});

// --- chart depth -----------------------------------------------------------

describe('chart depth', () => {
  it('draws a combo chart against a secondary axis', () => {
    const block: ChartBlock = {
      type: 'chart',
      kind: 'combo',
      categories: ['Q1', 'Q2'],
      series: [
        { name: 'Revenue', values: [10, 20], type: 'bar' },
        { name: 'Margin', values: [5, 15], type: 'line', axis: 'right' },
      ],
      rightAxis: { min: 0, max: 100, ticks: 4, format: '0.0' },
      showValues: true,
      height: 160,
    };
    const f = layoutBlock(block, makeCtx(), opts(320))[0]!;
    const text = fragmentText(f);

    // Bars from the left-axis series, a polyline from the right-axis series.
    expect(fillRects(f).length).toBeGreaterThanOrEqual(2);
    expect(f.commands.some((c) => c.op === 'poly')).toBe(true);
    // Right-axis ticks use the right-axis pattern, not the left axis's numbers.
    expect(text).toContain('25.0');
    // Line labels are formatted with the right axis format too.
    expect(text).toContain('15.0');
    expect(text).toContain('Margin');
  });

  it('normalises 100% stacked bars and labels them as percentages', () => {
    const block: ChartBlock = {
      type: 'chart',
      kind: 'bar',
      stacked: '100%',
      showValues: true,
      legend: 'none',
      categories: ['A', 'B'],
      series: [
        { name: 'X', values: [1, 3] },
        { name: 'Y', values: [1, 1] },
      ],
      height: 180,
    };
    const f = layoutBlock(block, makeCtx(), opts(320))[0]!;
    const bars = fillRects(f).filter((rect) => rect.w > 10);
    expect(bars).toHaveLength(4);
    // Every category fills exactly the 0-100 plot band.
    expect(bars[0]!.h + bars[1]!.h).toBeCloseTo(bars[2]!.h + bars[3]!.h, 3);
    expect(bars[0]!.h + bars[1]!.h).toBeGreaterThan(40);
    const text = fragmentText(f);
    expect(text).toContain('50%');
    expect(text).toContain('75%');
  });

  it('builds waterfall spans, colour coding and dashed connectors', () => {
    const block: ChartBlock = {
      type: 'chart',
      kind: 'waterfall',
      categories: ['Start', 'Revenue', 'Cost', 'End'],
      series: [{ name: 'Cash', values: [100, 40, -25, 0] }],
      totals: [0, 3],
      showValues: true,
      height: 200,
    };
    const f = layoutBlock(block, makeCtx(), opts(320))[0]!;
    const bars = fillRects(f).filter((rect) => rect.w > 10);
    expect(bars).toHaveLength(4);
    expect(toRGB(bars[0]!.color)).toEqual(toRGB('#0f3b6d')); // opening balance
    expect(toRGB(bars[1]!.color)).toEqual(toRGB('#1b7f4b')); // increase
    expect(toRGB(bars[2]!.color)).toEqual(toRGB('#b23b3b')); // decrease
    // The closing total spans 0 -> 115, so it ends above the opening balance.
    expect(bars[3]!.y).toBeLessThan(bars[0]!.y);
    // One dashed connector per gap between bars.
    expect(f.commands.filter((c) => c.op === 'line' && c.dash).length).toBe(3);
    expect(fragmentText(f)).toContain('115');
  });

  it('honours custom waterfall colours', () => {
    const block: ChartBlock = {
      type: 'chart',
      kind: 'waterfall',
      categories: ['A', 'B'],
      series: [{ name: 'Cash', values: [10, 5] }],
      totals: [0],
      waterfallColors: { total: '#123456', increase: '#00ff00' },
      legend: 'none',
      height: 120,
    };
    const f = layoutBlock(block, makeCtx(), opts(240))[0]!;
    const bars = fillRects(f).filter((rect) => rect.w > 10);
    expect(toRGB(bars[0]!.color)).toEqual(toRGB('#123456'));
    expect(toRGB(bars[1]!.color)).toEqual(toRGB('#00ff00'));
  });
});

// --- declarative HTML surface ---------------------------------------------

describe('declarative HTML surface', () => {
  it('maps data-if / data-when onto blocks', () => {
    const doc = htmlToReportDoc(
      '<p data-if="$data.show > 0">Visible</p>' +
        '<p data-when="$data.hot" data-when-style="background-color: #ff0000">Hot</p>',
    );
    const [first, second] = doc.body as ParagraphBlock[];
    expect(first!.visible).toEqual({ expr: '$data.show > 0' });
    expect(second!.styleWhen).toHaveLength(1);
    expect(second!.styleWhen![0]!.when).toEqual({ expr: '$data.hot' });
    expect(second!.styleWhen![0]!.style!.backgroundColor).toBe('#ff0000');
  });

  it('turns a <td> with block children into a rich cell', () => {
    const doc = htmlToReportDoc(
      '<table><tr><td>Plain</td><td><img src="logo.png" width="24"><p>Caption</p></td></tr></table>',
    );
    const table = doc.body![0] as TableBlock;
    const cell = table.staticRows![0]!.cells[1]!;
    expect(cell.content).toBeUndefined();
    expect(cell.blocks?.map((b) => b.type)).toEqual(['image', 'paragraph']);
  });

  it('carries row conditions and cell colour scales through data-each', () => {
    const doc = htmlToReportDoc(
      '<table data-each="row in $data.rows">' +
        '<thead><tr><th>Name</th><th>Score</th></tr></thead>' +
        '<tbody><tr data-when="$row.score < 0" data-when-style="color: #b91c1c">' +
        '<td data-bind="name"></td>' +
        '<td data-bind="score" data-color-scale="min=0;max=100;from=#ffffff;to=#1e3a8a"></td>' +
        '</tr></tbody></table>',
    );
    const table = doc.body![0] as TableBlock;
    const detail = table.detail as RowNode;
    expect(detail.styleWhen?.[0]!.when).toEqual({ expr: '$row.score < 0' });
    expect(detail.cells[1]!.colorScale).toEqual({ min: 0, max: 100, from: '#ffffff', to: '#1e3a8a' });
  });

  it('maps combo / waterfall chart attributes', () => {
    const doc = htmlToReportDoc(
      '<div data-chart="combo" data-series="Revenue:10,20; Margin:5,15" ' +
        'data-series-types="bar,line" data-series-axes="left,right" ' +
        'data-right-min="0" data-right-max="100" data-right-format="0.0" data-stacked="100%"></div>' +
        '<div data-chart="waterfall" data-values="100,40,-25" data-totals="0" ' +
        'data-waterfall-colors="increase=#15803d; decrease=#b91c1c; total=#1e3a8a"></div>',
    );
    const [combo, waterfall] = doc.body as ChartBlock[];
    expect(combo!.kind).toBe('combo');
    expect(combo!.stacked).toBe('100%');
    expect(combo!.series[0]!.type).toBe('bar');
    expect(combo!.series[1]).toMatchObject({ type: 'line', axis: 'right' });
    expect(combo!.rightAxis).toMatchObject({ min: 0, max: 100, format: '0.0' });
    expect(waterfall!.kind).toBe('waterfall');
    expect(waterfall!.totals).toEqual([0]);
    expect(waterfall!.waterfallColors).toEqual({
      increase: '#15803d',
      decrease: '#b91c1c',
      total: '#1e3a8a',
    });
  });
});

// --- end to end ------------------------------------------------------------

describe('rich reports render to PDF', () => {
  it('writes a heatmapped table, rich cell and combo chart without error', async () => {
    const doc = htmlToReportDoc(`
      <h1>Depth report</h1>
      <table>
        <tr>
          <td>Team</td>
          <td style="text-align:right; color:#1e3a8a" data-color-scale="min=0;max=100;from=#eef4ff;to=#1e3a8a">Score</td>
        </tr>
        <tr>
          <td>Alpha</td>
          <td style="text-align:right" data-color-scale="min=0;max=100;from=#eef4ff;to=#1e3a8a">20</td>
        </tr>
        <tr>
          <td>Beta</td>
          <td style="text-align:right" data-color-scale="min=0;max=100;from=#eef4ff;to=#1e3a8a">90</td>
        </tr>
        <tr>
          <td>Gamma</td>
          <td><div data-barcode="qr" data-value="alpha" data-module-size="1"></div><p>On track</p></td>
        </tr>
      </table>
      <div data-chart="combo" data-categories="Q1,Q2,Q3"
           data-series="Revenue:12,18,15; Margin:4,6,9"
           data-series-types="bar,line" data-series-axes="left,right"
           data-right-min="0" data-right-max="12"></div>
      <div data-chart="waterfall" data-categories="Start,Q1,Q2,End"
           data-values="80,30,-20,0" data-totals="0,3"></div>
    `);
    const { pages } = createReport(doc);
    expect(pages.length).toBeGreaterThan(0);
    const buffer = await renderToBuffer(doc);
    const latin = buffer.toString('latin1');
    expect(latin.startsWith('%PDF-')).toBe(true);
    expect(latin).toContain('%%EOF');
  }, 30000);
});
