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
import type { ChartBlock, ChartSeries, Expr, ValueAxisOptions, GanttTask } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import { typeset } from '../text/typeset.js';
import { resolveContent, type LayoutContext } from './context.js';
import type { BlockLayoutOptions } from './block.js';
import { resolveBox, type EdgeInsets } from './box.js';
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
  /** Combo charts: how this series is drawn (default `'bar'`). */
  type?: 'bar' | 'line' | 'area';
  /** Combo charts: which value axis this series reads (default `'left'`). */
  axis?: 'left' | 'right';
  /** Scatter / bubble: the x-coordinate per point (defaults to the index). */
  xValues: number[];
  /** Bubble: marker radius per point (normalised at draw time). */
  rValues: number[];
  /** Range bars: lower / upper end of each bar. */
  low: number[];
  high: number[];
}

/** Percent labels use a quoted `%` so the formatter does not scale again. */
const PERCENT_FORMAT = '0"%"';

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

  // Gantt charts use a completely different data model; dispatch early.
  if (block.kind === 'gantt') {
    return layoutGantt(block, ctx, opts, inherited, style, left, width, margin);
  }

  // Labels are one notch smaller than body text so the plot keeps the room.
  const labelStyle = ctx.style({ fontSize: Math.max(5.5, style.fontSize - 2) }, style);
  const units = labelStyle.handle.unitsPerEm || 1000;
  const ascent = (labelStyle.handle.ascender / units) * labelStyle.fontSize;
  const descent = (Math.abs(labelStyle.handle.descender) / units) * labelStyle.fontSize;
  const labelHeight = ascent + descent;

  const categories = resolveStrings(block.categories, ctx, opts.scope);
  const isPie = block.kind === 'pie' || block.kind === 'donut';
  const isCombo = block.kind === 'combo';
  const isWaterfall = block.kind === 'waterfall';
  const isScatter = block.kind === 'scatter' || block.kind === 'bubble';
  const isRadar = block.kind === 'radar';
  const isGauge = block.kind === 'gauge';
  const isHeatmap = block.kind === 'heatmap';
  // Cartesian kinds share the value axis, grid lines and (band- or point-based) x
  // scale; pie/radar/gauge/heatmap are plotted into the box without those axes.
  const isCartesian = !isPie && !isRadar && !isGauge && !isHeatmap;
  const percentStack = block.stacked === '100%';
  const stacked = block.stacked === true;
  const resolved = block.series.map((s, i) => resolveSeries(s, i, ctx, opts.scope, block.colors, style));
  // Waterfalls read one delta series; percent stacking normalises every slice
  // against its category total so the axis reads 0–100%.
  const series = isWaterfall ? resolved.slice(0, 1) : percentStack ? percentSlices(resolved) : resolved;

  if (series.length === 0 || (isPie && series[0]!.values.length === 0)) {
    return [{ height: 0, before: margin.top, after: margin.bottom, commands: [], avoidSplit: true }];
  }

  const catCount = isPie
    ? series[0]!.values.length
    : Math.max(categories.length, ...series.map((s) => Math.max(s.values.length, s.xValues.length)), 1);
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
    totalHeight - plotTop - (block.categoryLabels !== false && isCartesian ? labelHeight + LABEL_GAP : 0),
  );
  const plotBottom = plotTop + plotHeight;

  // --- axes ----------------------------------------------------------------
  const leftSeries = isCombo ? series.filter((s) => s.axis !== 'right') : series;
  const rightSeries = isCombo ? series.filter((s) => s.axis === 'right') : [];
  const includeZero = isCartesian && !isWaterfall && block.kind !== 'line' && !isScatter;
  const domain = !isCartesian
    ? undefined
    : isWaterfall
      ? computeWaterfallDomain(series[0]!, block)
      : computeDomain(leftSeries, stacked || percentStack, block.valueAxis, includeZero || percentStack);
  const rightDomain = rightSeries.length > 0 ? computeDomain(rightSeries, false, block.rightAxis, true) : undefined;
  const axisFormat = block.valueAxis?.format ?? (percentStack ? PERCENT_FORMAT : undefined);
  const tickLabels = domain ? domain.ticks.map((v) => formatTick(v, axisFormat)) : [];
  const showAxisLabels = block.valueAxis?.labels !== false;
  const gutter = showAxisLabels && !isPie && tickLabels.length
    ? Math.max(...tickLabels.map((t) => measure(t, labelStyle))) + 6
    : 0;
  const rightFormat = block.rightAxis?.format ?? (percentStack ? PERCENT_FORMAT : block.valueAxis?.format);
  const rightTickLabels = rightDomain ? rightDomain.ticks.map((v) => formatTick(v, rightFormat)) : [];
  const showRightLabels = (block.rightAxis?.labels ?? block.valueAxis?.labels) !== false;
  const rightGutter = showRightLabels && rightTickLabels.length
    ? Math.max(...rightTickLabels.map((t) => measure(t, labelStyle))) + 6
    : 0;
  const plotX = left + gutter;
  const plotW = Math.max(16, plotWidth - gutter - rightGutter);
  const bandW = plotW / Math.max(1, catCount);

  const mapY = (d: Domain, v: number): number => {
    const t = (v - d.min) / (d.max - d.min || 1);
    return plotBottom - t * plotHeight;
  };
  const yOf = (v: number): number => mapY(domain!, v);
  const yOfRight = (v: number): number => (rightDomain ? mapY(rightDomain, v) : yOf(v));
  /** Per-series scale: combo charts may read the right axis. */
  const yFor = (slice: Slice): ((v: number) => number) =>
    isCombo && slice.axis === 'right' ? yOfRight : yOf;

  const valueFormat = (slice: Slice): string | undefined => {
    if (slice.format) return slice.format;
    if (percentStack) return PERCENT_FORMAT;
    if (isCombo && slice.axis === 'right') return block.rightAxis?.format ?? block.valueAxis?.format;
    return block.valueAxis?.format;
  };

  // Scatter / bubble read a numeric x-axis; everything else uses category bands.
  const xDomain = isScatter ? computeScatterDomain(series) : undefined;
  const mapX = (v: number): number =>
    xDomain ? plotX + ((v - xDomain.min) / (xDomain.max - xDomain.min || 1)) * plotW : plotX + (v + 0.5) * bandW;

  if (legendSide === 'top') drawLegend(commands, legend, 0, titleHeight, labelStyle, ascent);
  if (legendSide === 'right') drawLegend(commands, legend, left + plotWidth + ITEM_GAP, plotTop, labelStyle, ascent);

  // --- plot ----------------------------------------------------------------
  if (isPie) {
    drawPie(commands, block, series[0]!, catNames, plotX, plotTop, plotW, plotHeight, labelStyle, ascent, descent);
  } else if (isGauge) {
    drawGauge(commands, block, series[0]!, plotX, plotTop, plotW, plotHeight, labelStyle, ascent, descent);
  } else if (isRadar) {
    drawRadar(commands, block, series, catNames, plotX, plotTop, plotW, plotHeight, labelStyle, ascent, descent);
  } else if (isHeatmap) {
    drawHeatmap(commands, block, series, catNames, plotX, plotTop, plotW, plotHeight, labelStyle, ascent, descent);
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
    // Scatter / bubble: vertical grid lines + numeric x tick labels.
    if (isScatter && xDomain) {
      for (const v of xDomain.ticks) {
        const x = mapX(v);
        if (block.valueAxis?.gridLines !== false) {
          commands.push({ op: 'line', x1: x, y1: plotTop, x2: x, y2: plotBottom, color: GRID, lineWidth: 0.5 });
        }
        if (block.categoryLabels !== false) {
          const text = formatTick(v, block.valueAxis?.xFormat);
          const w = measure(text, labelStyle);
          pushText(commands, text, labelStyle, x - w / 2, plotBottom + LABEL_GAP + ascent, TEXT_MUTED);
        }
      }
    }
    // Right-axis tick labels (combo). Grid lines stay on the left axis only.
    if (rightDomain && showRightLabels) {
      for (const v of rightDomain.ticks) {
        const y = yOfRight(v);
        const text = formatTick(v, rightFormat);
        pushText(commands, text, labelStyle, plotX + plotW + 6, y + ascent * 0.35, TEXT_MUTED);
      }
    }
    // Value-zero baseline.
    if (domain!.min <= 0 && domain!.max >= 0) {
      const y = yOf(0);
      commands.push({ op: 'line', x1: plotX, y1: y, x2: plotX + plotW, y2: y, color: AXIS, lineWidth: 0.8 });
    }

    if (isWaterfall) {
      drawWaterfall(commands, block, series[0]!, plotX, bandW, yOf, labelStyle, valueFormat);
    } else if (isScatter) {
      drawScatter(commands, block, series, mapX, yOf, labelStyle, block.kind === 'bubble');
    } else if (isCombo) {
      // Bars first so lines/areas read on top of them.
      const bars = series.filter((s) => (s.type ?? 'bar') === 'bar');
      const lines = series.filter((s) => (s.type ?? 'bar') !== 'bar');
      if (bars.length > 0) drawBars(commands, block, bars, catCount, plotX, bandW, yFor, labelStyle, false, valueFormat);
      if (lines.length > 0) drawLines(commands, block, lines, catCount, plotX, bandW, yFor, labelStyle, ascent, false, valueFormat);
    } else if (block.range) {
      drawRange(commands, block, series, catCount, plotX, bandW, yOf, labelStyle, valueFormat);
    } else if (block.kind === 'bar') {
      drawBars(commands, block, series, catCount, plotX, bandW, yFor, labelStyle, stacked, valueFormat);
    } else {
      drawLines(commands, block, series, catCount, plotX, bandW, yFor, labelStyle, ascent, stacked, valueFormat);
    }

    // Threshold / reference lines across the value axis.
    if (block.referenceLines?.length) {
      drawReferenceLines(commands, block.referenceLines, plotX, plotW, yOf, yOfRight, labelStyle);
    }

    // Category labels (band charts only; scatter already drew numeric x ticks).
    if (block.categoryLabels !== false && !isScatter) {
      const y = plotBottom + LABEL_GAP + ascent;
      for (let i = 0; i < catCount; i += 1) {
        const text = clipText(catNames[i]!, labelStyle, bandW - 4);
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, plotX + i * bandW + (bandW - w) / 2, y, TEXT_MUTED);
      }
    }
  }

  // Reserved strips below the plot: category labels first, then the legend.
  const labelStrip = block.categoryLabels !== false && isCartesian ? labelHeight + LABEL_GAP : 0;
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
  // A missing x-column defaults to 0,1,2,… so a lone `values` array still plots.
  const xValues = series.xValues !== undefined ? resolveNumbers(series.xValues, ctx, scope) : values.map((_, i) => i);
  const rValues = series.rValues !== undefined ? resolveNumbers(series.rValues, ctx, scope) : [];
  const low = series.low !== undefined ? resolveNumbers(series.low, ctx, scope) : [];
  const high = series.high !== undefined ? resolveNumbers(series.high, ctx, scope) : [];
  return { name: series.name, values, color, format: series.format, type: series.type, axis: series.axis, xValues, rValues, low, high };
}

