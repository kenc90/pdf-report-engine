/**
 * Report-oriented CSS Grid layout.
 *
 * This supports explicit fixed, percentage, and fractional columns; row-major
 * auto-placement; gaps; span-based row/column placement; and default vertical
 * stretching for container items. Rows are sized to their content. Intrinsic
 * track sizing and implicit columns are not modelled.
 */
import type { GridBlock, GridItem, GridTrack } from '../ir/schema.js';
import { resolveLen } from '../core/units.js';
import { toRGB } from '../core/color.js';
import type { ResolvedStyle } from '../text/style.js';
import type { LayoutContext } from './context.js';
import { layoutBlock, type BlockLayoutOptions } from './block.js';
import { borderDash, borderRGB, resolveBorders, resolveBox } from './box.js';
import { translateCommands, type DrawCommand, type Fragment } from './flow.js';

interface Placement {
  item: GridItem;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

interface MeasuredItem extends Placement {
  x: number;
  width: number;
  height: number;
  fragments: Fragment[];
}

function trackLength(track: GridTrack, width: number): number | undefined {
  if (typeof track === 'object') return undefined;
  return Math.max(0, resolveLen(track, width));
}

function resolveColumns(tracks: GridTrack[], width: number, gap: number): number[] {
  if (tracks.length > 64) throw new Error('CSS Grid supports at most 64 explicit columns.');
  for (const track of tracks) {
    if (typeof track === 'object' && (!Number.isFinite(track.fr) || track.fr < 0)) {
      throw new Error('CSS Grid fractional track weights must be finite and non-negative.');
    }
    if (typeof track !== 'object' && resolveLen(track, width) < 0) {
      throw new Error('CSS Grid fixed column tracks must be non-negative.');
    }
  }
  const fixed = tracks.map((track) => trackLength(track, width));
  const fractional = tracks.map((track) => typeof track === 'object' ? Math.max(0, track.fr) : 0);
  const fixedTotal = fixed.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  const fractionTotal = fractional.reduce<number>((sum, weight) => sum + weight, 0);
  const remaining = Math.max(0, width - gap * Math.max(0, tracks.length - 1) - fixedTotal);
  return tracks.map((_, index) =>
    fixed[index] ?? (fractionTotal > 0 ? remaining * fractional[index]! / fractionTotal : 0),
  );
}

function placeItems(items: GridItem[], columns: number): { placements: Placement[]; rowCount: number } {
  const occupied: boolean[][] = [];
  const placements: Placement[] = [];
  let cursor = 0;

  const isFree = (row: number, column: number, rowSpan: number, columnSpan: number): boolean => {
    for (let r = row; r < row + rowSpan; r += 1) {
      for (let c = column; c < column + columnSpan; c += 1) {
        if (occupied[r]?.[c]) return false;
      }
    }
    return true;
  };
  const reserve = (row: number, column: number, rowSpan: number, columnSpan: number): void => {
    for (let r = row; r < row + rowSpan; r += 1) {
      occupied[r] ??= [];
      for (let c = column; c < column + columnSpan; c += 1) occupied[r]![c] = true;
    }
  };

  for (const item of items) {
    const columnSpan = item.columnSpan ?? 1;
    const rowSpan = item.rowSpan ?? 1;
    if (!Number.isInteger(columnSpan) || columnSpan < 1 || columnSpan > 64 ||
      !Number.isInteger(rowSpan) || rowSpan < 1 || rowSpan > 64) {
      throw new Error('CSS Grid item spans must be integers between 1 and 64 tracks.');
    }
    if (columnSpan > columns) {
      throw new Error(`CSS Grid item spans ${columnSpan} columns, but the grid defines only ${columns}.`);
    }
    let index = cursor;
    let placed = false;
    while (!placed) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      if (column + columnSpan > columns) {
        index = (row + 1) * columns;
        continue;
      }
      if (isFree(row, column, rowSpan, columnSpan)) {
        reserve(row, column, rowSpan, columnSpan);
        placements.push({ item, column, row, columnSpan, rowSpan });
        cursor = index + columnSpan;
        placed = true;
      } else {
        index += 1;
      }
    }
  }

  const rowCount = placements.reduce((count, item) => Math.max(count, item.row + item.rowSpan), 0);
  return { placements, rowCount };
}

