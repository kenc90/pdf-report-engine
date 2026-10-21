/**
 * Table layout: resolve column widths, lay out every row/cell into a single
 * page-agnostic `Fragment` per row, and emit the pieces pagination needs to
 * repeat headers and honour group page breaks.
 *
 * Column sizing follows the contract report authors expect:
 *   - a numeric/`%` `width` is honoured exactly;
 *   - leftover space is split among `grow` columns by weight;
 *   - no column drops below its `minWidth`, computed by measuring real glyph
 *     advances of the widest unbreakable token so a "99,999" never splits.
 *
 * Cells wrap independently and a row is exactly as tall as its tallest cell.
 */
import type {
  TableBlock,
  ColumnNode,
  RowNode,
  CellNode,
  CellContent,
  Content,
  GroupNode,
  StyleProps,
  BorderShorthand,
  ResolvedBorder,
  ColorScale,
  Block,
} from '../ir/schema.js';
import { exprSource, type ExprContext } from '../expr/eval.js';
import { toPt } from '../core/units.js';
import { toRGB, type ColorInput, type RGB } from '../core/color.js';
import { resolveContent, type LayoutContext } from './context.js';
import { typeset, type Line, type InlineSource } from '../text/typeset.js';
import type { ResolvedStyle } from '../text/style.js';
import { findBreaks } from '../text/linebreak.js';
import { resolveBox, parseBorder, borderRGB, borderDash, type Sides } from './box.js';
import { translateCommands, type Fragment, type DrawCommand } from './flow.js';
import { getPath, aggregate } from '../expr/functions.js';
import { layoutBlock, type BlockLayoutOptions } from './block.js';
import { applyConditions, isVisible, scaleFillFor } from './condition.js';

const CELL_PAD = { top: 1, right: 3, bottom: 1, left: 3 };

interface ResolvedColumn {
  width: number;
  align: 'left' | 'center' | 'right' | 'justify';
  style?: Partial<StyleProps>;
  key?: string;
  colorScale?: ColorScale;
  /** Numeric domain derived from the column's data when the scale omits min/max. */
  range?: { min: number; max: number };
}

type Unit =
  | { t: 'header'; row: RowNode }
  | { t: 'footer'; row: RowNode }
  | { t: 'detail'; row: RowNode; data: Record<string, unknown>; index: number; static?: boolean }
  | { t: 'groupHeader'; group: GroupNode; value: unknown; rows: Array<Record<string, unknown>>; pageBreak: boolean; resetPage: boolean }
  | { t: 'groupFooter'; group: GroupNode; value: unknown; rows: Array<Record<string, unknown>> };

type RowUnit = Extract<Unit, { t: 'header' | 'footer' | 'detail' }>;

interface UnitCtx {
  block: TableBlock;
  ctx: LayoutContext;
  columns: ResolvedColumn[];
  tableStyle: ResolvedStyle;
  margin: ReturnType<typeof resolveBox>['margin'];
  contentLeft: number;
  grid: GridSpec;
  groupKey: string;
  scope: ExprContext;
}

interface GridSpec {
  border: ResolvedBorder | undefined;
  stripedColor: ColorInput | undefined;
}

export function layoutTable(block: TableBlock, ctx: LayoutContext, opts: BlockLayoutOptions, inherited: ResolvedStyle): Fragment[] {
  const { margin } = resolveBox(block);
  const tableStyle = ctx.style(block as StyleProps, inherited);
  const availW = Math.max(1, opts.contentWidth - margin.left - margin.right);

  const units = buildUnits(block, ctx, opts.scope);
  const columns = resolveColumns(block, units, availW, ctx, tableStyle, opts.scope);
  const grid = resolveGrid(block);
  const groupKey = block.id ?? `table:${tableSeq++}`;

  const uc: UnitCtx = { block, ctx, columns, tableStyle, margin, contentLeft: margin.left, grid, groupKey, scope: opts.scope };

  const frags: Fragment[] = [];
  let i = 0;
  while (i < units.length) {
    const unit = units[i]!;
    if (unit.t === 'groupHeader' || unit.t === 'groupFooter') {
      frags.push(...layoutGroupBand(unit, uc));
      i += 1;
      continue;
    }
    // Gather a maximal run of consecutive row units (header/detail/footer).
    const run: RowUnit[] = [];
    let j = i;
    while (j < units.length) {
      const u = units[j]!;
      if (u.t === 'groupHeader' || u.t === 'groupFooter') break;
      run.push(u as RowUnit);
      j += 1;
    }
    // Rows that vertically merge must be laid out together as one grid, since a
    // spanning cell is taller than a single row. Runs without vertical spans keep
    // the per-row path (so headers repeat and rows break across pages normally).
    if (runNeedsMerge(run)) {
      frags.push(layoutMergedRun(run, uc, frags.length === 0));
    } else {
      for (let k = 0; k < run.length; k += 1) frags.push(layoutRow(run[k]!, uc, frags.length === 0 && k === 0));
    }
    i = j;
  }
  return frags;
}