function palette(colors: unknown, i: number): RGB {
  if (Array.isArray(colors) && colors.length > 0) return toRGB(colors[i % colors.length]);
  return DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]!;
}

/** Normalise every category to 100% across the series, keeping each value's sign. */
function percentSlices(series: Slice[]): Slice[] {
  const count = Math.max(...series.map((s) => s.values.length), 0);
  const totals = Array.from({ length: count }, (_, i) => {
    let sum = 0;
    for (const s of series) sum += Math.abs(s.values[i] ?? 0);
    return sum;
  });
  return series.map((slice) => ({
    ...slice,
    values: slice.values.map((v, i) => {
      const total = totals[i] ?? 0;
      return total === 0 ? 0 : (v / total) * 100;
    }),
  }));
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
  bandW: number,
  yFor: (slice: Slice) => (v: number) => number,
  labelStyle: ResolvedStyle,
  stacked: boolean,
  formatFor: (slice: Slice) => string | undefined,
): void {
  const groupW = bandW * 0.74;
  const barW = Math.max(1, groupW / (stacked ? 1 : series.length));
  const stackY = stacked ? yFor(series[0]!) : undefined;

  for (let i = 0; i < catCount; i += 1) {
    const groupX = plotX + i * bandW + (bandW - groupW) / 2;
    let positive = 0;
    let negative = 0;
    for (let s = 0; s < series.length; s += 1) {
      const slice = series[s]!;
      const value = slice.values[i] ?? 0;
      let y: number;
      let h: number;
      if (stacked) {
        const base = value >= 0 ? positive : negative;
        const top = base + value;
        const baseY = stackY!(base);
        const topY = stackY!(top);
        y = Math.min(baseY, topY);
        h = Math.max(0.5, Math.abs(baseY - topY));
        if (value >= 0) positive = top;
        else negative = top;
      } else {
        const zeroY = yFor(slice)(0);
        const valueY = yFor(slice)(value);
        y = Math.min(zeroY, valueY);
        h = Math.max(0.5, Math.abs(zeroY - valueY));
      }
      const x = stacked ? groupX : groupX + s * barW;
      commands.push({ op: 'fillRect', x, y, w: stacked ? groupW : Math.max(0.5, barW - 1), h, color: slice.color });
      if (block.showValues) {
        const text = formatTick(value, formatFor(slice));
        const w = measure(text, labelStyle);
        const barX = stacked ? groupX : x;
        pushText(commands, text, labelStyle, barX + (barW - w) / 2, (value >= 0 ? y : y + h) - 3, TEXT_MUTED);
      }
    }
  }
}

