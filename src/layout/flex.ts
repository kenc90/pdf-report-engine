/**
 * CSS flexbox (subset) layout.
 *
 * A `FlexBlock` is laid out as one atomic fragment: its children are ordinary
 * flow blocks measured along the main axis, distributed with `flex-grow` /
 * `flex-shrink` / `flex-basis` (plus a max-content measure for items that declare
 * no size), positioned by `justify-content`, cross-aligned by `align-items` /
 * `align-self`, and spaced by `gap`. Nested fragments are translated into
 * container space, so this composes with every other block (a flex box can hold
 * text, images, SVG, charts or another flex box).
 *
 * Modelled: `direction` row/column, `wrap` (row), all six `justify-content`
 * values, `align-items` including `stretch`, and per-line `row-gap`/`column-gap`.
 * Not modelled: `order`, `min/max` clamping beyond the shrink floor, and baseline
 * alignment.
 */
import type { Block, FlexBlock, FlexItem } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import { toPt } from '../core/units.js';
import { toRGB } from '../core/color.js';
import type { LayoutContext } from './context.js';
import { layoutBlock, type BlockLayoutOptions } from './block.js';
import { resolveBox } from './box.js';
import { translateCommands, type DrawCommand, type Fragment } from './flow.js';

/** Effectively infinite main axis: used to read a child's max-content width. */
const BIG = 1_000_000;

type JustifyMode = NonNullable<FlexBlock['justify']>;
type AlignMode = NonNullable<FlexBlock['alignItems']>;

function resolveLength(value: number | string | undefined, ref: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const trimmed = String(value).trim();
  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed);
    return Number.isFinite(pct) ? (pct / 100) * ref : undefined;
  }
  return toPt(trimmed);
}

interface Extent {
  width: number;
  height: number;
}

/** Bounding size of a run of fragments (main-axis cross measures). */
function measureFrags(frags: Fragment[]): Extent {
  let width = 0;
  let height = 0;
  for (const f of frags) {
    height += f.before + f.height + f.after;
    for (const c of f.commands) width = Math.max(width, commandRight(c));
  }
  return { width, height };
}

function commandRight(c: DrawCommand): number {
  switch (c.op) {
    case 'fillRect':
    case 'strokeRect':
    case 'image':
      return c.x + c.w;
    case 'line':
      return Math.max(c.x1, c.x2);
    case 'underline':
      return c.x2;
    case 'poly':
      return c.points.reduce((m, p) => Math.max(m, p[0]), 0);
    case 'path':
      return c.subpaths.reduce((m, sp) => sp.points.reduce((mm, p) => Math.max(mm, p[0]), m), 0);
    case 'text': {
      const last = c.runs[c.runs.length - 1];
      return last ? c.x + last.x + last.width + c.gapWidth * (c.runs.length - 1) : c.x;
    }
    default:
      return 0;
  }
}

interface ItemMeasure {
  item: FlexItem;
  block: Block;
  /** Resolved base size along the main axis before grow/shrink. */
  base: number;
  grow: number;
  shrink: number;
  /** Cross size (height for a row) after the item is laid out at its final size. */
  cross: number;
  frags: Fragment[];
}

/** Background colour declared on the flex item, else on its wrapped block. */
function itemBackground(item: FlexItem): ResolvedStyle['backgroundColor'] | undefined {
  return item.backgroundColor ?? (item.block as { backgroundColor?: ResolvedStyle['backgroundColor'] }).backgroundColor;
}