let tableSeq = 0;

// --- column sizing ---------------------------------------------------------

function resolveColumns(
  block: TableBlock,
  units: Unit[],
  availW: number,
  ctx: LayoutContext,
  tableStyle: ResolvedStyle,
  scope: ExprContext,
): ResolvedColumn[] {
  const declared: ColumnNode[] = block.columns ?? [];
  let n = declared.length;
  for (const u of units) {
    if (u.t === 'groupHeader' || u.t === 'groupFooter') continue;
    n = Math.max(n, u.row.cells.length);
  }
  n = Math.max(n, 1);

  const minWidths: number[] = [];
  const declaredWidths: Array<number | undefined> = [];
  const grows: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const spec = declared[i];
    const colStyle = ctx.style(spec?.style, tableStyle);
    const min = widestToken(sampleTexts(units, i), colStyle);
    minWidths.push(Math.max(spec?.minWidth ? toPt(spec.minWidth) : 0, min));
    declaredWidths.push(spec?.width !== undefined ? toPt(spec.width) : undefined);
    grows.push(spec?.grow ?? (spec?.width === undefined ? 1 : 0));
  }

  let fixedSum = 0;
  let growSum = 0;
  let growCount = 0;
  for (let i = 0; i < n; i += 1) {
    fixedSum += declaredWidths[i] ?? 0;
    growSum += grows[i]!;
    if (grows[i]! > 0) growCount += 1;
  }

  const widths: number[] = [];
  const remaining = Math.max(0, availW - fixedSum);
  for (let i = 0; i < n; i += 1) {
    if (declaredWidths[i] !== undefined) widths.push(declaredWidths[i]!);
    else if (growCount === 0) widths.push(minWidths[i]!);
    else widths.push(Math.max((remaining * grows[i]!) / (growSum || 1), minWidths[i]!));
  }

  const resolved = widths.map((width, i) => ({
    width,
    align: (declared[i]?.align ?? 'left') as ResolvedColumn['align'],
    style: declared[i]?.style,
    key: declared[i]?.key,
    colorScale: declared[i]?.colorScale,
  }));
  assignScaleRanges(resolved, units, ctx, scope);
  return resolved;
}

/**
 * A heatmap that omits `min`/`max` takes its domain from the numbers the column
 * actually prints, so one declaration shades the whole column without the author
 * guessing bounds. Explicit bounds always win.
 */
function assignScaleRanges(columns: ResolvedColumn[], units: Unit[], ctx: LayoutContext, scope: ExprContext): void {
  const numbers: number[][] = columns.map(() => []);
  const scaled: boolean[] = columns.map((c) => c.colorScale !== undefined);
  for (const u of units) {
    if (u.t === 'groupHeader' || u.t === 'groupFooter') continue;
    const rowScope: ExprContext = u.t === 'detail' ? { ...scope, $row: u.data, $index: u.index } : scope;
    const autoBind = u.t === 'detail' && u.static !== true;
    let ci = 0;
    for (const cell of u.row.cells) {
      const column = columns[ci];
      // A scale declared on the cell (not the column) still needs a domain.
      if (cell.colorScale) scaled[ci] = true;
      if (column && (column.colorScale || cell.colorScale)) {
        const value = numericValue(cell, column, ctx, rowScope, autoBind);
        if (value !== undefined) numbers[ci]!.push(value);
      }
      ci += Math.max(1, cell.colSpan ?? 1);
    }
  }
  for (let i = 0; i < columns.length; i += 1) {
    const values = numbers[i]!;
    if (!scaled[i] || values.length === 0) continue;
    columns[i]!.range = { min: Math.min(...values), max: Math.max(...values) };
  }
}

/**
 * The number a cell prints, for colour scaling: a numeric literal, a numeric
 * string (static rows routinely carry `'8.1'`), a binding, or a detail cell
 * auto-bound from its column key. Non-numeric cells return `undefined`.
 */