function drawLines(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  catCount: number,
  plotX: number,
  bandW: number,
  yFor: (slice: Slice) => (v: number) => number,
  labelStyle: ResolvedStyle,
  ascent: number,
  stacked: boolean,
  formatFor: (slice: Slice) => string | undefined,
): void {
  const pointX = (i: number): number => plotX + i * bandW + bandW / 2;
  const kindOf = (slice: Slice): 'line' | 'area' =>
    (slice.type ?? (block.kind === 'area' ? 'area' : 'line')) === 'area' ? 'area' : 'line';

  if (stacked && block.kind === 'area') {
    // Stacked areas: each series floats on the cumulative total below it.
    const first = series[0];
    if (!first) return;
    const baseY = yFor(first);
    const below = new Array<number>(catCount).fill(0);
    for (const slice of series) {
      const top = Array.from({ length: catCount }, (_, i) => (below[i] ?? 0) + (slice.values[i] ?? 0));
      const band: PolyPoint[] = [
        ...top.map((v, i) => [pointX(i), baseY(v)] as PolyPoint),
        ...below
          .slice()
          .reverse()
          .map((v, ri) => [pointX(catCount - 1 - ri), baseY(v)] as PolyPoint),
      ];
      commands.push({ op: 'poly', points: band, fill: slice.color, fillOpacity: 0.35, close: true });
      commands.push({
        op: 'poly',
        points: top.map((v, i) => [pointX(i), baseY(v)] as PolyPoint),
        stroke: { color: slice.color, lineWidth: 1 },
      });
      for (let i = 0; i < catCount; i += 1) below[i] = top[i] ?? 0;
    }
    return;
  }

  for (const slice of series) {
    if (slice.values.length === 0) continue;
    const yOf = yFor(slice);
    const points: PolyPoint[] = slice.values.map((v, i) => [pointX(i), yOf(v)] as PolyPoint);

    if (kindOf(slice) === 'area') {
      const zeroY = yOf(0);
      const area: PolyPoint[] = [...points, [pointX(slice.values.length - 1), zeroY], [pointX(0), zeroY]];
      commands.push({ op: 'poly', points: area, fill: slice.color, fillOpacity: 0.28, close: true });
    }

    commands.push({ op: 'poly', points, stroke: { color: slice.color, lineWidth: 1.5 } });

    if (block.showValues) {
      for (let i = 0; i < slice.values.length; i += 1) {
        const text = formatTick(slice.values[i]!, formatFor(slice));
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, pointX(i) - w / 2, yOf(slice.values[i]!) - 4, TEXT_MUTED);
      }
    }
  }
  void ascent;
}

