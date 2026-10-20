/**
 * Vector charts.
 *
 * Every mark is emitted as the same inert draw commands the writer already
 * understands (`fillRect`, `poly`, `line`, `text`), so charts stay crisp at any
 * zoom, need no canvas, and paginate as a single atomic fragment.
 *
 * Data can arrive as literal arrays, CSV strings, or bindings evaluated against
 * the report scope — the same three shapes every other block accepts.
 */
import type { ChartBlock, ChartSeries, Expr, ValueAxisOptions } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import { typeset } from '../text/typeset.js';
import { resolveContent, type LayoutContext } from './context.js';
import type { BlockLayoutOptions } from './block.js';
import { resolveBox } from './box.js';
import type { DrawCommand, Fragment, PolyPoint } from './flow.js';
import { toRGB, type RGB } from '../core/color.js';
import { toPt } from '../core/units.js';
import { formatNumber } from '../expr/format.js';
import type { ExprContext } from '../expr/eval.js';

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

const DEFAULT_PALETTE: RGB[] = [
  [0.18, 0.37, 0.64],
  [0.91, 0.51, 0.23],
  [0.3, 0.62, 0.44],
  [0.75, 0.31, 0.3],
  [0.5, 0.39, 0.64],
  [0.29, 0.67, 0.78],
  [0.97, 0.59, 0.27],
  [0.61, 0.73, 0.35],
];

const GRID: RGB = [0.84, 0.86, 0.89];
const AXIS: RGB = [0.55, 0.58, 0.62];
const TEXT_MUTED: RGB = [0.32, 0.34, 0.38];

const SWATCH = 8;
const SWATCH_GAP = 4;
const ITEM_GAP = 14;
const LABEL_GAP = 4;

interface Slice {
  name?: string;
  values: number[];
  color: RGB;
  format?: string;
}