function numericValue(
  cell: CellContent,
  column: ResolvedColumn | undefined,
  ctx: LayoutContext,
  scope: ExprContext,
  autoBind: boolean,
): number | undefined {
  let content = asCellNode(cell).content as unknown;
  if (content && typeof content === 'object' && !Array.isArray(content) && 'content' in content) {
    content = (content as CellNode).content;
  }
  if (autoBind && (content === undefined || content === '') && column?.key) {
    return toNumber(getPath((scope.$row as Record<string, unknown> | undefined) ?? {}, column.key));
  }
  if (content && typeof content === 'object' && !Array.isArray(content) && 'bind' in content) {
    const source = exprSource((content as { bind: string | { expr: string } }).bind);
    if (source === undefined) return undefined;
    // Same resolution order as `resolveBind`: row first, then report data.
    if (/^[$]?[\w.[\]]+$/.test(source) && !/[+\-*/?:()]/.test(source)) {
      const row = scope.$row;
      if (row && getPath(row, source) !== undefined) return toNumber(getPath(row, source));
      if (getPath(ctx.data, source) !== undefined) return toNumber(getPath(ctx.data, source));
    }
    return toNumber(ctx.eval(source, scope));
  }
  return toNumber(content);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function sampleTexts(units: Unit[], col: number): string[] {
  const out: string[] = [];
  for (const u of units) {
    if (u.t === 'groupHeader' || u.t === 'groupFooter') continue;
    const cell = u.row.cells[col];
    if (!cell) continue;
    const text = preview(cell);
    if (text) out.push(text);
    if (out.length > 40) break;
  }
  return out;
}

function preview(cell: CellContent): string {
  const c = asCellNode(cell).content;
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  return '';
}

function widestToken(texts: string[], style: ResolvedStyle): number {
  let max = 0;
  for (const t of texts) {
    for (const token of findBreaks(t)) {
      if (token.space || token.hard) continue;
      const w = style.handle.widthOf(token.text, style.fontSize, style.features) + style.letterSpacing * Array.from(token.text).length;
      if (w > max) max = w;
    }
  }
  return Math.min(max, 400);
}

// --- rows ------------------------------------------------------------------

interface PlacedBlock {
  fragment: Fragment;
  /** Offset of the nested fragment relative to the cell's content box top. */
  y: number;
}

interface CellLayout {
  x: number;
  w: number;
  pad: typeof CELL_PAD;
  lines: Line[];
  blocks: PlacedBlock[];
  contentH: number;
  fill: ColorInput | undefined;
  borders: Sides;
  vAlign: 'top' | 'middle' | 'bottom';
}

function layoutRow(unit: Extract<Unit, { t: 'header' | 'footer' | 'detail' }>, uc: UnitCtx, isFirstVisual: boolean): Fragment {
  const { block, ctx, columns, tableStyle, grid } = uc;
  const row = unit.row;
  const scope: ExprContext = unit.t === 'detail' ? { ...uc.scope, $row: unit.data, $index: unit.index } : uc.scope;

  const layouts: CellLayout[] = [];
  let x = uc.contentLeft;
  let maxContent = 0;
  const detailIndex = unit.t === 'detail' ? unit.index : 0;
  const stripedFill = unit.t === 'detail' && detailIndex % 2 === 1 ? grid.stripedColor : undefined;
  const rowProps = rowStyleFor(block, unit, ctx, scope);
  const autoBind = unit.t === 'detail' && unit.static !== true;

  let ci = 0;
  for (let c = 0; c < row.cells.length; c += 1) {
    const cell = row.cells[c]!;
    const span = Math.max(1, cell.colSpan ?? 1);
    let w = 0;
    for (let s = 0; s < span; s += 1) w += columns[ci + s]?.width ?? 0;
    const column = columns[ci];

    const scaled = scaledFill(cell, column, ctx, scope, autoBind);
    // Keep the unresolved props: only explicitly merged backgrounds may paint a
    // cell fill (an inherited table background must not mask the heatmap).
    const props = cellProps(cell, column, rowProps, ctx, scope, scaled?.color);
    const baseStyle = ctx.style(props, tableStyle);
    const align = (cell.align ?? column?.align ?? baseStyle.align) as ResolvedStyle['align'];
    const style = ctx.style({ align }, baseStyle);

    const pad = {
      top: cell.paddingTop ?? CELL_PAD.top,
      right: cell.paddingRight ?? CELL_PAD.right,
      bottom: cell.paddingBottom ?? CELL_PAD.bottom,
      left: cell.paddingLeft ?? CELL_PAD.left,
    };
    const innerW = Math.max(1, w - pad.left - pad.right);
    const visible = isVisible(cell.visible, ctx, scope);
    const payload = layoutCellContent(cell, column, style, ctx, scope, innerW, autoBind, visible);

    layouts.push({
      x,
      w,
      pad,
      lines: payload.lines,
      blocks: payload.blocks,
      contentH: payload.contentH,
      fill: cell.backgroundColor ?? props.backgroundColor ?? scaled?.fill ?? stripedFill,
      borders: cellSides(cell.border ?? gridShorthand(grid), 0.5),
      vAlign: cell.verticalAlign ?? 'top',
    });
    maxContent = Math.max(maxContent, payload.contentH + pad.top + pad.bottom);
    x += w;
    ci += span;
  }

  const rowHeight = Math.max(maxContent, toPt(row.minHeight ?? 0));
  const commands: DrawCommand[] = [];

  for (const cl of layouts) {
    if (cl.fill) commands.push({ op: 'fillRect', x: cl.x, y: 0, w: cl.w, h: rowHeight, color: toRGB(cl.fill) });
    paintCellContent(commands, cl, contentTop(cl, rowHeight));
    drawSides(commands, cl.borders, cl.x, 0, cl.w, rowHeight);
  }

  // Header rows repeat on every page the table spans, with or without the flag; the
  // paginator keys the replay off `role: 'header'`, so `repeatHeader: false` is the
  // only thing this knob can meaningfully do — opt the repetition out.
  const role =
    unit.t === 'header'
      ? uc.block.repeatHeader === false
        ? 'detail'
        : 'header'
      : unit.t === 'footer'
        ? 'footer'
        : 'detail';
  return {
    height: rowHeight,
    before: isFirstVisual ? uc.margin.top : 0,
    after: unit.t === 'footer' ? uc.margin.bottom : 0,
    commands,
    avoidSplit: true,
    role,
    groupKey: uc.groupKey,
    breakAfter: row.keepWithNext ? 'avoid' : undefined,
    keepWithNext: row.keepWithNext,
  };
}

/** Content-box top for a cell of known outer height, honouring `verticalAlign`. */
function contentTop(cl: { contentH: number; pad: typeof CELL_PAD; vAlign: 'top' | 'middle' | 'bottom' }, outerH: number): number {
  if (cl.vAlign === 'middle') return (outerH - cl.contentH) / 2;
  if (cl.vAlign === 'bottom') return outerH - cl.contentH - cl.pad.bottom;
  return cl.pad.top;
}

/** Paint one cell's inline lines and nested block fragments at `vTop`. */
function paintCellContent(
  commands: DrawCommand[],
  cl: { x: number; pad: typeof CELL_PAD; lines: Line[]; blocks: PlacedBlock[] },
  vTop: number,
): void {
  let lineY = vTop;
  for (const line of cl.lines) {
    commands.push({ op: 'text', x: cl.x + cl.pad.left, baselineY: lineY + line.ascent, runs: line.runs, gapWidth: line.gapWidth, decorations: [] });
    lineY += line.height;
  }
  for (const placed of cl.blocks) {
    commands.push(...translateCommands(placed.fragment.commands, cl.x + cl.pad.left, vTop + placed.y));
  }
}

/**
 * Lay out one cell's payload. Inline content goes through one `typeset` pass;
 * rich cells stack flow blocks with the same before/height/after rhythm
 * pagination uses, so nested margins behave the way authors expect.
 */
function layoutCellContent(
  cell: CellContent,
  column: ResolvedColumn | undefined,
  style: ResolvedStyle,
  ctx: LayoutContext,
  scope: ExprContext,
  innerW: number,
  autoBind: boolean,
  visible: boolean,
): { lines: Line[]; blocks: PlacedBlock[]; contentH: number } {
  if (!visible) return { lines: [], blocks: [], contentH: 0 };
  const node = asCellNode(cell);
  const blocks = node.blocks ?? [];
  const hasInline = node.content !== undefined && node.content !== '';
  if (!hasInline && blocks.length > 0) {
    const placed: PlacedBlock[] = [];
    let y = 0;
    for (const block of blocks) {
      const frags = layoutBlock(block, ctx, { contentWidth: innerW, scope, inherited: style });
      for (const fragment of frags) {
        // A page break inside a cell has no page to break; it collapses to nothing.
        if (fragment.isPageBreak) continue;
        y += fragment.before;
        placed.push({ fragment, y });
        y += fragment.height + fragment.after;
      }
    }
    return { lines: [], blocks: placed, contentH: y };
  }
  const result = typeset(cellInlines(cell, column, style, ctx, scope, autoBind), innerW);
  return {
    lines: result.lines,
    blocks: [],
    contentH: result.lines.reduce((sum, l) => sum + l.height, 0),
  };
}

/** Row-level conditional style: the callback/constant first, then `styleWhen`. */
function rowStyleFor(block: TableBlock, unit: RowUnit, ctx: LayoutContext, scope: ExprContext): Partial<StyleProps> {
  const base = resolveRowStyle(block, unit.t === 'detail' ? unit.data : {}, detailIndexOf(unit));
  return unit.row.styleWhen?.length ? applyConditions(base, unit.row.styleWhen, ctx, scope) : base;
}

/**
 * Cell style props in cascade order: colour scale (lowest), row conditions,
 * column defaults, the cell's own props, then the cell's conditions.
 */
function cellProps(
  cell: CellNode,
  column: ResolvedColumn | undefined,
  rowProps: Partial<StyleProps>,
  ctx: LayoutContext,
  scope: ExprContext,
  scaleColor?: RGB,
): Partial<StyleProps> {
  const merged: Partial<StyleProps> = {
    ...(scaleColor ? { color: scaleColor } : {}),
    ...rowProps,
    ...(column?.style ?? {}),
    ...(cell.style ?? {}),
  };
  return cell.styleWhen?.length ? applyConditions(merged, cell.styleWhen, ctx, scope) : merged;
}

/** Heatmap fill/text colour for a cell, when a scale applies and the value is numeric. */
function scaledFill(
  cell: CellNode,
  column: ResolvedColumn | undefined,
  ctx: LayoutContext,
  scope: ExprContext,
  autoBind: boolean,
): { fill: RGB; color?: RGB } | undefined {
  const scale = cell.colorScale ?? column?.colorScale;
  if (!scale) return undefined;
  return scaleFillFor(scale, numericValue(cell, column, ctx, scope, autoBind), column?.range);
}

// --- vertical merge (rowSpan) ----------------------------------------------

/**
 * A vertically-merged cell is taller than a single row, so the rows it spans
 * cannot be independent fragments. We lay the whole contiguous run of rows into
 * one grid fragment: build a cell-occupancy matrix (honoring colspan + rowspan),
 * solve row heights jointly (a tall spanned cell distributes its surplus height
 * across its rows), then paint each anchor cell over its full merged rectangle.
 */
function rowSpanAllowed(unit: RowUnit): boolean {
  // Only authored rows may start a vertical span; data-expanded detail rows reuse
  // a single shared template, so a rowspan there is meaningless.
  return unit.t === 'header' || unit.t === 'footer' || (unit.t === 'detail' && unit.static === true);
}

function runNeedsMerge(run: RowUnit[]): boolean {
  return run.some((u) => rowSpanAllowed(u) && u.row.cells.some((c) => (c.rowSpan ?? 1) > 1));
}

function detailIndexOf(unit: RowUnit): number {
  return unit.t === 'detail' ? unit.index : 0;
}

function unitScope(unit: RowUnit, uc: UnitCtx): ExprContext {
  return unit.t === 'detail' ? { ...uc.scope, $row: unit.data, $index: unit.index } : uc.scope;
}

interface AnchorCell {
  row: number;
  col: number;
  colSpan: number;
  rowSpan: number;
  x: number;
  w: number;
  pad: typeof CELL_PAD;
  lines: Line[];
  blocks: PlacedBlock[];
  contentH: number;
  fill: ColorInput | undefined;
  borders: Sides;
  vAlign: 'top' | 'middle' | 'bottom';
}

function layoutMergedRun(run: RowUnit[], uc: UnitCtx, isFirstVisual: boolean): Fragment {
  const { block, ctx, columns, tableStyle, grid } = uc;
  const R = run.length;
  const C = Math.max(1, columns.length);

  const covered: boolean[][] = Array.from({ length: R }, () => Array<boolean>(C).fill(false));
  const anchors: AnchorCell[] = [];

  for (let r = 0; r < R; r += 1) {
    const unit = run[r]!;
    const row = unit.row;
    const scope = unitScope(unit, uc);
    const allowSpan = rowSpanAllowed(unit);
    const rowProps = rowStyleFor(block, unit, ctx, scope);
    const autoBind = unit.t === 'detail' && unit.static !== true;
    const stripedFill = unit.t === 'detail' && detailIndexOf(unit) % 2 === 1 ? grid.stripedColor : undefined;

    let colCursor = 0;
    for (const cell of row.cells) {
      while (colCursor < C && covered[r]![colCursor]) colCursor += 1;
      if (colCursor >= C) break; // no room left in this row

      const startCol = colCursor;
      const colSpan = Math.min(Math.max(1, cell.colSpan ?? 1), C - startCol);
      const rowSpan = Math.min(allowSpan ? Math.max(1, cell.rowSpan ?? 1) : 1, R - r);

      // Mark every covered cell of the merged rectangle (except the anchor slot,
      // which the cursor skips over by advancing past it).
      for (let rr = r; rr < r + rowSpan; rr += 1) {
        for (let cc = startCol; cc < startCol + colSpan; cc += 1) {
          if (rr === r && cc === startCol) continue;
          covered[rr]![cc] = true;
        }
      }
      colCursor = startCol + colSpan;

      let w = 0;
      for (let s = 0; s < colSpan; s += 1) w += columns[startCol + s]?.width ?? 0;
      const column = columns[startCol];

      const scaled = scaledFill(cell, column, ctx, scope, autoBind);
      const props = cellProps(cell, column, rowProps, ctx, scope, scaled?.color);
      const baseStyle = ctx.style(props, tableStyle);
      const align = (cell.align ?? column?.align ?? baseStyle.align) as ResolvedStyle['align'];
      const style = ctx.style({ align }, baseStyle);
      const pad = {
        top: cell.paddingTop ?? CELL_PAD.top,
        right: cell.paddingRight ?? CELL_PAD.right,
        bottom: cell.paddingBottom ?? CELL_PAD.bottom,
        left: cell.paddingLeft ?? CELL_PAD.left,
      };
      const innerW = Math.max(1, w - pad.left - pad.right);
      const visible = isVisible(cell.visible, ctx, scope);
      const payload = layoutCellContent(cell, column, style, ctx, scope, innerW, autoBind, visible);
      const x = uc.contentLeft + columns.slice(0, startCol).reduce((s, c) => s + c.width, 0);

      anchors.push({
        row: r,
        col: startCol,
        colSpan,
        rowSpan,
        x,
        w,
        pad,
        lines: payload.lines,
        blocks: payload.blocks,
        contentH: payload.contentH,
        fill: cell.backgroundColor ?? props.backgroundColor ?? scaled?.fill ?? stripedFill,
        borders: cellSides(cell.border ?? gridShorthand(grid), 0.5),
        vAlign: cell.verticalAlign ?? 'top',
      });
    }
  }

  // Solve row heights: start from authored minimums and single-row cells, then
  // distribute any deficit a tall spanned cell has across the rows it covers.
  const rowH: number[] = new Array<number>(R).fill(0);
  for (let r = 0; r < R; r += 1) rowH[r] = Math.max(rowH[r]!, toPt(run[r]!.row.minHeight ?? 0));
  for (const a of anchors) if (a.rowSpan === 1) rowH[a.row] = Math.max(rowH[a.row]!, a.contentH + a.pad.top + a.pad.bottom);
  for (const a of anchors) {
    if (a.rowSpan <= 1) continue;
    const need = a.contentH + a.pad.top + a.pad.bottom;
    let cur = 0;
    for (let k = 0; k < a.rowSpan; k += 1) cur += rowH[a.row + k]!;
    if (need > cur) {
      const add = (need - cur) / a.rowSpan;
      for (let k = 0; k < a.rowSpan; k += 1) rowH[a.row + k]! += add;
    }
  }

  const yTop: number[] = new Array<number>(R);
  let y = 0;
  for (let r = 0; r < R; r += 1) {
    yTop[r] = y;
    y += rowH[r]!;
  }
  const totalH = y;

  const commands: DrawCommand[] = [];
  for (const a of anchors) {
    let rectH = 0;
    for (let k = 0; k < a.rowSpan; k += 1) rectH += rowH[a.row + k]!;
    const ry = yTop[a.row]!;
    if (a.fill) commands.push({ op: 'fillRect', x: a.x, y: ry, w: a.w, h: rectH, color: toRGB(a.fill) });
    paintCellContent(commands, a, ry + contentTop(a, rectH));
    drawSides(commands, a.borders, a.x, ry, a.w, rectH);
  }

  const allHeader = run.every((u) => u.t === 'header');
  const allFooter = run.every((u) => u.t === 'footer');
  const role = allHeader && uc.block.repeatHeader !== false ? 'header' : allFooter ? 'footer' : 'detail';
  return {
    height: totalH,
    before: isFirstVisual ? uc.margin.top : 0,
    after: run[run.length - 1]!.t === 'footer' ? uc.margin.bottom : 0,
    commands,
    avoidSplit: true,
    role,
    groupKey: uc.groupKey,
  };
}

// --- group bands -----------------------------------------------------------

function layoutGroupBand(unit: Extract<Unit, { t: 'groupHeader' | 'groupFooter' }>, uc: UnitCtx): Fragment[] {
  const { ctx, tableStyle, columns } = uc;
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const isHeader = unit.t === 'groupHeader';
  const override = (isHeader ? unit.group.headerStyle : unit.group.footerStyle) ?? {};
  const style = ctx.style({ fontWeight: isHeader ? 'bold' : (tableStyle.handle.weight as StyleProps['fontWeight']), ...override }, tableStyle);

  const scope: ExprContext = { ...uc.scope, $group: groupSummary(unit.rows, columns) };
  const content = isHeader ? bandContent(unit.group.header, unit.group, unit.value) : bandContent(unit.group.footer, unit.group, unit.value);
  const inline = resolveContent(content, ctx, style, scope);

  const pad = { top: 2, right: 3, bottom: 2, left: 3 };
  const result = typeset(inline, Math.max(1, totalW - pad.left - pad.right));
  const height = result.lines.reduce((s, l) => s + l.height, 0) + pad.top + pad.bottom;

  const commands: DrawCommand[] = [];
  if (style.backgroundColor) commands.push({ op: 'fillRect', x: uc.contentLeft, y: 0, w: totalW, h: height, color: toRGB(style.backgroundColor) });
  let lineY = pad.top;
  for (const line of result.lines) {
    commands.push({ op: 'text', x: uc.contentLeft + pad.left, baselineY: lineY + line.ascent, runs: line.runs, gapWidth: line.gapWidth, decorations: [] });
    lineY += line.height;
  }

  return [
    {
      height,
      before: 0,
      after: 0,
      commands,
      avoidSplit: true,
      role: isHeader ? 'groupHeader' : 'groupFooter',
      breakBefore: isHeader && unit.pageBreak ? 'page' : !isHeader ? 'avoid' : undefined,
      keepWithNext: isHeader,
      resetPageNumber: isHeader && unit.resetPage ? true : undefined,
      groupValue: isHeader ? unit.value : undefined,
    },
  ];
}

function groupSummary(rows: Array<Record<string, unknown>>, columns: ResolvedColumn[]): Record<string, unknown> {
  const out: Record<string, unknown> = { rowCount: rows.length };
  for (const col of columns) {
    if (!col.key) continue;
    const acc = (r: Record<string, unknown>): unknown => getPath(r, col.key!);
    out[`${col.key}_sum`] = aggregate('sum', rows, acc);
    out[`${col.key}_avg`] = aggregate('avg', rows, acc);
    out[`${col.key}_min`] = aggregate('min', rows, acc);
    out[`${col.key}_max`] = aggregate('max', rows, acc);
    out[`${col.key}_count`] = aggregate('count', rows, acc);
  }
  return out;
}

function bandContent(band: Content | undefined, group: GroupNode, value: unknown): Content {
  if (band !== undefined) return band;
  return String(value ?? group.label ?? '');
}

// --- helpers ---------------------------------------------------------------

function cellInlines(
  cell: CellContent,
  column: ResolvedColumn | undefined,
  style: ResolvedStyle,
  ctx: LayoutContext,
  scope: ExprContext,
  autoBind: boolean,
): InlineSource[] {
  let content = asCellNode(cell).content as CellContent | undefined;
  if (content && typeof content === 'object' && !Array.isArray(content) && 'content' in content) {
    content = (content as CellNode).content;
  }
  // An empty cell in a data-driven detail row inherits its column's `key` as a
  // binding. Only there: an authored header/footer cell left blank must stay blank,
  // never turn into a binding of the column name.
  if (autoBind && (content === undefined || content === '') && column?.key) {
    content = { bind: column.key, format: cellFormat(cell) } as Content;
  }
  return resolveContent(content as Content, ctx, style, scope);
}

/** Cell-level `format`, for the auto-bound case. */
function cellFormat(cell: CellContent): string | undefined {
  return cell && typeof cell === 'object' && !Array.isArray(cell) ? (cell as CellNode).format : undefined;
}

function gridShorthand(grid: GridSpec): BorderShorthand | undefined {
  if (!grid.border) return undefined;
  return [grid.border.width, grid.border.style, grid.border.color];
}

function cellSides(shorthand: BorderShorthand | undefined, defaultWidth: number): Sides {
  const b = parseBorder(shorthand, defaultWidth);
  return { top: b, right: b, bottom: b, left: b };
}

function resolveGrid(block: TableBlock): GridSpec {
  let border: ResolvedBorder | undefined;
  if (block.showGrid === true) border = { width: 0.5, style: 'solid', color: [0.6, 0.6, 0.6] };
  else if (block.showGrid) border = parseBorder(block.showGrid, 0.5);
  const stripedColor = block.striped === true ? [0.95, 0.95, 0.95] as ColorInput : block.striped ? block.striped.color : undefined;
  return { border, stripedColor };
}

function resolveRowStyle(block: TableBlock, row: Record<string, unknown>, index: number): Partial<StyleProps> {
  if (!block.rowStyle) return {};
  return typeof block.rowStyle === 'function' ? block.rowStyle(row, index) : block.rowStyle;
}

function drawSides(commands: DrawCommand[], sides: Sides, x: number, y: number, w: number, h: number): void {
  const add = (b: ResolvedBorder, x1: number, y1: number, x2: number, y2: number) =>
    commands.push({ op: 'line', x1, y1, x2, y2, color: borderRGB(b), lineWidth: b.width, dash: borderDash(b) });
  if (sides.top) add(sides.top, x, y + sides.top.width / 2, x + w, y + sides.top.width / 2);
  if (sides.bottom) add(sides.bottom, x, y + h - sides.bottom.width / 2, x + w, y + h - sides.bottom.width / 2);
  if (sides.left) add(sides.left, x + sides.left.width / 2, y, x + sides.left.width / 2, y + h);
  if (sides.right) add(sides.right, x + w - sides.right.width / 2, y, x + w - sides.right.width / 2, y + h);
}

// --- unit building ---------------------------------------------------------

function buildUnits(block: TableBlock, ctx: LayoutContext, scope: ExprContext): Unit[] {
  const out: Unit[] = [];
  for (const row of block.headerRows ?? []) {
    if (isVisible(row.visible, ctx, scope)) out.push({ t: 'header', row });
  }

  const data = resolveData(block, ctx, scope);
  const detailRow = detailRowNode(block);

  // Authored static body rows keep their own per-cell styling; render them as
  // concrete detail rows (content lives in the cells, so no data binding).
  let staticIndex = 0;
  for (const row of block.staticRows ?? []) {
    if (!isVisible(row.visible, ctx, scope)) continue;
    out.push({ t: 'detail', row, data: {}, index: staticIndex++, static: true });
  }

  if (block.groups && block.groups.length > 0) out.push(...buildGrouped(block, ctx, scope, data, detailRow));
  else
    data.forEach((item, i) => {
      // Row-level filtering: the detail template's `visible` runs once per row.
      if (!isVisible(detailRow.visible, ctx, { ...scope, $row: item, $index: i + staticIndex })) return;
      out.push({ t: 'detail', row: detailRow, data: item, index: i + staticIndex });
    });

  for (const row of block.footerRows ?? []) {
    if (isVisible(row.visible, ctx, scope)) out.push({ t: 'footer', row });
  }
  return out;
}

/** The shared detail template, keeping any row-level conditions it declares. */
function detailRowNode(block: TableBlock): RowNode {
  const d = block.detail as (Partial<RowNode> & { style?: Partial<StyleProps> }) | undefined;
  return {
    cells: (d?.cells ?? []).map(asCellNode),
    visible: d?.visible,
    styleWhen: d?.styleWhen,
  };
}

function asCellNode(c: CellContent): CellNode {
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const obj = c as Record<string, unknown>;
    const keys = Object.keys(obj);
    // A `text`/`bind`/`children` carrier is always the cell's content; otherwise an
    // empty object or one holding cell-only keys is a `CellNode` whose content may
    // be blank (auto-bound from the column key in `cellInlines`).
    if (obj.text === undefined && obj.bind === undefined && obj.children === undefined) {
      if (keys.length === 0 || keys.some((k) => CELL_ONLY_KEYS.has(k))) return c as CellNode;
    }
  }
  return { content: c as Content };
}