// --- waterfall -------------------------------------------------------------

interface WaterfallBar {
  start: number;
  end: number;
  value: number;
  kind: 'increase' | 'decrease' | 'total';
}

/** Turn one delta series into running-total spans; a `totals` index is a 0-based bar. */
function waterfallBars(slice: Slice, totals: Set<number>): WaterfallBar[] {
  let running = 0;
  return slice.values.map((v, i) => {
    if (totals.has(i)) {
      // The first bar seeds the running total (a starting balance); later totals
      // just summarise what has accumulated so far.
      if (i === 0) running = v;
      return { start: 0, end: running, value: running, kind: 'total' };
    }
    const bar: WaterfallBar = { start: running, end: running + v, value: v, kind: v >= 0 ? 'increase' : 'decrease' };
    running += v;
    return bar;
  });
}

function computeWaterfallDomain(slice: Slice, block: ChartBlock): Domain {
  const values = [0];
  for (const bar of waterfallBars(slice, new Set(block.totals ?? []))) values.push(bar.start, bar.end);
  const axis = block.valueAxis;
  let min = axis?.min ?? Math.min(...values);
  let max = axis?.max ?? Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max === min) max = min + 1;
  const nice = niceTicks(min, max, axis?.ticks ?? 5);
  const lo = axis?.min ?? nice.min;
  const hi = axis?.max ?? nice.max;
  return { min: lo, max: hi, ticks: nice.ticks.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9) };
}

function drawWaterfall(
  commands: DrawCommand[],
  block: ChartBlock,
  slice: Slice,
  plotX: number,
  bandW: number,
  yOf: (v: number) => number,
  labelStyle: ResolvedStyle,
  formatFor: (slice: Slice) => string | undefined,
): void {
  const bars = waterfallBars(slice, new Set(block.totals ?? []));
  const groupW = bandW * 0.74;
  const colors = block.waterfallColors ?? {};
  const colorOf = (kind: WaterfallBar['kind']): RGB =>
    toRGB(
      kind === 'total'
        ? colors.total ?? '#0f3b6d'
        : kind === 'increase'
          ? colors.increase ?? '#1b7f4b'
          : colors.decrease ?? '#b23b3b',
    );
  let prevX: number | undefined;
  let prevY: number | undefined;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const x = plotX + i * bandW + (bandW - groupW) / 2;
    const y0 = yOf(bar.start);
    const y1 = yOf(bar.end);
    const top = Math.min(y0, y1);
    const height = Math.max(0.5, Math.abs(y0 - y1));
    commands.push({ op: 'fillRect', x, y: top, w: groupW, h: height, color: colorOf(bar.kind) });
    // Dashed connector from where the previous bar ended to where this one starts.
    if (prevX !== undefined && prevY !== undefined) {
      commands.push({ op: 'line', x1: prevX, y1: prevY, x2: x, y2: prevY, color: AXIS, lineWidth: 0.6, dash: [2, 2] });
    }
    prevX = x + groupW;
    prevY = yOf(bar.end);
    if (block.showValues) {
      const text = formatTick(bar.value, formatFor(slice));
      const w = measure(text, labelStyle);
      pushText(commands, text, labelStyle, x + (groupW - w) / 2, top - 3, TEXT_MUTED);
    }
  }
}