export function layoutFlex(
  block: FlexBlock,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
): Fragment[] {
  const { margin, padding } = resolveBox(block);
  const innerW = Math.max(1, opts.contentWidth - margin.left - margin.right - padding.left - padding.right);
  const colGap = resolveLength(block.columnGap ?? block.gap, innerW) ?? 0;
  const rowGap = resolveLength(block.rowGap ?? block.gap, innerW) ?? 0;
  const dir = block.direction ?? 'row';
  const justifyMode: JustifyMode = block.justify ?? 'flex-start';
  const alignMode: AlignMode = block.alignItems ?? 'stretch';
  const style = ctx.style(block, inherited);

  const lines = dir === 'row' && block.wrap ? groupWrapLines(block.children, colGap, innerW, ctx, opts) : [block.children];

  const commands: DrawCommand[] = [];
  const originX = margin.left + padding.left;
  let cursorY = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const placed =
      dir === 'row'
        ? layoutRowLine(line, ctx, opts, innerW, colGap, justifyMode, alignMode)
        : layoutColumnLine(line, ctx, opts, innerW, rowGap, alignMode);
    for (const c of placed.commands) commands.push(translateOne(c, originX, cursorY));
    cursorY += placed.cross;
    if (i < lines.length - 1) cursorY += rowGap;
  }
  const contentH = cursorY;

  const boxW = innerW + padding.left + padding.right;
  const framed: DrawCommand[] = [];
  if (style.backgroundColor !== undefined) {
    framed.push({ op: 'fillRect', x: margin.left, y: 0, w: boxW, h: contentH + padding.top + padding.bottom, color: toRGB(style.backgroundColor) });
  }
  framed.push(...commands.map((c) => translateOne(c, 0, padding.top)));

  return [
    {
      height: contentH + padding.top + padding.bottom,
      before: margin.top,
      after: margin.bottom,
      commands: framed,
      avoidSplit: true,
      breakBefore: block.breakBefore,
      breakAfter: block.breakAfter,
      keepWithNext: block.keepWithNext,
    },
  ];
}

// --- row -------------------------------------------------------------------

function groupWrapLines(items: FlexItem[], gap: number, innerW: number, ctx: LayoutContext, opts: BlockLayoutOptions): FlexItem[][] {
  const lines: FlexItem[][] = [];
  let line: FlexItem[] = [];
  let used = 0;
  for (const item of items) {
    const base = itemBase(item, 'row', innerW, ctx, opts);
    const add = base + (line.length ? gap : 0);
    if (line.length > 0 && used + add > innerW) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(item);
    used += base + (line.length > 1 ? gap : 0);
  }
  if (line.length) lines.push(line);
  return lines;
}

function layoutRowLine(
  items: FlexItem[],
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  innerW: number,
  gap: number,
  justifyMode: JustifyMode,
  alignMode: AlignMode,
): { commands: DrawCommand[]; cross: number } {
  if (items.length === 0) return { commands: [], cross: 0 };
  const measures: ItemMeasure[] = items.map((item) => {
    const base = itemBase(item, 'row', innerW, ctx, opts);
    return { item, block: item.block, base, grow: item.grow ?? 0, shrink: item.shrink ?? (base > 0 ? 1 : 0), cross: 0, frags: [] };
  });
  // `free` is the space left *after* the items' base sizes and the gaps: positive
  // space to grow into, negative to shrink away. Passing the raw available width
  // (without subtracting the bases) would let grow items balloon past the box.
  const sumBases = measures.reduce((s, m) => s + m.base, 0);
  distribute(measures, innerW - gap * (items.length - 1) - sumBases);

  // Lay each item at its final main width and read its cross (content) height.
  for (const m of measures) {
    const width = Math.max(1, m.base);
    m.frags = layoutBlock(m.block, ctx, { contentWidth: width, scope: opts.scope, inherited: undefined });
    m.cross = measureFrags(m.frags).height;
  }
  const lineCross = Math.max(1, ...measures.map((m) => m.cross));

  // Justify the free main space.
  const totalMain = measures.reduce((s, m) => s + m.base, 0) + gap * (items.length - 1);
  const leftover = Math.max(0, innerW - totalMain);
  const { start, spacing } = justify(justifyMode, leftover, items.length, gap);

  const commands: DrawCommand[] = [];
  let x = start;
  for (const m of measures) {
    const mode: AlignMode = m.item.alignSelf && m.item.alignSelf !== 'auto' ? (m.item.alignSelf as AlignMode) : alignMode;
    const dy = crossOffset(lineCross, m.cross, mode);
    // `stretch`: paint the item's background across the full line height.
    if (mode === 'stretch') {
      const bg = itemBackground(m.item);
      if (bg !== undefined) commands.push({ op: 'fillRect', x, y: 0, w: m.base, h: lineCross, color: toRGB(bg) });
    }
    for (const f of m.frags) for (const c of f.commands) commands.push(translateOne(c, x, dy + f.before));
    x += m.base + spacing;
  }
  return { commands, cross: lineCross };
}

// --- column ----------------------------------------------------------------