export function layoutChart(
  block: ChartBlock,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
): Fragment[] {
  const style = ctx.style(block, inherited);
  const { margin, padding } = resolveBox(block);
  const left = margin.left + padding.left;
  const width = Math.max(24, opts.contentWidth - margin.left - margin.right - padding.left - padding.right);

  // Labels are one notch smaller than body text so the plot keeps the room.
  const labelStyle = ctx.style({ fontSize: Math.max(5.5, style.fontSize - 2) }, style);
  const units = labelStyle.handle.unitsPerEm || 1000;
  const ascent = (labelStyle.handle.ascender / units) * labelStyle.fontSize;
  const descent = (Math.abs(labelStyle.handle.descender) / units) * labelStyle.fontSize;
  const labelHeight = ascent + descent;

  const categories = resolveStrings(block.categories, ctx, opts.scope);
  const series = block.series.map((s, i) => resolveSeries(s, i, ctx, opts.scope, block.colors, style));
  const isPie = block.kind === 'pie' || block.kind === 'donut';

  if (series.length === 0 || (isPie && series[0]!.values.length === 0)) {
    return [{ height: 0, before: margin.top, after: margin.bottom, commands: [], avoidSplit: true }];
  }

  const catCount = isPie
    ? series[0]!.values.length
    : Math.max(categories.length, ...series.map((s) => s.values.length), 1);
  const catNames = Array.from({ length: catCount }, (_, i) => categories[i] ?? String(i + 1));

  const commands: DrawCommand[] = [];
  const totalHeight = Math.max(40, toPt(block.height, block.plotHeight ?? 160));
  const legendSide = block.legend ?? (isPie ? 'right' : series.length > 1 ? 'bottom' : 'none');

  // --- title ---------------------------------------------------------------
  let titleHeight = 0;
  if (block.title !== undefined) {
    const titleStyle = ctx.style({ fontWeight: 700, fontSize: style.fontSize + 1 }, style);
    const titleResult = typeset(resolveContent(block.title, ctx, titleStyle, opts.scope), width);
    for (const line of titleResult.lines) {
      commands.push({
        op: 'text',
        x: left,
        baselineY: titleHeight + line.ascent,
        runs: line.runs,
        gapWidth: 0,
        decorations: [],
      });
      titleHeight += line.height;
    }
    if (titleHeight > 0) titleHeight += LABEL_GAP;
  }

  // --- legend content ------------------------------------------------------
  const legendItems: Array<{ color: RGB; label: string }> = isPie
    ? (() => {
        const values = catNames.map((_, i) => Math.max(0, series[0]!.values[i] ?? 0));
        const total = values.reduce((a, b) => a + b, 0) || 1;
        return catNames.map((name, i) => ({
          color: palette(block.colors, i),
          label: `${name} ${Math.round((values[i]! / total) * 100)}%`,
        }));
      })()
    : series.map((s, i) => ({ color: s.color, label: s.name ?? `Series ${i + 1}` }));

  const legend = measureLegend(legendItems, labelStyle, legendSide === 'right' ? width * 0.32 : width, legendSide);
  const plotWidth = Math.max(16, width - (legendSide === 'right' ? legend.width + ITEM_GAP : 0));

  let cursorY = titleHeight + (legendSide === 'top' ? legend.height + LABEL_GAP : 0);
  const plotTop = cursorY;
  const plotHeight = Math.max(
    24,
    totalHeight - plotTop - (block.categoryLabels !== false && !isPie ? labelHeight + LABEL_GAP : 0),
  );
  const plotBottom = plotTop + plotHeight;

  // --- axes ----------------------------------------------------------------
  const includeZero = !isPie && block.kind !== 'line';
  const domain = isPie ? undefined : computeDomain(series, block.stacked === true, block.valueAxis, includeZero);
  const tickLabels = domain
    ? domain.ticks.map((v) => formatTick(v, block.valueAxis?.format))
    : [];
  const showAxisLabels = block.valueAxis?.labels !== false;
  const gutter = showAxisLabels && !isPie && tickLabels.length
    ? Math.max(...tickLabels.map((t) => measure(t, labelStyle))) + 6
    : 0;
  const plotX = left + gutter;
  const plotW = Math.max(16, plotWidth - gutter);
  const bandW = plotW / Math.max(1, catCount);

  const yOf = (v: number): number => {
    const d = domain!;
    const t = (v - d.min) / (d.max - d.min || 1);
    return plotBottom - t * plotHeight;
  };

  if (legendSide === 'top') drawLegend(commands, legend, 0, titleHeight, labelStyle, ascent);
  if (legendSide === 'right') drawLegend(commands, legend, left + plotWidth + ITEM_GAP, plotTop, labelStyle, ascent);

  // --- plot ----------------------------------------------------------------
  if (isPie) {
    drawPie(commands, block, series[0]!, catNames, plotX, plotTop, plotW, plotHeight, labelStyle, ascent, descent);
  } else {
    // Grid lines + value labels.
    if (block.valueAxis?.gridLines !== false) {
      for (const v of domain!.ticks) {
        const y = yOf(v);
        commands.push({ op: 'line', x1: plotX, y1: y, x2: plotX + plotW, y2: y, color: GRID, lineWidth: 0.5 });
        if (showAxisLabels) {
          const text = formatTick(v, block.valueAxis?.format);
          const w = measure(text, labelStyle);
          pushText(commands, text, labelStyle, plotX - 6 - w, y + ascent * 0.35, TEXT_MUTED);
        }
      }
    }
    // Value-zero baseline.
    if (domain!.min <= 0 && domain!.max >= 0) {
      const y = yOf(0);
      commands.push({ op: 'line', x1: plotX, y1: y, x2: plotX + plotW, y2: y, color: AXIS, lineWidth: 0.8 });
    }

    if (block.kind === 'bar') {
      drawBars(commands, block, series, catCount, plotX, plotBottom, bandW, yOf, labelStyle);
    } else {
      drawLines(commands, block, series, catCount, plotX, bandW, yOf, labelStyle, ascent);
    }

    // Category labels.
    if (block.categoryLabels !== false) {
      const y = plotBottom + LABEL_GAP + ascent;
      for (let i = 0; i < catCount; i += 1) {
        const text = clipText(catNames[i]!, labelStyle, bandW - 4);
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, plotX + i * bandW + (bandW - w) / 2, y, TEXT_MUTED);
      }
    }
  }

  // Reserved strips below the plot: category labels first, then the legend.
  const labelStrip = block.categoryLabels !== false && !isPie ? labelHeight + LABEL_GAP : 0;
  const legendStrip = legendSide === 'bottom' ? legend.height + LABEL_GAP : 0;

  if (legendSide === 'bottom') {
    drawLegend(commands, legend, left, plotBottom + labelStrip + LABEL_GAP, labelStyle, ascent);
  }

  // Background/border painting is reused from the box model conventions.
  const boxW = opts.contentWidth - margin.left - margin.right;
  // The fragment must cover every reserved strip; otherwise a bottom legend
  // paints past the block and collides with whatever follows it.
  const height = Math.max(
    totalHeight,
    plotBottom + labelStrip + legendStrip,
    legendSide === 'right' ? plotTop + legend.height : 0,
  );
  const framed: DrawCommand[] = [];
  if (style.backgroundColor !== undefined) {
    framed.push({ op: 'fillRect', x: 0, y: 0, w: boxW, h: height, color: toRGB(style.backgroundColor) });
  }
  framed.push(...commands);

  return [
    {
      height,
      before: margin.top + padding.top,
      after: margin.bottom + padding.bottom,
      commands: framed,
      avoidSplit: true,
      breakBefore: block.breakBefore,
      breakAfter: block.breakAfter,
      keepWithNext: block.keepWithNext,
    },
  ];
}