// --- scatter / bubble / range / reference --------------------------------

/** Numeric x-axis extent for scatter / bubble charts. */
function computeScatterDomain(series: Slice[]): Domain {
  const xs: number[] = [];
  for (const s of series) xs.push(...s.xValues);
  let min = xs.length ? Math.min(...xs) : 0;
  let max = xs.length ? Math.max(...xs) : 1;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (max === min) max = min + 1;
  const nice = niceTicks(min, max, 5);
  return { min: nice.min, max: nice.max, ticks: nice.ticks };
}

function drawScatter(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  mapX: (v: number) => number,
  yOf: (v: number) => number,
  labelStyle: ResolvedStyle,
  bubble: boolean,
): void {
  let rMin = Infinity;
  let rMax = 0;
  if (bubble) {
    for (const s of series) for (const r of s.rValues) {
      if (Number.isFinite(r)) {
        rMin = Math.min(rMin, r);
        rMax = Math.max(rMax, r);
      }
    }
  }
  for (const slice of series) {
    const n = Math.max(slice.values.length, slice.xValues.length);
    for (let i = 0; i < n; i += 1) {
      const x = mapX(slice.xValues[i] ?? i);
      const y = yOf(slice.values[i] ?? 0);
      let r = 2.5;
      if (bubble) {
        const rv = slice.rValues[i] ?? rMin;
        const t = rMax > rMin ? (rv - rMin) / (rMax - rMin) : 0.5;
        r = 2 + t * 12;
      }
      commands.push({ op: 'poly', points: circle(x, y, r, 0, Math.PI * 2), fill: slice.color, fillOpacity: 0.82, close: true });
    }
    if (block.showValues) {
      for (let i = 0; i < slice.values.length; i += 1) {
        const text = formatTick(slice.values[i]!, slice.format);
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, mapX(slice.xValues[i] ?? i) - w / 2, yOf(slice.values[i]!) - 6, TEXT_MUTED);
      }
    }
  }
}

/** High–low bars: each bar spans `low` → `high` instead of zero → value. */
function drawRange(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  catCount: number,
  plotX: number,
  bandW: number,
  yOf: (v: number) => number,
  labelStyle: ResolvedStyle,
  formatFor: (slice: Slice) => string | undefined,
): void {
  const groupW = bandW * 0.74;
  const barW = Math.max(1, groupW / series.length);
  for (let s = 0; s < series.length; s += 1) {
    const slice = series[s]!;
    const hasLow = slice.low.length > 0;
    const hasHigh = slice.high.length > 0;
    for (let i = 0; i < catCount; i += 1) {
      let lo: number;
      let hi: number;
      if (hasLow && hasHigh) {
        lo = slice.low[i] ?? 0;
        hi = slice.high[i] ?? 0;
      } else if (hasLow) {
        lo = slice.low[i] ?? 0;
        hi = slice.values[i] ?? 0;
      } else if (hasHigh) {
        hi = slice.high[i] ?? 0;
        lo = slice.values[i] ?? 0;
      } else {
        lo = 0;
        hi = slice.values[i] ?? 0;
      }
      const y0 = yOf(lo);
      const y1 = yOf(hi);
      const x = plotX + i * bandW + (bandW - groupW) / 2 + s * barW;
      commands.push({ op: 'fillRect', x, y: Math.min(y0, y1), w: Math.max(0.5, barW - 1), h: Math.max(0.5, Math.abs(y0 - y1)), color: slice.color });
      if (block.showValues) {
        const text = formatTick(hi, formatFor(slice));
        const w = measure(text, labelStyle);
        pushText(commands, text, labelStyle, x + (barW - w) / 2, Math.min(y0, y1) - 3, TEXT_MUTED);
      }
    }
  }
}

function drawReferenceLines(
  commands: DrawCommand[],
  lines: NonNullable<ChartBlock['referenceLines']>,
  plotX: number,
  plotW: number,
  yOf: (v: number) => number,
  yOfRight: (v: number) => number,
  labelStyle: ResolvedStyle,
): void {
  for (const rl of lines) {
    if (!Number.isFinite(rl.value)) continue;
    const y = rl.axis === 'right' ? yOfRight(rl.value) : yOf(rl.value);
    const color = rl.color !== undefined ? toRGB(rl.color) : ([0.7, 0.25, 0.25] as RGB);
    commands.push({ op: 'line', x1: plotX, y1: y, x2: plotX + plotW, y2: y, color, lineWidth: 1, dash: rl.dash ?? [5, 3] });
    if (rl.label) {
      const w = measure(rl.label, labelStyle);
      pushText(commands, rl.label, labelStyle, plotX + plotW - w, y - 3, color);
    }
  }
}

// --- radar -----------------------------------------------------------------

