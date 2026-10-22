/**
 * Tests for the three new capabilities: vector SVG images, additional chart
 * kinds + reference lines, and CSS flexbox layout.
 *
 * As in `features.test.ts`, layout is driven through `HeuristicFontHandle` so
 * measurements are deterministic without font files; the adapter checks exercise
 * the HTML→IR path and one integration case renders real PDF bytes.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import { parseSvg, svgSourceToText } from '../src/core/svg.js';
import { htmlToReportDoc } from '../src/adapter/html.js';
import { renderToBuffer } from '../src/index.js';
import type { Block, ChartBlock, FlexBlock, ReportDoc, SvgBlock } from '../src/ir/schema.js';
import type { Fragment } from '../src/layout/flow.js';

function makeCtx(): LayoutContext {
  const registry = new FontRegistry();
  registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
  registry.addHandle(new HeuristicFontHandle('Test', 700, 'normal'));
  const baseStyle = resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined);
  return new LayoutContext({ registry, baseStyle });
}

const opts = (contentWidth: number) => ({ contentWidth, scope: {} });

function fragmentText(f: Fragment): string {
  const parts: string[] = [];
  for (const c of f.commands) if (c.op === 'text') parts.push(c.runs.map((r) => r.text).join(''));
  return parts.join('');
}

// --- svg core --------------------------------------------------------------

describe('svg core parser', () => {
  it('turns a filled rect into one closed subpath with resolved paint', () => {
    const text = svgSourceToText('<svg viewBox="0 0 10 10"><rect x="1" y="2" width="6" height="4" fill="#ff0000"/></svg>');
    expect(text).toBeTruthy();
    const tree = parseSvg(text!)!;
    expect(tree.width).toBe(10);
    expect(tree.height).toBe(10);
    expect(tree.shapes).toHaveLength(1);
    const shape = tree.shapes[0]!;
    expect(shape.fill?.color).toEqual([1, 0, 0]);
    expect(shape.subpaths).toHaveLength(1);
    expect(shape.subpaths[0]!.closed).toBe(true);
    expect(shape.subpaths[0]!.points.length).toBeGreaterThanOrEqual(4);
  });

  it('detects non-svg sources and returns null', () => {
    expect(svgSourceToText('<div>not svg</div>')).toBeNull();
    expect(svgSourceToText('https://example.com/x.png')).toBeNull();
  });

  it('samples a circle to a many-vertex closed ring', () => {
    const tree = parseSvg('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>')!;
    expect(tree.shapes).toHaveLength(1);
    expect(tree.shapes[0]!.subpaths[0]!.points.length).toBeGreaterThan(20);
  });

  it('applies group transforms to child geometry', () => {
    const tree = parseSvg('<svg viewBox="0 0 100 100"><g transform="translate(10,20)"><rect width="5" height="5"/></g></svg>')!;
    const pt = tree.shapes[0]!.subpaths[0]!.points[0]!;
    expect(pt[0]).toBeCloseTo(10, 3);
    expect(pt[1]).toBeCloseTo(20, 3);
  });
});

// --- svg layout ------------------------------------------------------------

describe('svg layout', () => {
  const svgBlock = (markup: string, extra: Partial<SvgBlock> = {}): SvgBlock => ({
    type: 'svg',
    src: markup,
    ...extra,
  });

  it('emits path draw commands and one atomic fragment', () => {
    const frags = layoutBlock(svgBlock('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>'), makeCtx(), opts(200));
    expect(frags).toHaveLength(1);
    expect(frags[0]!.avoidSplit).toBe(true);
    expect(frags[0]!.commands.some((c) => c.op === 'path')).toBe(true);
    // No width → intrinsic 10px (≈7.5pt) capped to content, positive height.
    expect(frags[0]!.height).toBeGreaterThan(0);
  });

  it('honours an explicit width and preserves the aspect ratio', () => {
    const a = layoutBlock(svgBlock('<svg viewBox="0 0 20 10"><rect width="20" height="10"/></svg>', { width: 100 }), makeCtx(), opts(400))[0]!;
    expect(a.height).toBeCloseTo(50, 1); // 2:1 ratio
  });

  it('produces nothing for a non-svg source', () => {
    const f = layoutBlock(svgBlock('not-svg-markup'), makeCtx(), opts(200))[0]!;
    expect(f.commands).toHaveLength(0);
  });
});

// --- svg adapter -----------------------------------------------------------

describe('svg adapter', () => {
  it('maps an inline <svg> element to an svg block', () => {
    const doc = htmlToReportDoc('<div><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></div>');
    const svg = findBlock(doc, 'svg') as SvgBlock | undefined;
    expect(svg).toBeTruthy();
    expect(svg!.src).toContain('<svg');
  });

  it('routes an <img src="*.svg"> to a vector block', () => {
    const doc = htmlToReportDoc('<img src="assets/logo.svg" width="40">');
    const svg = findBlock(doc, 'svg') as SvgBlock | undefined;
    expect(svg).toBeTruthy();
    expect(svg!.src).toMatch(/\.svg$/);
  });
});

// --- flex ------------------------------------------------------------------

describe('flex layout', () => {
  const para = (text: string, extra: Partial<Block> = {}): Block => ({ type: 'paragraph', content: text, ...extra } as Block);

  it('places two row items side by side', () => {
    const block: FlexBlock = {
      type: 'flex',
      direction: 'row',
      children: [{ block: para('AAA'), grow: 1 }, { block: para('BBB'), grow: 1 }],
    };
    const f = layoutBlock(block, makeCtx(), opts(200))[0]!;
    expect(f.avoidSplit).toBe(true);
    const textCmds = f.commands.filter((c) => c.op === 'text');
    expect(textCmds.length).toBeGreaterThanOrEqual(2);
    const xs = textCmds.map((c) => (c.op === 'text' ? c.x : 0));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(20);
  });

  it('grows items to fill the row and applies gap', () => {
    const block: FlexBlock = {
      type: 'flex',
      direction: 'row',
      gap: 10,
      children: [{ block: para('A'), grow: 1 }, { block: para('B'), grow: 1 }],
    };
    const f = layoutBlock(block, makeCtx(), opts(210))[0]!;
    expect(f.commands.filter((c) => c.op === 'text').length).toBe(2);
  });

  it('stacks column items vertically', () => {
    const block: FlexBlock = {
      type: 'flex',
      direction: 'column',
      children: [{ block: para('one') }, { block: para('two') }],
    };
    const f = layoutBlock(block, makeCtx(), opts(200))[0]!;
    const ys = f.commands.filter((c) => c.op === 'text').map((c) => (c.op === 'text' ? c.baselineY : 0));
    expect(ys.length).toBe(2);
    expect(ys[1]! - ys[0]!).toBeGreaterThan(0);
  });

  it('grows items to fill the row without overflowing the container', () => {
    // Two half-width (basis 48%) growers plus a gap must stay inside innerW.
    const block: FlexBlock = {
      type: 'flex',
      direction: 'row',
      gap: 10,
      children: [
        { block: para('AAAA'), grow: 1, basis: '48%' },
        { block: para('BBBB'), grow: 1, basis: '48%' },
      ],
    };
    const innerW = 400;
    const f = layoutBlock(block, makeCtx(), opts(innerW))[0]!;
    const right = Math.max(...f.commands.map((c) => {
      if (c.op === 'text') {
        const last = c.runs[c.runs.length - 1];
        return last ? c.x + last.x + last.width : c.x;
      }
      return 0;
    }));
    // The second item's left edge sits near the halfway mark, and nothing crosses innerW.
    const xs = f.commands.filter((c) => c.op === 'text').map((c) => (c.op === 'text' ? c.x : 0));
    expect(Math.min(...xs)).toBeLessThan(20);
    expect(Math.max(...xs)).toBeGreaterThan(150);
    expect(right).toBeLessThanOrEqual(innerW + 0.5);
  });
});

describe('flex adapter', () => {
  it('parses display:flex and its item props', () => {
    const doc = htmlToReportDoc('<div style="display:flex;justify-content:space-between"><div style="flex-grow:1">A</div><div>B</div></div>');
    const flex = findBlock(doc, 'flex') as FlexBlock | undefined;
    expect(flex).toBeTruthy();
    expect(flex!.direction ?? 'row').toBe('row');
    expect(flex!.justify).toBe('space-between');
    expect(flex!.children).toHaveLength(2);
    expect(flex!.children[0]!.grow).toBe(1);
  });

  it('splits the two-value gap shorthand into row/column gaps', () => {
    const doc = htmlToReportDoc('<div style="display:flex;gap:6pt 10pt"><div>A</div><div>B</div></div>');
    const flex = findBlock(doc, 'flex') as FlexBlock | undefined;
    expect(flex).toBeTruthy();
    expect(flex!.rowGap).toBe('6pt');
    expect(flex!.columnGap).toBe('10pt');
    expect(flex!.gap).toBeUndefined();

    const one = htmlToReportDoc('<div style="display:flex;gap:8pt"><div>A</div><div>B</div></div>');
    const flexOne = findBlock(one, 'flex') as FlexBlock | undefined;
    expect(flexOne!.gap).toBe('8pt');
  });
});

// --- charts ----------------------------------------------------------------

describe('chart layout (new kinds)', () => {
  const chart = (kind: ChartBlock['kind'], extra: Partial<ChartBlock> = {}): ChartBlock => ({
    type: 'chart',
    kind,
    categories: ['a', 'b', 'c'],
    series: [{ name: 'S1', values: [3, 5, 2] }],
    ...extra,
  });

  it('plots scatter/bubble as point polygons', () => {
    const scatter = layoutBlock(chart('scatter', { series: [{ name: 'S', values: [3, 5, 2], xValues: [1, 2, 3] }] }), makeCtx(), opts(320))[0]!;
    expect(scatter.commands.filter((c) => c.op === 'poly').length).toBeGreaterThanOrEqual(3);
    const bubble = layoutBlock(
      chart('bubble', { series: [{ name: 'S', values: [3, 5, 2], xValues: [1, 2, 3], rValues: [1, 5, 9] }] }),
      makeCtx(),
      opts(320),
    )[0]!;
    expect(bubble.commands.some((c) => c.op === 'poly')).toBe(true);
  });

  it('draws radar as a closed polygon per series', () => {
    const f = layoutBlock(
      chart('radar', { categories: ['a', 'b', 'c', 'd'], series: [{ name: 'S', values: [3, 5, 2, 4] }] }),
      makeCtx(),
      opts(320),
    )[0]!;
    expect(f.commands.some((c) => c.op === 'poly')).toBe(true);
  });

  it('draws a gauge arc and needle', () => {
    const f = layoutBlock(chart('gauge', { gaugeValue: 72, gaugeMax: 100, series: [{ name: 'S', values: [72] }] }), makeCtx(), opts(320))[0]!;
    expect(f.commands.filter((c) => c.op === 'poly').length).toBeGreaterThanOrEqual(2);
    expect(f.commands.some((c) => c.op === 'line')).toBe(true);
    expect(fragmentText(f)).toContain('72');
  });

  it('fills heatmap cells across a colour ramp', () => {
    const f = layoutBlock(
      chart('heatmap', { series: [{ name: 'R1', values: [1, 2, 3] }, { name: 'R2', values: [4, 5, 6] }] }),
      makeCtx(),
      opts(320),
    )[0]!;
    // 6 cells (2 rows x 3 cols) drawn as fillRects.
    expect(f.commands.filter((c) => c.op === 'fillRect').length).toBeGreaterThanOrEqual(6);
    expect(fragmentText(f)).toContain('6');
  });

  it('draws range bars from low to high', () => {
    const f = layoutBlock(
      chart('bar', { range: true, series: [{ name: 'S', values: [1, 2, 3], low: [0, 0, 0], high: [5, 6, 7] }] }),
      makeCtx(),
      opts(320),
    )[0]!;
    expect(f.commands.filter((c) => c.op === 'fillRect').length).toBeGreaterThanOrEqual(3);
  });

  it('adds a horizontal reference line with a label', () => {
    const f = layoutBlock(chart('line', { referenceLines: [{ value: 4, label: 'target', color: '#cc0000' }] }), makeCtx(), opts(320))[0]!;
    expect(f.commands.some((c) => c.op === 'line' && c.dash)).toBe(true);
    expect(fragmentText(f)).toContain('target');
  });
});

describe('chart adapter (new attrs)', () => {
  it('reads data-chart scatter with per-series x column', () => {
    const doc = htmlToReportDoc('<div data-chart="scatter" data-categories="a,b" data-series="S:3,5" data-series-x="1,2" data-x-format="#,##0"></div>');
    const chart = findBlock(doc, 'chart') as ChartBlock | undefined;
    expect(chart?.kind).toBe('scatter');
    expect(chart?.series[0]?.xValues).toBe('1,2');
    expect(chart?.valueAxis?.xFormat).toBe('#,##0');
  });

  it('parses reference lines and gauge props', () => {
    const doc = htmlToReportDoc('<div data-chart="gauge" data-gauge-value="40" data-gauge-max="200"></div>');
    const chart = findBlock(doc, 'chart') as ChartBlock | undefined;
    expect(chart?.kind).toBe('gauge');
    expect(chart?.gaugeValue).toBe('40');
    expect(chart?.gaugeMax).toBe(200);

    const doc2 = htmlToReportDoc('<div data-chart="line" data-values="1,2,3" data-reference-lines="2:goal,color=#f00"></div>');
    const c2 = findBlock(doc2, 'chart') as ChartBlock | undefined;
    expect(c2?.referenceLines?.[0]).toEqual({ value: 2, label: 'goal', color: '#f00' });
  });
});

// --- integration -----------------------------------------------------------

describe('svg + flex + charts render end to end', () => {
  it('produces a PDF from inline svg, a flex row and a radar chart', async () => {
    const doc: ReportDoc = {
      page: { size: 'A4', margin: 24 },
      body: [
        {
          type: 'flex',
          direction: 'row',
          gap: 12,
          children: [
            { block: { type: 'paragraph', content: 'Left cell' } },
            {
              block: {
                type: 'svg',
                src: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1e3a8a"/></svg>',
                width: 40,
              },
            },
          ],
        } as Block,
        {
          type: 'chart',
          kind: 'radar',
          categories: ['speed', 'power', 'range', 'grip'],
          series: [{ name: 'Car A', values: [80, 60, 70, 90] }],
        } as Block,
      ],
    };
    const bytes = await renderToBuffer(doc);
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

function findBlock(doc: ReportDoc, type: string): Block | undefined {
  let found: Block | undefined;
  const walk = (blocks: Block[] | undefined): void => {
    for (const b of blocks ?? []) {
      if (found) return;
      if ((b as { type?: string }).type === type) {
        found = b;
        return;
      }
      if (b.type === 'flex') walk(b.children.map((c) => c.block));
    }
  };
  walk(doc.body);
  for (const band of Object.values(doc.bands ?? {})) walk(band?.blocks);
  return found;
}