// --- series resolution -----------------------------------------------------

function resolveSeries(
  series: ChartSeries,
  index: number,
  ctx: LayoutContext,
  scope: ExprContext,
  colors: unknown,
  _style: ResolvedStyle,
): Slice {
  const values = resolveNumbers(series.values, ctx, scope);
  const color = series.color !== undefined ? toRGB(series.color) : palette(colors, index);
  return { name: series.name, values, color, format: series.format };
}

function palette(colors: unknown, i: number): RGB {
  if (Array.isArray(colors) && colors.length > 0) return toRGB(colors[i % colors.length]);
  return DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!;
}

function resolveStrings(value: string[] | string | Expr | undefined, ctx: LayoutContext, scope: ExprContext): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    if (looksLikeBinding(value)) {
      const resolved = ctx.eval(value, scope);
      if (Array.isArray(resolved)) return resolved.map((v) => String(v));
      if (resolved !== undefined && resolved !== null) return String(resolved).split(',').map((s) => s.trim());
    }
    return value.split(',').map((s) => s.trim());
  }
  const resolved = ctx.eval(value, scope);
  if (Array.isArray(resolved)) return resolved.map((v) => String(v));
  return resolved === undefined || resolved === null ? [] : [String(resolved)];
}

function resolveNumbers(value: number[] | string | Expr, ctx: LayoutContext, scope: ExprContext): number[] {
  const coerce = (raw: unknown): number[] => {
    if (Array.isArray(raw)) return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (typeof raw === 'number') return Number.isFinite(raw) ? [raw] : [];
    if (typeof raw === 'string') {
      return raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    }
    return [];
  };
  if (Array.isArray(value)) return coerce(value);
  if (typeof value === 'string') {
    return looksLikeBinding(value) ? coerce(ctx.eval(value, scope)) : coerce(value);
  }
  return coerce(ctx.eval(value, scope));
}

function looksLikeBinding(text: string): boolean {
  return /[$()]/.test(text) && !/^[^$]*,[^$]*$/.test(text.trim());
}

// --- axes ------------------------------------------------------------------

interface Domain {
  min: number;
  max: number;
  ticks: number[];
}