function drawRadar(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  catNames: string[],
  plotX: number,
  plotTop: number,
  plotW: number,
  plotHeight: number,
  labelStyle: ResolvedStyle,
  ascent: number,
  descent: number,
): void {
  const n = catNames.length;
  if (n < 3) return;
  void descent;
  const cx = plotX + plotW / 2;
  const cy = plotTop + plotHeight / 2;
  const R = Math.max(10, Math.min(plotW / 2, plotHeight / 2) - (ascent + descent + 16));
  let max = block.valueAxis?.max ?? 0;
  if (!max || max <= 0) {
    for (const s of series) for (const v of s.values) max = Math.max(max, Math.abs(v));
    if (max <= 0) max = 1;
  }
  const angleAt = (i: number): number => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pointAt = (i: number, frac: number): PolyPoint => {
    const a = angleAt(i);
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
  };

  const rings = block.valueAxis?.ticks ?? 4;
  for (let ring = 1; ring <= rings; ring += 1) {
    const pts: PolyPoint[] = [];
    for (let i = 0; i < n; i += 1) pts.push(pointAt(i, ring / rings));
    pts.push(pts[0]!);
    commands.push({ op: 'poly', points: pts, stroke: { color: GRID, lineWidth: 0.5 }, close: true });
  }
  for (let i = 0; i < n; i += 1) {
    const edge = pointAt(i, 1);
    commands.push({ op: 'line', x1: cx, y1: cy, x2: edge[0], y2: edge[1], color: GRID, lineWidth: 0.5 });
    const a = angleAt(i);
    const text = clipText(catNames[i]!, labelStyle, plotW / 3);
    const w = measure(text, labelStyle);
    const lx = cx + Math.cos(a) * (R + 8) - w / 2;
    const ly = cy + Math.sin(a) * (R + 8) + (Math.sin(a) < -0.2 ? -descent : Math.sin(a) > 0.2 ? ascent : ascent * 0.35);
    pushText(commands, text, labelStyle, lx, ly, TEXT_MUTED);
  }
  for (const slice of series) {
    const pts: PolyPoint[] = [];
    for (let i = 0; i < n; i += 1) {
      const v = slice.values[i] ?? 0;
      pts.push(pointAt(i, Math.max(0, Math.min(1, v / max))));
    }
    pts.push(pts[0]!);
    commands.push({ op: 'poly', points: pts, fill: slice.color, fillOpacity: 0.2, stroke: { color: slice.color, lineWidth: 1.5 }, close: true });
  }
}

// --- gauge -----------------------------------------------------------------

function drawGauge(
  commands: DrawCommand[],
  block: ChartBlock,
  slice: Slice,
  plotX: number,
  plotTop: number,
  plotW: number,
  plotHeight: number,
  labelStyle: ResolvedStyle,
  ascent: number,
  descent: number,
): void {
  void descent;
  const max = block.gaugeMax && block.gaugeMax > 0 ? block.gaugeMax : 100;
  const raw = block.gaugeValue !== undefined ? Number(block.gaugeValue) : slice.values[0];
  const value = Number.isFinite(raw as number) ? (raw as number) : 0;
  const cx = plotX + plotW / 2;
  const ring = Math.max(6, Math.min(plotW / 2, plotHeight) * 0.26);
  const R = Math.max(ring + 4, Math.min(plotW / 2 - 2, plotHeight - 2));
  const cy = plotTop + R + 2;
  const frac = Math.max(0, Math.min(1, value / max));

  // Track: a half annulus from 180° to 360° (opening upward in y-down space).
  const trackOuter = circle(cx, cy, R, Math.PI, Math.PI * 2);
  const trackInner = circle(cx, cy, R - ring, Math.PI * 2, Math.PI);
  commands.push({ op: 'poly', points: [...trackOuter, ...trackInner], fill: GRID, close: true });
  if (frac > 0.001) {
    const end = Math.PI + frac * Math.PI;
    const vo = circle(cx, cy, R, Math.PI, end);
    const vi = circle(cx, cy, R - ring, end, Math.PI);
    commands.push({ op: 'poly', points: [...vo, ...vi], fill: slice.color, close: true });
  }

  // Needle + hub.
  const na = Math.PI + frac * Math.PI;
  const tipX = cx + Math.cos(na) * (R - ring - 2);
  const tipY = cy + Math.sin(na) * (R - ring - 2);
  commands.push({ op: 'line', x1: cx, y1: cy, x2: tipX, y2: tipY, color: TEXT_MUTED, lineWidth: 1.6 });
  commands.push({ op: 'poly', points: circle(cx, cy, 3, 0, Math.PI * 2), fill: TEXT_MUTED, close: true });

  const fmt = block.valueAxis?.format;
  const zero = formatTick(0, fmt);
  const maxText = formatTick(max, fmt);
  pushText(commands, zero, labelStyle, cx - R - 2 - measure(zero, labelStyle), cy + ascent, TEXT_MUTED);
  pushText(commands, maxText, labelStyle, cx + R + 2, cy + ascent, TEXT_MUTED);
  const vText = formatTick(value, fmt);
  pushText(commands, vText, labelStyle, cx - measure(vText, labelStyle) / 2, cy - R * 0.4, slice.color);
}

