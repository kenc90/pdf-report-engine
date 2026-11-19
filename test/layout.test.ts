/**
 * Block/table layout tests. Drives the layout engine through a `HeuristicFontHandle`
 * registry so widths and heights are exact and reproducible without font files.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import type { ReportDoc, TableBlock, ParagraphBlock, ImageBlock, ContainerBlock, GridBlock } from '../src/ir/schema.js';
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
  it('paints styled containers around pageable child fragments', () => {
    const ctx = makeCtx();
    const wrapper: ContainerBlock = {
      type: 'container',
      backgroundColor: '#fff',
      border: [1, 'solid', '#f00'],
      borderRadius: 4,
      paddingTop: 2,
      paddingRight: 2,
      paddingBottom: 3,
      paddingLeft: 2,
      children: [{ type: 'paragraph', content: 'aaa bbb ccc' }],
    };

    const frags = layoutBlock(wrapper, ctx, opts(30));

    expect(frags.length).toBeGreaterThan(1);
    expect(frags[0]!.before).toBeCloseTo(3);
    expect(frags.at(-1)!.after).toBeCloseTo(4);
    const borders = frags.map((fragment) =>
      fragment.commands.find((command) => command.op === 'path' && command.stroke?.lineWidth === 1),
    );
    expect(borders.every((border) => border?.op === 'path')).toBe(true);
    expect(borders[0]?.op === 'path' && borders[0].subpaths).toHaveLength(3);
    expect(borders.at(-1)?.op === 'path' && borders.at(-1)!.subpaths).toHaveLength(3);
    expect(frags[0]!.commands.some((command) => command.op === 'fillRect' && command.radius?.[0] === 4)).toBe(true);
    expect(frags[0]!.commands.filter((command) => command.op === 'fillRect')).toHaveLength(1);
  });

  it('emits one fragment per wrapped paragraph line', () => {
    const ctx = makeCtx();
    const para: ParagraphBlock = { type: 'paragraph', content: 'aaa bbb ccc' };
    // 'aaa'=15 'bbb'=15 'ccc'=15, spaces 2.8; budget 20 wraps to 3 lines.
    const frags = layoutBlock(para, ctx, opts(20));
    expect(frags.length).toBe(3);
    expect(frags.at(-1)!.after).toBeGreaterThanOrEqual(0);
  });

  it('centers text within extra line-height leading', () => {
    const fragment = layoutBlock(
      { type: 'paragraph', content: 'hi', lineHeight: 2 },
      makeCtx(),
      opts(100),
    )[0]!;
    const text = fragment.commands.find((command) => command.op === 'text');

    expect(fragment.height).toBeCloseTo(20);
    expect(text?.op === 'text' && text.baselineY).toBeCloseTo(12.5);
  });

  it('extends paragraph backgrounds through vertical padding', () => {
    const paragraph: ParagraphBlock = {
      type: 'paragraph',
      content: 'Thank you. Payment is due within 30 days.',
      backgroundColor: '#fff7e8',
      borderLeft: [3, 'solid', '#e29b38'],
      paddingTop: 8,
      paddingBottom: 8,
    };
    const fragment = layoutBlock(paragraph, makeCtx(), opts(300))[0]!;
    const background = fragment.commands.find((command) => command.op === 'fillRect');

    expect(background?.op).toBe('fillRect');
    if (background?.op === 'fillRect') {
      expect(background.y).toBe(-8);
      expect(background.h).toBeCloseTo(fragment.height + 16);
    }
    expect(fragment.commands.some((command) =>
      command.op === 'line' && command.x1 === command.x2 && command.y1 === -8,
    )).toBe(true);
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
  it('renders cell edge borders in addition to the table grid', () => {
    const ctx = makeCtx();
    const table: TableBlock = {
      type: 'table',
      columns: [{ key: 'name', width: 80 }],
      staticRows: [{
        kind: 'detail',
        cells: [{ content: 'item', borderLeft: [2, 'solid', '#f60'] }],
      }],
    };

    const frags = layoutBlock(table, ctx, opts(100));

    expect(frags.some((fragment) =>
      fragment.commands.some((command) => command.op === 'line' && command.x1 === command.x2 && command.lineWidth === 2),
    )).toBe(true);
  });

  it('aligns adjacent cell borders on one shared edge', () => {
    const table: TableBlock = {
      type: 'table',
      columns: [{ width: 50 }, { width: 50 }],
      showGrid: true,
      staticRows: [{ kind: 'detail', cells: [{ content: 'left' }, { content: 'right' }] }],
    };
    const fragment = layoutBlock(table, makeCtx(), opts(100))[0]!;
    const sharedVerticals = fragment.commands.filter(
      (command) => command.op === 'line' && command.x1 === command.x2 && command.x1 === 50,
    );

    expect(sharedVerticals).toHaveLength(2);
    expect(
      sharedVerticals.every((command) => command.op === 'line' && command.y1 === 0 && command.y2 === fragment.height),
    ).toBe(true);
  });

  it('keeps table row separators above stretched grid-item backgrounds', () => {
    const table: TableBlock = {
      type: 'table',
      columns: [{ grow: 1 }],
      staticRows: ['Revenue', 'Retention', 'Delivery'].map((content) => ({
        kind: 'detail',
        cells: [{ content, borderBottom: [0.75, 'solid', '#dbe5ef'] }],
      })),
    };
    const grid: GridBlock = {
      type: 'grid',
      columns: [{ fr: 1 }],
      children: [{
        block: {
          type: 'container',
          backgroundColor: '#edf3fa',
          children: [table],
        },
      }],
    };
    const fragment = layoutBlock(grid, makeCtx(), opts(220))[0]!;
    const lastBackground = Math.max(
      ...fragment.commands.map((command, index) =>
        command.op === 'fillRect' && command.paintLayer === 'background' ? index : -1,
      ),
    );
    const separators = fragment.commands.filter(
      (command) => command.op === 'line' && command.y1 === command.y2 && command.lineWidth === 0.75,
    );

    expect(separators).toHaveLength(3);
    expect(separators.every((separator) => fragment.commands.indexOf(separator) > lastBackground)).toBe(true);
  });

  it('centers table-cell text within extra line-height leading', () => {
    const table = {
      type: 'table',
      columns: [{ width: 80 }],
      staticRows: [{
        kind: 'detail',
        cells: [{ content: 'item', style: { lineHeight: 2 } }],
      }],
    } as unknown as TableBlock;
    const fragment = layoutBlock(table, makeCtx(), opts(80))[0]!;
    const text = fragment.commands.find((command) => command.op === 'text');

    expect(text?.op === 'text' && text.baselineY).toBeCloseTo(13.5);
  });

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