function computeDomain(series: Slice[], stacked: boolean, axis: ValueAxisOptions | undefined, includeZero: boolean): Domain {
  const values: number[] = [];
  if (stacked) {
    const count = Math.max(...series.map((s) => s.values.length), 0);
    for (let i = 0; i < count; i += 1) {
      let positive = 0;
      let negative = 0;
      for (const s of series) {
        const v = s.values[i] ?? 0;
        if (v >= 0) positive += v;
        else negative += v;
      }
      values.push(positive, negative);
    }
  } else {
    for (const s of series) values.push(...s.values);
  }
  let min = axis?.min ?? (includeZero ? Math.min(0, ...values) : Math.min(...values));
  let max = axis?.max ?? (includeZero ? Math.max(0, ...values) : Math.max(...values));
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max === min) max = min + 1;
  const nice = niceTicks(min, max, axis?.ticks ?? 5);
  const lo = axis?.min ?? nice.min;
  const hi = axis?.max ?? nice.max;
  return {
    min: lo,
    max: hi,
    ticks: nice.ticks.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9),
  };
}

function niceTicks(min: number, max: number, count: number): Domain {
  const target = Math.max(2, count);
  const span = max - min;
  const rough = span / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Guard against pathological steps producing more than a few hundred ticks.
  for (let v = lo, n = 0; v <= hi + step * 1e-9 && n < 512; v += step, n += 1) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toFixed(10)));
  }
  return { min: lo, max: hi, ticks };
}

function formatTick(value: number, pattern: string | undefined): string {
  return formatNumber(value, pattern ?? '#,##0.###').text;
}

// --- bar / line / area -----------------------------------------------------

function drawBars(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  catCount: number,
  plotX: number,
  plotBottom: number,
  bandW: number,
  yOf: (v: number) => number,
  labelStyle: ResolvedStyle,
): void {
  const groupW = bandW * 0.74;
  const barW = Math.max(1, groupW / (block.stacked ? 1 : series.length));
  const zeroY = yOf(0);

  for (let i = 0; i < catCount; i += 1) {
    const groupX = plotX + i * bandW + (bandW - groupW) / 2;
    let positive = 0;
    let negative = 0;
    for (let s = 0; s < series.length; s += 1) {
      const slice = series[s]!;
      const value = slice.values[i] ?? 0;
      const valueY = yOf(value);
      let y: number;
      let h: number;
      if (block.stacked) {
        const base = value >= 0 ? positive : negative;
        const top = base + value;
        const baseY = yOf(base);
        const topY = yOf(top);
        y = Math.min(baseY, topY);
        h = Math.max(0.5, Math.abs(baseY - topY));
        if (value >= 0) positive = top;
        else negative = top;
      } else {
        y = Math.min(zeroY, valueY);
        h = Math.max(0.5, Math.abs(zeroY - valueY));
      }
      const x = block.stacked ? groupX : groupX + s * barW;
      commands.push({ op: 'fillRect', x, y, w: block.stacked ? groupW : Math.max(0.5, barW - 1), h, color: slice.color });
      if (block.showValues) {
        const text = formatTick(value, slice.format ?? block.valueAxis?.format);
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, x + (barW - w) / 2, (value >= 0 ? y : y + h) - 3, TEXT_MUTED);
      }
    }
  }
  void plotBottom;
}