// --- heatmap ---------------------------------------------------------------

function drawHeatmap(
  commands: DrawCommand[],
  block: ChartBlock,
  series: Slice[],
  catNames: string[],
  plotX: number,
  plotTop: number,
  plotW: number,
  plotHeight: number,
  labelStyle: ResolvedStyle,
  ascent: number,
  descent: number,
): void {
  const rows = series.length;
  const cols = Math.max(catNames.length, ...series.map((s) => s.values.length), 1);
  const from = toRGB(block.heatmapColors?.from ?? '#eef4ff');
  const to = toRGB(block.heatmapColors?.to ?? '#1e3a8a');
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const colOf = (t: number): RGB => [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];

  const labelW = series.reduce((m, s) => Math.max(m, measure(s.name ?? '', labelStyle)), 0) + 8;
  const gx = plotX + labelW;
  const gw = Math.max(1, plotW - labelW);
  const labelBand = ascent + descent + LABEL_GAP;
  const gridH = Math.max(1, plotHeight - labelBand);
  const cellW = gw / cols;
  const cellH = gridH / rows;

  let vmin = Infinity;
  let vmax = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      vmin = Math.min(vmin, v);
      vmax = Math.max(vmax, v);
    }
  }
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) {
    vmin = 0;
    vmax = 1;
  }
  const showLabels = block.heatmapLabels !== false;

  for (let r = 0; r < rows; r += 1) {
    const slice = series[r]!;
    if (slice.name) {
      const text = clipText(slice.name, labelStyle, labelW - 6);
      pushText(commands, text, labelStyle, plotX, plotTop + r * cellH + cellH / 2 + ascent * 0.35, TEXT_MUTED);
    }
    for (let c = 0; c < cols; c += 1) {
      const v = slice.values[c];
      if (v === undefined) continue;
      const t = vmax > vmin ? (v - vmin) / (vmax - vmin) : 0.5;
      const fill = colOf(t);
      const x = gx + c * cellW;
      const y = plotTop + r * cellH;
      commands.push({ op: 'fillRect', x, y, w: cellW - 1, h: cellH - 1, color: fill });
      if (showLabels) {
        const lum = fill[0] * 0.299 + fill[1] * 0.587 + fill[2] * 0.114;
        const text = formatTick(v, slice.format ?? block.valueAxis?.format);
        const tw = measure(text, labelStyle);
        pushText(commands, text, labelStyle, x + (cellW - 1 - tw) / 2, y + cellH / 2 + ascent * 0.35, lum < 0.5 ? [1, 1, 1] : TEXT_MUTED);
      }
    }
  }
  if (block.categoryLabels !== false) {
    const y = plotTop + gridH + LABEL_GAP + ascent;
    for (let c = 0; c < cols; c += 1) {
      const text = clipText(catNames[c] ?? String(c + 1), labelStyle, cellW - 2);
      const w = measure(text, labelStyle);
      pushText(commands, text, labelStyle, gx + c * cellW + (cellW - w) / 2, y, TEXT_MUTED);
    }
  }
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

// --- Gantt chart layout -------------------------------------------------------

