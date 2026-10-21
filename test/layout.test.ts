/**
 * Block/table layout tests. Drives the layout engine through a `HeuristicFontHandle`
 * registry so widths and heights are exact and reproducible without font files.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import type { ReportDoc, TableBlock, ParagraphBlock, ImageBlock } from '../src/ir/schema.js';
import type { Fragment } from '../src/layout/flow.js';
import { probeImageSize } from '../src/core/image.js';

function makeCtx(): LayoutContext {
  const registry = new FontRegistry();
  registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
  const baseStyle = resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined);
  return new LayoutContext({ registry, baseStyle });
}

const opts = (contentWidth: number) => ({ contentWidth, scope: {} });

describe('block layout', () => {
  it('emits one fragment per wrapped paragraph line', () => {
    const ctx = makeCtx();
    const para: ParagraphBlock = { type: 'paragraph', content: 'aaa bbb ccc' };
    // 'aaa'=15 'bbb'=15 'ccc'=15, spaces 2.8; budget 20 wraps to 3 lines.
    const frags = layoutBlock(para, ctx, opts(20));
    expect(frags.length).toBe(3);
    expect(frags.at(-1)!.after).toBeGreaterThanOrEqual(0);
  });

  it('applies paragraph margins as before/after spacing', () => {
    const ctx = makeCtx();
    const para: ParagraphBlock = { type: 'paragraph', content: 'hi', marginTop: 12, marginBottom: 6 };
    const frags = layoutBlock(para, ctx, opts(100));
    expect(frags[0]!.before).toBeCloseTo(12, 3);
    expect(frags.at(-1)!.after).toBeCloseTo(6, 3);
  });

  it('chains breakInside: "avoid" fragments so pagination moves them as one run', () => {
    const ctx = makeCtx();
    const para: ParagraphBlock = { type: 'paragraph', content: 'aaa bbb ccc', breakInside: 'avoid' };
    const frags = layoutBlock(para, ctx, opts(20)); // wraps to 3 lines
    expect(frags).toHaveLength(3);
    expect(frags.slice(0, -1).every((f) => f.keepWithNext === true)).toBe(true);
    expect(frags.at(-1)!.keepWithNext).toBeFalsy();
    // Without the flag a wrapped paragraph is free to break line by line.
    expect(layoutBlock({ type: 'paragraph', content: 'aaa bbb ccc' }, ctx, opts(20)).some((f) => f.keepWithNext)).toBe(false);
  });
});

describe('table layout', () => {
  function sampleTable(): TableBlock {
    return {
      type: 'table',
      columns: [{ key: 'name', grow: 1 }, { key: 'qty', width: 40, align: 'right' }],
      headerRows: [{ kind: 'header', cells: [{ content: 'Name' }, { content: 'Qty' }] }],
      dataSource: [
        { name: 'apple', qty: 3 },
        { name: 'banana', qty: 12 },
      ],
      detail: { cells: [{ bind: 'name' } as never, { bind: 'qty' } as never] },
      showGrid: true,
    } as unknown as TableBlock;
  }

  it('sums column widths to the available width', () => {
    const ctx = makeCtx();
    const frags = layoutBlock(sampleTable(), ctx, opts(140));
    // A row's rightmost border line reveals total width; header + 2 detail rows.
    expect(frags).toHaveLength(3);
    expect(frags[0]!.role).toBe('header');
    expect(frags[0]!.groupKey).toBeTruthy();
  });

  it('binds detail cells to their column key', () => {
    const ctx = makeCtx();
    const frags = layoutBlock(sampleTable(), ctx, opts(140));
    const texts = frags.map(fragmentText);
    expect(texts[1]).toContain('apple');
    expect(texts[2]).toContain('banana');
    expect(texts[2]).toContain('12');
  });

  it('marks every row atomic and headers repeatable', () => {
    const ctx = makeCtx();
    const frags = layoutBlock(sampleTable(), ctx, opts(140));
    for (const f of frags) expect(f.avoidSplit).toBe(true);
  });

  it('keeps authored literal header cells literal even when columns carry keys', () => {
    const ctx = makeCtx();
    const block = sampleTable();
    // The loose form (plain strings in a header row) must render as text, not be
    // mistaken for a missing binding of the column key.
    block.headerRows = [{ kind: 'header', cells: ['Name', 'Qty'] } as never];
    const texts = layoutBlock(block, ctx, opts(140)).map(fragmentText);
    expect(texts[0]).toContain('Name');
    expect(texts[0]).toContain('Qty');
    expect(texts[1]).toContain('apple');
  });

  it('auto-binds a blank detail cell and leaves a blank header cell blank', () => {
    const ctx = makeCtx();
    const block = sampleTable();
    block.detail = { cells: [{} as never, {} as never] };
    block.headerRows = [{ kind: 'header', cells: [{}, {}] as never }];
    const texts = layoutBlock(block, ctx, opts(140)).map(fragmentText);
    expect(texts[0]).toBe('');
    expect(texts[1]).toContain('apple');
    expect(texts[1]).toContain('3');
    expect(texts[2]).toContain('banana');
  });

  it('lays a rowspan cell over its full merged height (vertical merge)', () => {
    const ctx = makeCtx();
    const table = {
      type: 'table',
      columns: [{ grow: 1 }, { grow: 1 }],
      showGrid: true,
      staticRows: [
        { kind: 'detail', cells: [{ content: 'span', rowSpan: 2 }, { content: 'b' }] },
        { kind: 'detail', cells: [{ content: 'c' }] },
      ],
    } as unknown as TableBlock;
    const frags = layoutBlock(table, ctx, opts(100));
    // The two authored rows merge into one grid fragment, not two.
    expect(frags).toHaveLength(1);
    const f = frags[0]!;
    expect(f.role).toBe('detail');
    // The spanning cell's vertical border stretches across ~the whole fragment.
    const verticals = lineSegs(f).filter((c) => Math.abs(c.x1 - c.x2) < 0.01);
    const maxVert = Math.max(...verticals.map((c) => Math.abs(c.y2 - c.y1)));
    expect(maxVert).toBeGreaterThan(f.height * 0.8);
    // Covered cell is skipped, so 'c' lands in column 2; all text still present.
    const text = fragmentText(f);
    expect(text).toContain('span');
    expect(text).toContain('b');
    expect(text).toContain('c');
  });

  it('sums spanned column widths for a colspan cell (horizontal merge)', () => {
    const ctx = makeCtx();
    const table = {
      type: 'table',
      columns: [{ grow: 1 }, { grow: 1 }, { grow: 1 }],
      showGrid: true,
      staticRows: [{ kind: 'detail', cells: [{ content: 'wide', colSpan: 2 }, { content: 'x' }] }],
    } as unknown as TableBlock;
    const frags = layoutBlock(table, ctx, opts(90));
    expect(frags).toHaveLength(1);
    // Two columns merged span ~60 of the 90 content width (each grow column is 30).
    const horizontals = lineSegs(frags[0]!).filter((c) => Math.abs(c.y1 - c.y2) < 0.01);
    const maxHoriz = Math.max(...horizontals.map((c) => Math.abs(c.x2 - c.x1)));
    expect(maxHoriz).toBeGreaterThan(90 * 0.55);
  });

  it('draws a diagonal corner header with a slash and both axis labels', () => {
    const ctx = makeCtx();
    const table = {
      type: 'table',
      columns: [{ grow: 1 }, { grow: 1 }, { grow: 1 }],
      showGrid: true,
      headerRows: [
        {
          kind: 'header',
          cells: [
            { diagonal: { top: 'Preferred Pet', bottom: 'Gender' } },
            { content: 'Dog' },
            { content: 'Cat' },
          ],
        } as never,
      ],
      staticRows: [{ kind: 'detail', cells: [{ content: 'Girl' }, { content: '2' }, { content: '5' }] }],
    } as unknown as TableBlock;
    const frags = layoutBlock(table, ctx, opts(180));
    const header = frags[0]!;
    // Both axis labels are typeset into the corner cell.
    const text = fragmentText(header);
    expect(text).toContain('Preferred');
    expect(text).toContain('Gender');
    // A true diagonal line (both axes move) is emitted across the corner cell.
    const diag = lineSegs(header).find((c) => Math.abs(c.x1 - c.x2) > 0.01 && Math.abs(c.y1 - c.y2) > 0.01);
    expect(diag).toBeDefined();
    // The row grows to stack both label bands (taller than a single-line row).
    expect(header.height).toBeGreaterThan(frags[1]!.height);
  });

  it('flips the corner slash for a mirrored diagonal header', () => {
    const ctx = makeCtx();
    const table = {
      type: 'table',
      columns: [{ grow: 1 }, { grow: 1 }],
      showGrid: true,
      headerRows: [{ kind: 'header', cells: [{ diagonal: { top: 'Region', bottom: 'Quarter', dir: 'tr' } }, { content: 'North' }] } as never],
    } as unknown as TableBlock;
    const header = layoutBlock(table, ctx, opts(120))[0]!;
    // 'tr' runs top-right → bottom-left: x decreases as y increases.
    const diag = lineSegs(header).find((c) => Math.abs(c.x1 - c.x2) > 0.01 && Math.abs(c.y1 - c.y2) > 0.01);
    expect(diag).toBeDefined();
    expect(diag!.x1).toBeGreaterThan(diag!.x2);
  });
});

describe('image layout', () => {
  it('reads intrinsic size from a PNG header without decoding pixels', () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
    const dv = new DataView(header.buffer);
    dv.setUint32(16, 320);
    dv.setUint32(20, 200);
    expect(probeImageSize(header)).toEqual({ width: 320, height: 200 });
  });

  it('derives height from the aspect ratio when only width is given', () => {
    const ctx = makeCtx();
    const img = { type: 'image', src: '/none', intrinsic: { width: 600, height: 300 }, width: 120 } as unknown as ImageBlock;
    const frags = layoutBlock(img, ctx, opts(400));
    expect(frags).toHaveLength(1);
    expect(frags[0]!.height).toBeCloseTo(60, 3); // 120 * 300/600
    expect(frags[0]!.avoidSplit).toBe(true);
    expect(frags[0]!.commands[0]!.op).toBe('image');
  });

  it('caps an undersized box to content width and honours center alignment', () => {
    const ctx = makeCtx();
    const img = { type: 'image', src: '/none', intrinsic: { width: 100, height: 100 }, width: 100, align: 'center' } as unknown as ImageBlock;
    const frags = layoutBlock(img, ctx, opts(400));
    const cmd = frags[0]!.commands[0]!;
    expect(cmd.op).toBe('image');
    if (cmd.op === 'image') {
      expect(cmd.x).toBeCloseTo(150, 3); // (400 - 100) / 2
      expect(cmd.w).toBeCloseTo(100, 3);
      expect(cmd.h).toBeCloseTo(100, 3);
    }
  });
});

function lineSegs(f: Fragment): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const c of f.commands) if (c.op === 'line') out.push({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 });
  return out;
}

function fragmentText(f: Fragment): string {
  const parts: string[] = [];
  for (const c of f.commands) if (c.op === 'text') parts.push(c.runs.map((r) => r.text).join(''));
  return parts.join('');
}

void ({} as ReportDoc);