/** Keys that exist on `CellNode` but never on a `ContentSpan`. */
const CELL_ONLY_KEYS = new Set([
  'content',
  'blocks',
  'colSpan',
  'rowSpan',
  'align',
  'verticalAlign',
  'border',
  'backgroundColor',
  'visible',
  'styleWhen',
  'colorScale',
  'subtotal',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
]);

function buildGrouped(block: TableBlock, ctx: LayoutContext, scope: ExprContext, data: Array<Record<string, unknown>>, detailRow: RowNode): Unit[] {
  const group = block.groups![0]!;
  const out: Unit[] = [];
  let bucket: Array<Record<string, unknown>> = [];
  let current: unknown;
  let started = false;

  const flush = (pageBreak: boolean, resetPage: boolean): void => {
    if (!started || bucket.length === 0) return;
    out.push({ t: 'groupHeader', group, value: current, rows: bucket, pageBreak, resetPage });
    for (const [i, r] of bucket.entries()) out.push({ t: 'detail', row: detailRow, data: r, index: i });
    out.push({ t: 'groupFooter', group, value: current, rows: bucket });
  };

  for (const item of data) {
    if (!isVisible(detailRow.visible, ctx, { ...scope, $row: item })) continue;
    const key = ctx.eval(group.by, { ...scope, $row: item });
    if (!started || key !== current) {
      if (started) flush(false, false);
      current = key;
      bucket = [];
      started = true;
    }
    bucket.push(item);
  }
  flush(group.pageBreak ?? false, group.resetPageNumber ?? false);
  return out;
}

function resolveData(block: TableBlock, ctx: LayoutContext, scope: ExprContext): Array<Record<string, unknown>> {
  const ds = block.dataSource;
  if (!ds) return [];
  if (Array.isArray(ds)) return ds;
  if ('bind' in ds) {
    const v = ctx.eval(ds.bind, scope);
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  }
  if ('each' in ds) {
    const v = ctx.eval(ds.of, scope);
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  }
  return [];
}