function layoutGantt(
  block: ChartBlock,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
  style: ResolvedStyle,
  left: number,
  width: number,
  margin: EdgeInsets,
): Fragment[] {
  const tasks = block.ganttTasks ?? [];
  if (tasks.length === 0) {
    return [{ height: 0, before: margin.top, after: margin.bottom, commands: [], avoidSplit: true }];
  }

  const labelStyle = ctx.style({ fontSize: Math.max(5.5, style.fontSize - 2) }, style);
  const units = labelStyle.handle.unitsPerEm || 1000;
  const ascent = (labelStyle.handle.ascender / units) * labelStyle.fontSize;
  const descent = (Math.abs(labelStyle.handle.descender) / units) * labelStyle.fontSize;
  const rowH = Math.max(14, ascent + descent + 6);
  const nameW = Math.min(width * 0.25, 120); // left gutter for task names
  const plotLeft = left + nameW + 4;
  const plotW = Math.max(20, width - nameW - 8);

  // Determine time range.
  const start = typeof block.ganttStart === 'number' ? block.ganttStart : 0;
  let end = typeof block.ganttEnd === 'number' ? block.ganttEnd : UNBOUNDED;
  if (end === UNBOUNDED) {
    for (const t of tasks) {
      const s = typeof t.start === 'number' ? t.start : 0;
      const dur = typeof t.duration === 'number' ? t.duration : (typeof t.end === 'number' ? t.end - s : s);
      end = Math.max(end, s + dur);
    }
    if (end === start) end = start + 1;
  }
  const timeRange = end - start;

  // Determine unit and ticks.
  const ganttUnit = block.ganttUnit ?? 'week';
  const tickInterval = ganttUnit === 'day' ? 1 : ganttUnit === 'week' ? 7 : 30;
  const ticks: number[] = [];
  for (let t = start; t <= end; t += tickInterval) ticks.push(t);

  const commands: DrawCommand[] = [];
  const headerH = rowH; // time axis header row
  const totalH = headerH + tasks.length * rowH;

  // Title
  let titleH = 0;
  if (block.title !== undefined) {
    const titleStyle = ctx.style({ fontWeight: 700, fontSize: style.fontSize + 1 }, style);
    const titleResult = typeset(resolveContent(block.title, ctx, titleStyle, opts.scope), width);
    for (const line of titleResult.lines) {
      commands.push({ op: 'text', x: left, baselineY: titleH + line.ascent, runs: line.runs, gapWidth: 0, decorations: [] });
      titleH += line.height;
    }
    if (titleH > 0) titleH += LABEL_GAP;
  }

  const baseY = titleH;

  // Time axis ticks and grid lines.
  for (const tick of ticks) {
    const x = plotLeft + ((tick - start) / timeRange) * plotW;
    // Grid line
    commands.push({ op: 'line', x1: x, y1: baseY + headerH, x2: x, y2: baseY + totalH, color: GRID, lineWidth: 0.4 });
    // Tick label
    const lbl = formatGanttTick(tick, ganttUnit, start);
    const tw = measure(lbl, labelStyle);
    commands.push({ op: 'text', x: x - tw / 2, baselineY: baseY + headerH - 4, runs: [{ text: lbl, style: labelStyle, x: 0, width: tw }], gapWidth: 0, decorations: [] });
  }

  // Task rows.
  const defaultColors = block.colors ?? DEFAULT_PALETTE;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const rowY = baseY + headerH + i * rowH;
    const tStart = typeof task.start === 'number' ? task.start : 0;
    const tEnd = typeof task.end === 'number' ? task.end
      : typeof task.duration === 'number' ? tStart + task.duration
      : tStart;
    const barX = plotLeft + ((tStart - start) / timeRange) * plotW;
    const barW = Math.max(2, ((tEnd - tStart) / timeRange) * plotW);
    const barH = rowH - 6;
    const barY = rowY + 3;

    // Task name (right-aligned in gutter)
    const nameTxt = clipText(task.name, labelStyle, nameW);
    const nameWm = measure(nameTxt, labelStyle);
    commands.push({ op: 'text', x: left + nameW - nameWm, baselineY: rowY + rowH / 2 + ascent / 2 - 2, runs: [{ text: nameTxt, style: labelStyle, x: 0, width: nameWm }], gapWidth: 0, decorations: [] });

    // Bar background (row hover line)
    commands.push({ op: 'line', x1: plotLeft, y1: rowY + rowH, x2: plotLeft + plotW, y2: rowY + rowH, color: GRID, lineWidth: 0.3 });

    // Task bar
    const barColor = task.color ? toRGB(task.color) : palette(defaultColors, i);
    commands.push({ op: 'fillRect', x: barX, y: barY, w: barW, h: barH, color: barColor });

    // Progress fill (darker sub-bar)
    if (task.progress !== undefined && task.progress > 0) {
      const progW = barW * Math.min(1, task.progress);
      const darker: RGB = [barColor[0] * 0.6, barColor[1] * 0.6, barColor[2] * 0.6];
      commands.push({ op: 'fillRect', x: barX, y: barY, w: progW, h: barH, color: darker });
    }

    // Dependency arrows
    if (task.dependsOn) {
      for (const dep of task.dependsOn) {
        if (dep < 0 || dep >= tasks.length) continue;
        const depTask = tasks[dep];
        if (!depTask) continue;
        const depStart = typeof depTask.start === 'number' ? depTask.start : 0;
        const depEnd = typeof depTask.end === 'number' ? depTask.end
          : typeof depTask.duration === 'number' ? depStart + depTask.duration
          : depStart;
        const fromX = plotLeft + ((depEnd - start) / timeRange) * plotW;
        const fromY = baseY + headerH + dep * rowH + rowH / 2;
        const toX = barX;
        const toY = barY + barH / 2;
        // Simple L-shaped arrow: horizontal → vertical
        const midX = fromX + 4;
        commands.push({
          op: 'poly',
          points: [[fromX, fromY], [midX, fromY], [midX, toY], [toX, toY]] as PolyPoint[],
          stroke: { color: AXIS, lineWidth: 0.8 },
          close: false,
        });
      }
    }
  }

  const fragHeight = titleH + totalH;
  return [{ height: fragHeight, before: margin.top, after: margin.bottom, commands, avoidSplit: true }];
}

function formatGanttTick(value: number, unit: 'day' | 'week' | 'month', start: number): string {
  if (unit === 'day') return String(Math.round(value));
  if (unit === 'week') {
    const weeks = Math.round((value - start) / 7) + 1;
    return `W${weeks}`;
  }
  const months = Math.round((value - start) / 30) + 1;
  return `M${months}`;
}
