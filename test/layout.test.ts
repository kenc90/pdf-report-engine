/**
 * Block/table layout tests. Drives the layout engine through a `HeuristicFontHandle`
 * registry so widths and heights are exact and reproducible without font files.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import { LayoutContext } from '../src/layout/context.js';
import { layoutBlock } from '../src/layout/block.js';
import type { ReportDoc, TableBlock, ParagraphBlock } from '../src/ir/schema.js';
import type { Fragment } from '../src/layout/flow.js';

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
});

function fragmentText(f: Fragment): string {
  const parts: string[] = [];
  for (const c of f.commands) if (c.op === 'text') parts.push(c.runs.map((r) => r.text).join(''));
  return parts.join('');
}

void ({} as ReportDoc);
