/**
 * Tests for out-of-flow positioning (`position: absolute | fixed`) and
 * `zIndex`: coordinate placement, page targeting, running-token scope, the
 * behind/in-front z split, percentage resolution, and the HTML adapter mapping.
 *
 * Layout is driven through `HeuristicFontHandle` so measurements are exact and
 * reproducible without font files.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { paginate, type Page, type PlacedFragment } from '../src/pagination/engine.js';
import { htmlToReportDoc } from '../src/adapter/html.js';
import { createReport, renderToBuffer } from '../src/index.js';
import type { Block, ReportDoc } from '../src/ir/schema.js';

function makeCtx(): LayoutContext {
  const registry = new FontRegistry();
  registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
  registry.addHandle(new HeuristicFontHandle('Test', 700, 'normal'));
  const baseStyle = resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined);
  return new LayoutContext({ registry, baseStyle });
}

// A small fixed page so multi-page flow is easy to trigger.
const resolved = {
  width: 200,
  height: 100,
  margin: { top: 10, right: 10, bottom: 10, left: 10 },
  content: { x: 10, y: 10, width: 180, height: 80 },
};

function run(body: Block[], scope: Record<string, unknown> = {}): Page[] {
  return paginate({
    ctx: makeCtx(),
    page: resolved,
    contentWidth: resolved.content.width,
    body,
    bands: undefined,
    scope,
  });
}

/** Concatenated text drawn by one placed fragment. */
function placedText(pf: PlacedFragment): string {
  let out = '';
  for (const cmd of pf.fragment.commands) {
    if (cmd.op === 'text') out += cmd.runs.map((r) => r.text).join('');
  }
  return out;
}

const allText = (list: PlacedFragment[]): string => list.map(placedText).join('');

describe('position: absolute', () => {
  it('places the block at page coordinates and takes no body flow space', () => {
    const pages = run([
      { type: 'paragraph', content: 'Body one' } as Block,
      { type: 'paragraph', content: 'STAMP', position: 'absolute', left: 40, top: 25, width: 60 } as Block,
      { type: 'paragraph', content: 'Body two' } as Block,
    ]);
    const p = pages[0]!;
    // The absolute block is not part of the flowed body.
    expect(allText(p.body)).toBe('Body oneBody two');
    expect(p.absolute).toHaveLength(1);
    const stamp = p.absolute[0]!;
    expect(placedText(stamp)).toBe('STAMP');
    expect(stamp.x).toBe(40);
    expect(stamp.y).toBe(25);
    expect(stamp.z).toBe(0);
  });

  it('defaults to page 1 when no page is given', () => {
    // Enough short lines to fill more than one page.
    const filler = Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', content: `L${i}` }) as Block);
    const pages = run([
      { type: 'paragraph', content: 'P1ONLY', position: 'absolute', top: 5 } as Block,
      ...filler,
    ]);
    expect(pages.length).toBeGreaterThan(1);
    const withStamp = pages.filter((p) => allText(p.absolute).includes('P1ONLY'));
    expect(withStamp).toHaveLength(1);
    expect(withStamp[0]!.number).toBe(1);
  });

  it('honours an explicit 1-based page number', () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', content: `L${i}` }) as Block);
    const pages = run([
      ...filler,
      { type: 'paragraph', content: 'CORNER', position: 'absolute', page: 2, left: 150, top: 90 } as Block,
    ]);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const p2 = pages[1]!;
    expect(allText(p2.absolute)).toContain('CORNER');
    expect(pages[0]!.absolute.some((pf) => placedText(pf) === 'CORNER')).toBe(false);
  });

  it('resolves percentage left/top against page width/height', () => {
    const pages = run([
      { type: 'paragraph', content: 'HALF', position: 'absolute', left: '50%', top: '25%' } as Block,
    ]);
    const pf = pages[0]!.absolute[0]!;
    expect(pf.x).toBeCloseTo(100, 6); // 50% of 200
    expect(pf.y).toBeCloseTo(25, 6); // 25% of 100
  });

  it('carries zIndex and splits behind vs in front of body by sign', () => {
    const pages = run([
      { type: 'paragraph', content: 'UNDER', position: 'absolute', zIndex: -3 } as Block,
      { type: 'paragraph', content: 'OVER', position: 'absolute', zIndex: 5 } as Block,
    ]);
    const abs = pages[0]!.absolute;
    const under = abs.find((pf) => placedText(pf) === 'UNDER')!;
    const over = abs.find((pf) => placedText(pf) === 'OVER')!;
    expect(under.z).toBe(-3);
    expect(over.z).toBe(5);
  });
});

describe('position: fixed', () => {
  it('repeats on every page', () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', content: `L${i}` }) as Block);
    const pages = run([
      { type: 'paragraph', content: 'RUNNING', position: 'fixed', left: 80, top: 4 } as Block,
      ...filler,
    ]);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(allText(p.absolute)).toContain('RUNNING');
  });

  it('resolves running tokens against each page scope', () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', content: `L${i}` }) as Block);
    const pages = run(
      [{ type: 'paragraph', content: ['Page ', { bind: '$page.number' }], position: 'fixed', top: 2 } as Block, ...filler],
    );
    expect(pages.length).toBeGreaterThan(1);
    expect(allText(pages[0]!.absolute)).toContain('Page 1');
    expect(allText(pages[1]!.absolute)).toContain('Page 2');
  });
});

describe('HTML adapter positioning', () => {
  it('maps position/left/top/z-index and data-page from CSS', () => {
    const report = htmlToReportDoc(
      '<div style="position: absolute; left: 20pt; top: 10pt; z-index: 3" data-page="2">Stamp</div>' +
        '<p>Body</p>',
    );
    const stamp = report.body!.find((b) => b.position === 'absolute')!;
    expect(stamp).toBeDefined();
    expect(stamp.left).toBe('20pt');
    expect(stamp.top).toBe('10pt');
    expect(stamp.zIndex).toBe(3);
    expect(stamp.page).toBe(2);
  });

  it('treats position: fixed as page "all" placement', () => {
    const report = htmlToReportDoc('<div style="position: fixed; top: 0">Run</div>');
    const run = report.body!.find((b) => b.position === 'fixed')!;
    expect(run).toBeDefined();
    // No data-page: page stays undefined, and the engine repeats fixed on all pages.
    expect(run.page).toBeUndefined();
  });

  it('leaves static/relative blocks in the normal flow', () => {
    const report = htmlToReportDoc('<div style="position: relative">X</div>');
    expect(report.body!.some((b) => b.position !== undefined)).toBe(false);
  });
});

describe('end-to-end render', () => {
  it('produces a non-empty PDF with an absolute block present', async () => {
    const report: ReportDoc = {
      page: { size: [200, 100], margin: 10 },
      body: [
        { type: 'paragraph', content: 'Flowing body text' },
        { type: 'paragraph', content: 'CORNER', position: 'absolute', left: 150, top: 90, fontSize: 6 },
      ],
    };
    const bytes = await renderToBuffer(report);
    expect(bytes.length).toBeGreaterThan(200);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('createReport exposes positioned overlays on the page model', () => {
    const { pages } = createReport({
      page: { size: [200, 100], margin: 10 },
      body: [{ type: 'paragraph', content: 'STAMP', position: 'absolute', left: 30, top: 40 }],
    });
    expect(pages[0]!.absolute).toHaveLength(1);
    expect(pages[0]!.absolute[0]!.x).toBe(30);
    expect(pages[0]!.absolute[0]!.y).toBe(40);
  });
});