function drawLines(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  catCount: number,
  plotX: number,
  bandW: number,
  yOf: (v: number) => number,
  labelStyle: ResolvedStyle,
  ascent: number,
): void {
  const pointX = (i: number): number => plotX + i * bandW + bandW / 2;
  const zeroY = yOf(0);

  if (block.kind === 'area' && block.stacked) {
    // Stacked areas: each series floats on the cumulative total below it.
    const below = new Array<number>(catCount).fill(0);
    for (const slice of series) {
      const top = Array.from({ length: catCount }, (_, i) => (below[i] ?? 0) + (slice.values[i] ?? 0));
      const band: PolyPoint[] = [
        ...top.map((v, i) => [pointX(i), yOf(v)] as PolyPoint),
        ...below
          .slice()
          .reverse()
          .map((v, ri) => [pointX(catCount - 1 - ri), yOf(v)] as PolyPoint),
      ];
      commands.push({ op: 'poly', points: band, fill: slice.color, fillOpacity: 0.35, close: true });
      commands.push({
        op: 'poly',
        points: top.map((v, i) => [pointX(i), yOf(v)] as PolyPoint),
        stroke: { color: slice.color, lineWidth: 1 },
      });
      for (let i = 0; i < catCount; i += 1) below[i] = top[i] ?? 0;
    }
    return;
  }

  for (const slice of series) {
    if (slice.values.length === 0) continue;
    const points: PolyPoint[] = slice.values.map((v, i) => [pointX(i), yOf(v)] as PolyPoint);

    if (block.kind === 'area') {
      const area: PolyPoint[] = [...points, [pointX(slice.values.length - 1), zeroY], [pointX(0), zeroY]];
      commands.push({ op: 'poly', points: area, fill: slice.color, fillOpacity: 0.28, close: true });
    }

    commands.push({ op: 'poly', points, stroke: { color: slice.color, lineWidth: 1.5 } });

    if (block.showValues) {
      for (let i = 0; i < slice.values.length; i += 1) {
        const text = formatTick(slice.values[i]!, slice.format ?? block.valueAxis?.format);
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, pointX(i) - w / 2, yOf(slice.values[i]!) - 4, TEXT_MUTED);
      }
    }
  }
  void ascent;
}

// --- pie / donut -----------------------------------------------------------

function drawPie(
  commands: DrawCommand[],
  block: ChartBlock,
  slice: Slice,
  names: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  labelStyle: ResolvedStyle,
  ascent: number,
  _descent: number,
): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const radius = Math.max(4, Math.min(w, h) / 2 - 2);
  const inner = block.kind === 'donut' ? radius * Math.min(0.9, Math.max(0, block.innerRadius ?? 0.55)) : 0;
  const values = slice.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);

  if (total <= 0) {
    commands.push({ op: 'poly', points: circle(cx, cy, radius, 0, Math.PI * 2), fill: GRID, close: true });
    return;
  }

  let angle = -Math.PI / 2;
  for (let i = 0; i < values.length; i += 1) {
    const sweep = (values[i]! / total) * Math.PI * 2;
    if (sweep <= 1e-6) continue;
    // Pie/donut slices take their colour from the palette (per category), not
    // from the series colour, so a single-series pie still reads as many slices.
    const color = palette(undefined, i);
    const end = angle + sweep;
    const border = values.length > 1 ? { color: [1, 1, 1] as RGB, lineWidth: 1 } : undefined;

    if (inner > 0) {
      // One closed ring sector: outer arc from `angle` to `end`, then the inner
      // arc walked back from `end` to `angle`. The opposite winding makes the
      // hole cancel under the nonzero fill rule, so no second subpath is needed.
      const outer = circle(cx, cy, radius, angle, end);
      const hole = circle(cx, cy, inner, end, angle);
      commands.push({ op: 'poly', points: [...outer, ...hole], fill: color, stroke: border, close: true });
    } else {
      commands.push({ op: 'poly', points: [[cx, cy], ...circle(cx, cy, radius, angle, end)], fill: color, stroke: border, close: true });
    }

    if (sweep > 0.45 && radius > 24) {
      const mid = angle + sweep / 2;
      const labelR = inner > 0 ? (radius + inner) / 2 : radius * 0.66;
      const text = String(Math.round((values[i]! / total) * 100)) + '%';
      const tw = measure(text, labelStyle);
      pushText(commands, text, labelStyle, cx + Math.cos(mid) * labelR - tw / 2, cy + Math.sin(mid) * labelR + ascent * 0.35, [1, 1, 1]);
    }
    void names;
    angle = end;
  }
}

/**
 * Sample a circular arc into a polygon. pdfkit's own `arc()` implicitly starts
 * a new subpath, which would break compound paths such as a donut ring; sampling
 * keeps the whole outline in one path.
 */