export function layoutGrid(
  block: GridBlock,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
): Fragment[] {
  const { margin, padding } = resolveBox(block);
  const innerW = Math.max(1, opts.contentWidth - margin.left - margin.right - padding.left - padding.right);
  const style = ctx.style(block, inherited);
  const childStyle = block.backgroundColor !== undefined
    ? { ...style, backgroundColor: undefined }
    : style;
  const columns = block.columns.length ? block.columns : [{ fr: 1 }];
  const columnGap = Math.max(0, resolveLen(block.columnGap ?? block.gap, innerW));
  const rowGap = Math.max(0, resolveLen(block.rowGap ?? block.gap, innerW));
  const widths = resolveColumns(columns, innerW, columnGap);
  const xPositions: number[] = [];
  for (let i = 0, x = 0; i < widths.length; i += 1) {
    xPositions.push(x);
    x += widths[i]! + columnGap;
  }

  const { placements, rowCount } = placeItems(block.children, columns.length);
  const measured: MeasuredItem[] = placements.map((placement) => {
    const width = widths
      .slice(placement.column, placement.column + placement.columnSpan)
      .reduce((sum, track) => sum + track, columnGap * (placement.columnSpan - 1));
    const fragments = layoutBlock(placement.item.block, ctx, {
      contentWidth: Math.max(1, width),
      scope: opts.scope,
      inherited: childStyle,
    });
    const height = fragments.reduce((sum, fragment) => sum + fragment.before + fragment.height + fragment.after, 0);
    return { ...placement, x: xPositions[placement.column]!, width, height, fragments };
  });

  const rowHeights = Array.from({ length: rowCount }, () => 0);
  for (const item of measured) {
    if (item.rowSpan === 1) rowHeights[item.row] = Math.max(rowHeights[item.row]!, item.height);
  }
  for (const item of measured) {
    if (item.rowSpan === 1) continue;
    const current = rowHeights
      .slice(item.row, item.row + item.rowSpan)
      .reduce((sum, height) => sum + height, rowGap * (item.rowSpan - 1));
    const extra = Math.max(0, item.height - current) / item.rowSpan;
    for (let row = item.row; row < item.row + item.rowSpan; row += 1) rowHeights[row] = rowHeights[row]! + extra;
  }

  const yPositions: number[] = [];
  for (let i = 0, y = 0; i < rowCount; i += 1) {
    yPositions.push(y);
    y += rowHeights[i]! + rowGap;
  }

  for (const item of measured) {
    if (item.item.block.type !== 'container') continue;
    const areaHeight = rowHeights
      .slice(item.row, item.row + item.rowSpan)
      .reduce((sum, height) => sum + height, rowGap * (item.rowSpan - 1));
    const { margin: itemMargin } = resolveBox(item.item.block);
    item.fragments = layoutBlock(item.item.block, ctx, {
      contentWidth: Math.max(1, item.width),
      scope: opts.scope,
      inherited: childStyle,
      gridAreaHeight: Math.max(0, areaHeight - itemMargin.top - itemMargin.bottom),
    });
    item.height = item.fragments.reduce((sum, fragment) => sum + fragment.before + fragment.height + fragment.after, 0);
  }

  const commands: DrawCommand[] = [];
  const itemBackgrounds: DrawCommand[] = [];
  const originX = margin.left + padding.left;
  for (const item of measured) {
    const x = originX + item.x;
    const y = padding.top + yPositions[item.row]!;
    let itemY = 0;
    for (const fragment of item.fragments) {
      for (const command of translateCommands(fragment.commands, x, y + itemY + fragment.before)) {
        if (command.op === 'fillRect' && command.paintLayer === 'background') itemBackgrounds.push(command);
        else commands.push(command);
      }
      itemY += fragment.before + fragment.height + fragment.after;
    }
  }

  const contentH = rowHeights.reduce((sum, height) => sum + height, rowGap * Math.max(0, rowCount - 1));
  const boxW = innerW + padding.left + padding.right;
  const boxH = contentH + padding.top + padding.bottom;
  const borders = resolveBorders(block);
  const framed: DrawCommand[] = [];
  if (style.backgroundColor !== undefined) {
    framed.push({ op: 'fillRect', x: margin.left, y: 0, w: boxW, h: boxH, color: toRGB(style.backgroundColor) });
  }
  // Keep item backgrounds below all content so later row-fragment fills cannot
  // paint over borders emitted at the previous fragment's bottom edge.
  framed.push(...itemBackgrounds);
  framed.push(...commands);
  const addBorder = (x1: number, y1: number, x2: number, y2: number, border: NonNullable<typeof borders.top>): void => {
    framed.push({ op: 'line', x1, y1, x2, y2, color: borderRGB(border), lineWidth: border.width, dash: borderDash(border) });
  };
  if (borders.top) addBorder(margin.left, borders.top.width / 2, margin.left + boxW, borders.top.width / 2, borders.top);
  if (borders.bottom) addBorder(margin.left, boxH - borders.bottom.width / 2, margin.left + boxW, boxH - borders.bottom.width / 2, borders.bottom);
  if (borders.left) addBorder(margin.left + borders.left.width / 2, 0, margin.left + borders.left.width / 2, boxH, borders.left);
  if (borders.right) addBorder(margin.left + boxW - borders.right.width / 2, 0, margin.left + boxW - borders.right.width / 2, boxH, borders.right);

  return [{
    height: boxH,
    before: margin.top,
    after: margin.bottom,
    commands: framed,
    avoidSplit: true,
    breakBefore: block.breakBefore,
    breakAfter: block.breakAfter,
    keepWithNext: block.keepWithNext,
  }];
}