function layoutColumnLine(
  items: FlexItem[],
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  innerW: number,
  gap: number,
  alignMode: AlignMode,
): { commands: DrawCommand[]; cross: number } {
  if (items.length === 0) return { commands: [], cross: 0 };
  const measures: ItemMeasure[] = items.map((item) => {
    const width = resolveLength(item.width, innerW) ?? (item.basis !== undefined ? resolveLength(item.basis, innerW) : undefined) ?? innerW;
    const frags = layoutBlock(item.block, ctx, { contentWidth: Math.max(1, width), scope: opts.scope, inherited: undefined });
    const ext = measureFrags(frags);
    return { item, block: item.block, base: ext.height, grow: item.grow ?? 0, shrink: 0, cross: width, frags };
  });

  const commands: DrawCommand[] = [];
  let y = 0;
  for (const m of measures) {
    const w = resolveLength(m.item.width, innerW) ?? innerW;
    const mode: AlignMode = m.item.alignSelf && m.item.alignSelf !== 'auto' ? (m.item.alignSelf as AlignMode) : alignMode;
    // In a column, the cross axis is horizontal; `stretch` fills the full width.
    const dx = mode === 'center' ? (innerW - m.cross) / 2 : mode === 'flex-end' ? innerW - w : 0;
    for (const f of m.frags) for (const c of f.commands) commands.push(translateOne(c, dx, y + f.before));
    y += m.base + gap;
  }
  return { commands, cross: Math.max(0, y - gap) };
}

// --- shared sizing ---------------------------------------------------------

/** Base main size: `basis`, else a declared width/height, else content measure. */
function itemBase(item: FlexItem, dir: 'row' | 'column', innerW: number, ctx?: LayoutContext, opts?: BlockLayoutOptions): number {
  const basis = resolveLength(item.basis, innerW);
  if (basis !== undefined) return basis;
  if (dir === 'row') {
    const w = resolveLength(item.width, innerW);
    if (w !== undefined) return w;
    if (ctx && opts) {
      return measureFrags(layoutBlock(item.block, ctx, { contentWidth: BIG, scope: opts.scope, inherited: undefined })).width;
    }
    return innerW / 3;
  }
  const h = resolveLength(item.height, innerW);
  if (h !== undefined) return h;
  return innerW / 3;
}

/**
 * Apply `flex-grow` then `flex-shrink` in place against the available free space.
 * A positive `free` distributes leftover to growers; a negative one shrinks
 * shrinkers proportionally to `shrink × base` (floored at zero).
 */
function distribute(measures: ItemMeasure[], free: number): void {
  const growSum = measures.reduce((s, m) => s + Math.max(0, m.grow), 0);
  if (free > 0 && growSum > 0) {
    for (const m of measures) if (m.grow > 0) m.base += (free * m.grow) / growSum;
    return;
  }
  if (free < 0) {
    const weighted = measures.reduce((s, m) => s + Math.max(0, m.shrink) * m.base, 0);
    if (weighted > 0) {
      const overflow = -free;
      for (const m of measures) if (m.shrink > 0) m.base = Math.max(0, m.base - (overflow * m.shrink * m.base) / weighted);
    }
  }
}

/** Resolve a `justify-content` free-space distribution into a start offset and spacing. */
function justify(mode: JustifyMode, free: number, count: number, gap: number): { start: number; spacing: number } {
  if (count <= 0) return { start: 0, spacing: gap };
  switch (mode) {
    case 'center':
      return { start: free / 2, spacing: gap };
    case 'flex-end':
      return { start: free, spacing: gap };
    case 'space-between':
      return count > 1 ? { start: 0, spacing: gap + free / (count - 1) } : { start: 0, spacing: gap };
    case 'space-around': {
      const each = free / count;
      return { start: each / 2, spacing: gap + each };
    }
    case 'space-evenly': {
      const each = free / (count + 1);
      return { start: each, spacing: gap + each };
    }
    default:
      return { start: 0, spacing: gap };
  }
}

function crossOffset(lineCross: number, cross: number, mode: AlignMode): number {
  switch (mode) {
    case 'center':
      return (lineCross - cross) / 2;
    case 'flex-end':
      return lineCross - cross;
    default:
      return 0;
  }
}

function translateOne(cmd: DrawCommand, dx: number, dy: number): DrawCommand {
  return translateCommands([cmd], dx, dy)[0]!;
}