function circle(cx: number, cy: number, r: number, from: number, to: number): PolyPoint[] {
  const sweep = Math.abs(to - from);
  const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 32)));
  const points: PolyPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = from + ((to - from) * i) / steps;
    points.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  return points;
}

// --- legend ----------------------------------------------------------------

interface LegendLayout {
  items: Array<{ color: RGB; label: string }>;
  width: number;
  height: number;
  /** Wrap positions for top/bottom legends: [itemIndex, row, x]. */
  rows: Array<Array<{ item: number; x: number; w: number; textW: number }>>;
  position: 'none' | 'top' | 'bottom' | 'right';
}

function measureLegend(
  items: Array<{ color: RGB; label: string }>,
  style: ResolvedStyle,
  maxWidth: number,
  position: 'none' | 'top' | 'bottom' | 'right',
): LegendLayout {
  if (position === 'none' || items.length === 0) {
    return { items, width: 0, height: 0, rows: [], position: 'none' };
  }
  const lineH = style.lineHeight;

  if (position === 'right') {
    let width = 0;
    for (const item of items) width = Math.max(width, SWATCH + SWATCH_GAP + measure(item.label, style));
    return {
      items,
      width: Math.min(width, maxWidth),
      height: items.length * lineH,
      rows: items.map((_, i) => [{ item: i, x: 0, w: width, textW: width - SWATCH - SWATCH_GAP }]),
      position,
    };
  }

  const rows: Array<Array<{ item: number; x: number; w: number; textW: number }>> = [];
  let row: Array<{ item: number; x: number; w: number; textW: number }> = [];
  let rowWidth = 0;
  for (let i = 0; i < items.length; i += 1) {
    const textW = measure(items[i]!.label, style);
    const itemW = SWATCH + SWATCH_GAP + textW;
    if (row.length > 0 && rowWidth + ITEM_GAP + itemW > maxWidth) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    const x = row.length === 0 ? 0 : rowWidth + ITEM_GAP;
    row.push({ item: i, x, w: itemW, textW });
    rowWidth = x + itemW;
  }
  if (row.length > 0) rows.push(row);
  return { items, width: Math.min(maxWidth, rowWidth), height: rows.length * lineH, rows, position };
}

function drawLegend(
  commands: DrawCommand[],
  legend: LegendLayout,
  x: number,
  y: number,
  style: ResolvedStyle,
  ascent: number,
): void {
  if (legend.position === 'none') return;
  const lineH = style.lineHeight;
  for (let r = 0; r < legend.rows.length; r += 1) {
    for (const cell of legend.rows[r]!) {
      const item = legend.items[cell.item]!;
      const cy = y + r * lineH + lineH / 2;
      commands.push({ op: 'fillRect', x: x + cell.x, y: cy - SWATCH / 2, w: SWATCH, h: SWATCH, color: item.color });
      pushText(commands, item.label, style, x + cell.x + SWATCH + SWATCH_GAP, y + r * lineH + ascent, TEXT_MUTED);
    }
  }
}

// --- text helpers ----------------------------------------------------------

function pushText(
  commands: DrawCommand[],
  text: string,
  style: ResolvedStyle,
  x: number,
  baselineY: number,
  color?: RGB,
): void {
  if (!text) return;
  const result = typeset([{ text, style }], UNBOUNDED);
  const line = result.lines[0];
  if (!line) return;
  if (color) {
    for (const run of line.runs) run.style = { ...run.style, color };
  }
  commands.push({ op: 'text', x, baselineY, runs: line.runs, gapWidth: 0, decorations: [] });
}

function measure(text: string, style: ResolvedStyle): number {
  if (!text) return 0;
  return typeset([{ text, style }], UNBOUNDED).lines[0]?.width ?? 0;
}

/** Truncate with an ellipsis so a long category label cannot spill into its neighbour. */
function clipText(text: string, style: ResolvedStyle, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (measure(text, style) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + '\u2026', style) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '\u2026' : '';
}
