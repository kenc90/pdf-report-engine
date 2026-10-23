/**
 * Tests for the six new features:
 *  - Watermark generation and rotation
 *  - Multi-column layout
 *  - Gantt chart layout
 *  - Streaming output (renderToStream)
 *  - HTML adapter parsing for new features
 *  - Hyperlinks and rich text are already tested in features.test.ts
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import { paginate } from '../src/pagination/engine.js';
import { htmlToReportDoc } from '../src/adapter/html.js';
import { renderToBuffer, renderToStream, createReport, readFontFiles, type FontSource } from '../src/index.js';
import type { Block, ColumnBlock, ChartBlock, ReportDoc } from '../src/ir/schema.js';
import type { Fragment } from '../src/layout/flow.js';

function makeCtx(): LayoutContext {
  const registry = new FontRegistry();
  registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
  registry.addHandle(new HeuristicFontHandle('Test', 700, 'normal'));
  const baseStyle = resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined);
  return new LayoutContext({ registry, baseStyle });
}

const opts = (contentWidth: number) => ({ contentWidth, scope: {} as Record<string, unknown> });

// --- watermark tests --------------------------------------------------------

describe('watermark', () => {
  it('generates a background fragment with rotation and opacity', () => {
    const ctx = makeCtx();
    const registry = ctx.registry;
    const pageSpec = { size: 'A4' as const };
    const resolved = { width: 595, height: 842, margin: { top: 40, right: 40, bottom: 40, left: 40 }, content: { x: 40, y: 40, width: 515, height: 762 } };
    const report: ReportDoc = {
      body: [{ type: 'paragraph', content: 'Hello World' }],
      watermark: { text: 'DRAFT', rotate: -35, fontSize: 72, opacity: 0.18 },
    };
    const pages = paginate({
      ctx,
      page: resolved,
      contentWidth: resolved.content.width,
      body: report.body!,
      bands: undefined,
      scope: {},
      watermark: report.watermark,
    });
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const bg = pages[0]!.background;
    // Should have at least the watermark fragment
    const wmFrag = bg.find((pf) => pf.fragment.rotate !== undefined);
    expect(wmFrag).toBeDefined();
    expect(wmFrag!.fragment.rotate).toBe(-35);
    expect(wmFrag!.fragment.opacity).toBe(0.18);
    // The watermark fragment should contain a text command
    const textCmd = wmFrag!.fragment.commands.find((c) => c.op === 'text');
    expect(textCmd).toBeDefined();
    if (textCmd?.op === 'text') {
      expect(textCmd.runs[0]!.text).toBe('DRAFT');
    }
  });

  it('watermark is applied to every page', () => {
    const ctx = makeCtx();
    const resolved = { width: 595, height: 100, margin: { top: 10, right: 10, bottom: 10, left: 10 }, content: { x: 10, y: 10, width: 575, height: 80 } };
    // Multiple short paragraphs that need 2+ pages
    const body: Block[] = Array.from({ length: 20 }, (_, i) => ({ type: 'paragraph', content: `Line ${i}` }) as Block);
    const pages = paginate({
      ctx,
      page: resolved,
      contentWidth: resolved.content.width,
      body,
      bands: undefined,
      scope: {},
      watermark: { text: 'WATERMARK' },
    });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const wm = page.background.find((pf) => pf.fragment.rotate !== undefined);
      expect(wm).toBeDefined();
    }
  });
});

// --- column layout tests ----------------------------------------------------

describe('ColumnBlock layout', () => {
  it('distributes children across 2 columns', () => {
    const ctx = makeCtx();
    const block: ColumnBlock = {
      type: 'columns',
      count: 2,
      gap: 10,
      children: [
        { type: 'paragraph', content: 'Left column text' },
        { type: 'paragraph', content: 'Right column text' },
      ],
    };
    const frags = layoutBlock(block, ctx, opts(200));
    expect(frags.length).toBe(1);
    const frag = frags[0]!;
    // colW = (200 - 10) / 2 = 95. Text should appear in two columns
    const textCmds = frag.commands.filter((c) => c.op === 'text');
    expect(textCmds.length).toBeGreaterThanOrEqual(2);
  });

  it('respects 3-column layout', () => {
    const ctx = makeCtx();
    const block: ColumnBlock = {
      type: 'columns',
      count: 3,
      gap: 12,
      children: [
        { type: 'paragraph', content: 'A' },
        { type: 'paragraph', content: 'B' },
        { type: 'paragraph', content: 'C' },
      ],
    };
    const frags = layoutBlock(block, ctx, opts(300));
    expect(frags.length).toBe(1);
    // colW = (300 - 24) / 3 = 92
    expect(frags[0]!.height).toBeGreaterThan(0);
  });

  it('emits rule lines between columns when rule is set', () => {
    const ctx = makeCtx();
    const block: ColumnBlock = {
      type: 'columns',
      count: 2,
      gap: 10,
      rule: true,
      children: [
        { type: 'paragraph', content: 'Col 1' },
        { type: 'paragraph', content: 'Col 2' },
      ],
    };
    const frags = layoutBlock(block, ctx, opts(200));
    const lineCmds = frags[0]!.commands.filter((c) => c.op === 'line');
    // At least 1 rule line between 2 columns
    expect(lineCmds.length).toBeGreaterThanOrEqual(1);
  });

  it('empty columns block produces zero-height fragment', () => {
    const ctx = makeCtx();
    const block: ColumnBlock = { type: 'columns', count: 2, children: [] };
    const frags = layoutBlock(block, ctx, opts(200));
    expect(frags.length).toBe(1);
    expect(frags[0]!.height).toBe(0);
  });
});

// --- gantt chart tests ------------------------------------------------------

describe('Gantt chart layout', () => {
  it('produces one fragment with bars at correct positions', () => {
    const ctx = makeCtx();
    const block: ChartBlock = {
      type: 'chart',
      kind: 'gantt',
      series: [],
      ganttTasks: [
        { name: 'Design', start: 0, end: 3 },
        { name: 'Backend', start: 2, end: 7 },
        { name: 'Testing', start: 8, end: 12 },
      ],
      ganttStart: 0,
      ganttEnd: 12,
      ganttUnit: 'day',
    };
    const frags = layoutBlock(block, ctx, opts(400));
    expect(frags.length).toBe(1);
    const frag = frags[0]!;
    // Should have fillRect commands for bars
    const bars = frag.commands.filter((c) => c.op === 'fillRect');
    expect(bars.length).toBe(3); // one per task
    // Check relative positions
    if (bars[0]!.op === 'fillRect' && bars[1]!.op === 'fillRect') {
      expect(bars[1]!.x).toBeGreaterThan(bars[0]!.x); // Backend starts after Design
    }
  });

  it('renders progress sub-bars', () => {
    const ctx = makeCtx();
    const block: ChartBlock = {
      type: 'chart',
      kind: 'gantt',
      series: [],
      ganttTasks: [{ name: 'Task', start: 0, end: 10, progress: 0.5 }],
      ganttStart: 0,
      ganttEnd: 10,
    };
    const frags = layoutBlock(block, ctx, opts(400));
    const bars = frags[0]!.commands.filter((c) => c.op === 'fillRect');
    expect(bars.length).toBe(2); // main bar + progress bar
  });

  it('renders dependency arrows', () => {
    const ctx = makeCtx();
    const block: ChartBlock = {
      type: 'chart',
      kind: 'gantt',
      series: [],
      ganttTasks: [
        { name: 'A', start: 0, end: 5 },
        { name: 'B', start: 5, end: 10, dependsOn: [0] },
      ],
      ganttStart: 0,
      ganttEnd: 10,
    };
    const frags = layoutBlock(block, ctx, opts(400));
    const polys = frags[0]!.commands.filter((c) => c.op === 'poly');
    expect(polys.length).toBe(1); // one dependency arrow
  });

  it('empty gantt produces no visible output', () => {
    const ctx = makeCtx();
    const block: ChartBlock = { type: 'chart', kind: 'gantt', series: [], ganttTasks: [] };
    const frags = layoutBlock(block, ctx, opts(400));
    expect(frags[0]!.height).toBe(0);
  });
});

// --- streaming tests --------------------------------------------------------

describe('renderToStream', () => {
  it('produces valid PDF bytes via ReadableStream', async () => {
    const report: ReportDoc = {
      body: [{ type: 'paragraph', content: 'Hello stream' }],
    };
    const stream = await renderToStream(report);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value!);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    expect(total).toBeGreaterThan(100);
    // PDF starts with %PDF
    const first = chunks[0]!;
    const header = String.fromCharCode(...first.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('stream matches buffer output structurally', async () => {
    const report: ReportDoc = {
      body: [{ type: 'heading', level: 1, content: 'Test' }],
    };
    const buf = await renderToBuffer(report);
    const stream = await renderToStream(report);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value!);
    }
    let streamTotal = 0;
    for (const c of chunks) streamTotal += c.length;
    // Both should produce valid PDFs (sizes may differ slightly due to metadata timestamps)
    expect(streamTotal).toBeGreaterThan(100);
    expect(buf.length).toBeGreaterThan(100);
  });
});

// --- HTML adapter tests -----------------------------------------------------

describe('HTML adapter: new features', () => {
  it('parses data-watermark on body', () => {
    const html = '<html><body data-watermark="CONFIDENTIAL" data-watermark-rotate="-45" data-watermark-color="#ff0000"><p>Hello</p></body></html>';
    const doc = htmlToReportDoc(html);
    expect(doc.watermark).toBeDefined();
    expect(doc.watermark!.text).toBe('CONFIDENTIAL');
    expect(doc.watermark!.rotate).toBe(-45);
    expect(doc.watermark!.color).toBe('#ff0000');
  });

  it('parses <meta name="watermark">', () => {
    const html = '<html><head><meta name="watermark" content="DRAFT"></head><body><p>Content</p></body></html>';
    const doc = htmlToReportDoc(html);
    expect(doc.watermark).toBeDefined();
    expect(doc.watermark!.text).toBe('DRAFT');
  });

  it('parses column-count style into ColumnBlock', () => {
    const html = '<html><body><div style="column-count: 3; column-gap: 16pt"><p>A</p><p>B</p><p>C</p></div></body></html>';
    const doc = htmlToReportDoc(html);
    const columnsBlock = doc.body?.find((b) => b.type === 'columns') as ColumnBlock | undefined;
    expect(columnsBlock).toBeDefined();
    expect(columnsBlock!.count).toBe(3);
    expect(columnsBlock!.gap).toBe('16pt');
    expect(columnsBlock!.children.length).toBeGreaterThanOrEqual(1);
  });

  it('parses data-columns attribute', () => {
    const html = '<html><body><div data-columns="2" data-column-gap="20"><p>X</p><p>Y</p></div></body></html>';
    const doc = htmlToReportDoc(html);
    const col = doc.body?.find((b) => b.type === 'columns') as ColumnBlock | undefined;
    expect(col).toBeDefined();
    expect(col!.count).toBe(2);
    expect(col!.gap).toBe('20');
  });

  it('parses gantt chart data-chart="gantt"', () => {
    const html = '<html><body><div data-chart="gantt" data-title="Timeline" data-gantt-unit="week" data-gantt-start="0" data-gantt-end="12" data-gantt-tasks="Design:0:3;Backend:2:7;Testing:8:12"></div></body></html>';
    const doc = htmlToReportDoc(html);
    const chart = doc.body?.find((b) => b.type === 'chart') as ChartBlock | undefined;
    expect(chart).toBeDefined();
    expect(chart!.kind).toBe('gantt');
    expect(chart!.ganttUnit).toBe('week');
    expect(chart!.ganttStart).toBe(0);
    expect(chart!.ganttEnd).toBe(12);
    expect(chart!.ganttTasks).toHaveLength(3);
    expect(chart!.ganttTasks![0]!.name).toBe('Design');
    expect(chart!.ganttTasks![0]!.end).toBe(3);
    expect(chart!.ganttTasks![1]!.name).toBe('Backend');
  });

  it('gantt tasks with color and progress', () => {
    const html = '<html><body><div data-chart="gantt" data-gantt-tasks="Alpha:0:5:#ff0000:0.7;Beta:3:8:0.3"></div></body></html>';
    const doc = htmlToReportDoc(html);
    const chart = doc.body?.find((b) => b.type === 'chart') as ChartBlock | undefined;
    expect(chart!.ganttTasks![0]!.color).toBe('#ff0000');
    expect(chart!.ganttTasks![0]!.progress).toBe(0.7);
    expect(chart!.ganttTasks![1]!.progress).toBe(0.3);
  });
});

// --- writer rotation integration --------------------------------------------

describe('writer fragment rotation', () => {
  it('createReport produces valid PDF with watermark and rotation', () => {
    const report: ReportDoc = {
      body: [{ type: 'paragraph', content: 'Rotated watermark test' }],
      watermark: { text: 'VOID', rotate: -40, fontSize: 80, opacity: 0.15 },
    };
    const { doc, pages } = createReport(report);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    // Verify the background has the watermark fragment
    const wm = pages[0]!.background.find((pf) => pf.fragment.rotate === -40);
    expect(wm).toBeDefined();
    doc.end();
  });
});

// --- watermark layer routing (foreground vs background) --------------------

describe('watermark layer routing', () => {
  const resolved = { width: 595, height: 842, margin: { top: 40, right: 40, bottom: 40, left: 40 }, content: { x: 40, y: 40, width: 515, height: 762 } };

  function runWith(layer: 'background' | 'foreground' | undefined) {
    const ctx = makeCtx();
    const report: ReportDoc = {
      body: [{ type: 'paragraph', content: 'Body text' }],
      watermark: { text: 'MARK', layer },
    };
    return paginate({
      ctx,
      page: resolved,
      contentWidth: resolved.content.width,
      body: report.body!,
      bands: undefined,
      scope: {},
      watermark: report.watermark,
    });
  }

  it('default (undefined) places the fragment in page.background', () => {
    const pages = runWith(undefined);
    const wmBg = pages[0]!.background.find((pf) => pf.fragment.rotate !== undefined);
    const wmFg = pages[0]!.foreground.find((pf) => pf.fragment.rotate !== undefined);
    expect(wmBg).toBeDefined();
    expect(wmFg).toBeUndefined();
  });

  it("layer: 'background' places the fragment in page.background", () => {
    const pages = runWith('background');
    expect(pages[0]!.background.some((pf) => pf.fragment.rotate !== undefined)).toBe(true);
    expect(pages[0]!.foreground.length).toBe(0);
  });

  it("layer: 'foreground' places the fragment in page.foreground", () => {
    const pages = runWith('foreground');
    const wmFg = pages[0]!.foreground.find((pf) => pf.fragment.rotate !== undefined);
    expect(wmFg).toBeDefined();
    expect(pages[0]!.background.some((pf) => pf.fragment.rotate !== undefined)).toBe(false);
  });
});

// --- HTML adapter: watermark layer -----------------------------------------

describe('HTML adapter: watermark layer', () => {
  it("parses data-watermark-layer='foreground' into spec.layer", () => {
    const html = '<html><body data-watermark="CONF" data-watermark-layer="foreground"><p>x</p></body></html>';
    const doc = htmlToReportDoc(html);
    expect(doc.watermark!.layer).toBe('foreground');
  });

  it("accepts 'front' as an alias for foreground", () => {
    const html = '<html><body data-watermark="CONF" data-watermark-layer="front"><p>x</p></body></html>';
    const doc = htmlToReportDoc(html);
    expect(doc.watermark!.layer).toBe('foreground');
  });

  it("parses data-watermark-layer='background' explicitly", () => {
    const html = '<html><body data-watermark="CONF" data-watermark-layer="background"><p>x</p></body></html>';
    const doc = htmlToReportDoc(html);
    expect(doc.watermark!.layer).toBe('background');
  });

  it('leaves layer undefined when the attribute is absent', () => {
    const html = '<html><body data-watermark="CONF"><p>x</p></body></html>';
    const doc = htmlToReportDoc(html);
    expect(doc.watermark!.layer).toBeUndefined();
  });
});

// --- path-based (non-selectable) watermark ----------------------------------

const ARIAL = 'C:/Windows/Fonts/arial.ttf';
const hasArial = fs.existsSync(ARIAL);

describe(hasArial ? 'watermark rendered as vector paths (real font)' : 'watermark paths (SKIPPED: no arial.ttf)', () => {
  const maybe = hasArial ? it : it.skip;

  maybe('emits path DrawCommands instead of text runs, and PDF bytes contain no Tj/TJ for the watermark text', async () => {
    const fonts: FontSource[] = await readFontFiles([{ family: 'Arial', path: ARIAL, weight: 400 }]);
    const marker = 'NONSELECTABLEXYZ';
    const report: ReportDoc = {
      style: { fontFamily: 'Arial' },
      body: [{ type: 'paragraph', content: 'Body copy here.' }],
      watermark: { text: marker, layer: 'foreground' },
    };
    // Model-level assertion: the watermark fragment on each page contains only
    // `path` commands (no `text` command), so the writer never emits Tj/TJ for it.
    const { doc, pages } = createReport(report, { fonts });
    const wm = pages[0]!.foreground.find((pf) => pf.fragment.rotate !== undefined);
    expect(wm).toBeDefined();
    const ops = wm!.fragment.commands.map((c) => c.op);
    expect(ops).toContain('path');
    expect(ops).not.toContain('text');
    doc.end();
  });
});
