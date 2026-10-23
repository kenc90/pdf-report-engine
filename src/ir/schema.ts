/**
 * The report IR (`ReportDoc`). This is the *only* thing the layout engine sees:
 * every authoring format (JS objects, constrained HTML, later JRXML/XSL-FO) is an
 * adapter that produces this structure. Keeping it a plain data object means it is
 * serialisable, diffable and validatable without pulling in a parser.
 *
 * Geometry: all lengths are `Length` (number = pt, or a string with unit).
 */
import type { PageSpec } from '../core/page.js';
import type { ColorInput } from '../core/color.js';

/** Expression language marker. See `expr/eval.ts` for the supported grammar. */
export interface Expr<T = unknown> {
  /** e.g. `"sum($row.amount)"`, `"$group.region"`, `"format($row.total, '#,##0.00')"` */
  expr: string;
  scope?: 'row' | 'group' | 'report' | 'page';
  type?: T;
}

export type Content = string | number | ContentSpan | Array<string | number | ContentSpan>;

export interface ContentSpan {
  text?: Content;
  /** Bind to a data field instead of a literal. */
  bind?: string | Expr;
  format?: string;
  style?: Partial<StyleProps>;
  children?: Content;
  /**
   * Hyperlink target: an absolute URL (`https:`, `mailto:`, `tel:`) or an
   * internal destination written as `#anchor`. Internal anchors resolve against
   * any block/heading whose `id` (or HTML `id`) matches.
   */
  link?: string;
}

/** Properties that inherit down the node tree. */
export interface StyleProps {
  fontFamily?: string | string[];
  fontSize?: number;
  fontWeight?: number | 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic' | 'oblique';
  color?: ColorInput;
  backgroundColor?: ColorInput;
  /** 0..1 paint opacity for text/fills (watermarks, tinted chart areas). */
  opacity?: number;
  lineHeight?: number | 'normal';
  letterSpacing?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  textDecoration?: Array<'underline' | 'line-through'>;
  /** OpenType feature tags, e.g. `['tnum']` for tabular figures in numeric columns. */
  features?: Record<string, boolean>;
  fontVariant?: 'normal' | 'small-caps' | 'tabular-nums';
  whiteSpace?: 'normal' | 'nowrap' | 'pre-wrap';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
}

/** Properties that affect the box but do not inherit. */
export interface BoxProps extends StyleProps {
  width?: number | string;
  height?: number | string;
  minHeight?: number | string;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** CSS-like `[width, style, color]`, or just a colour for a solid hairline-equivalent. */
  border?: BorderShorthand;
  borderTop?: BorderShorthand;
  borderRight?: BorderShorthand;
  borderBottom?: BorderShorthand;
  borderLeft?: BorderShorthand;
  /** Pagination behaviour. Only `'page'` (break before/after) and `'avoid'`
   * (`breakInside`) are implemented; `'avoid'` on `breakBefore`/`breakAfter` is ignored. */
  breakBefore?: 'auto' | 'page' | 'avoid';
  breakAfter?: 'auto' | 'page' | 'avoid';
  breakInside?: 'auto' | 'avoid';
  /** Glue this block to the next one, so a heading never ends a page alone. */
  keepWithNext?: boolean;
}

export type BorderStyle = 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
export type BorderShorthand =
  | ColorInput
  | [number, ColorInput]
  | [number, BorderStyle, ColorInput];

export interface ResolvedBorder {
  width: number;
  style: BorderStyle;
  color: ColorInput;
}

/**
 * Declarative conditional formatting: when `when` evaluates truthy in the
 * current scope (`$row`, `$group`, `$index`, `$page`, …), `style` is merged on
 * top of the node's own props. Rules apply in array order, so the last match
 * wins. Works on blocks, table rows and table cells.
 */
export interface StyleCondition {
  when: string | Expr;
  /** Box/style overrides applied while the condition holds. */
  style?: Partial<BoxProps>;
}

/**
 * Numeric heatmap: interpolate a cell's number between `from` and `to`.
 * When `min`/`max` are omitted the range is computed from the table's data
 * rows for the column the cell belongs to, so one declaration shades a whole
 * column.
 */
export interface ColorScale {
  min?: number;
  max?: number;
  /** Fill at the low end (default `#eef4ff`). */
  from?: ColorInput;
  /** Fill at the high end (default `#1e3a8a`). */
  to?: ColorInput;
  /**
   * Switch the text to white on dark fills (default true). Set `false` to keep
   * the cell's own text colour.
   */
  text?: boolean;
}

export interface BlockBase extends BoxProps {
  id?: string;
  /** Conditional visibility. An `Expr` is evaluated against the current scope. */
  visible?: boolean | Expr;
  /** Conditional formatting applied before the block is laid out. */
  styleWhen?: StyleCondition[];
}

export interface ParagraphBlock extends BlockBase {
  type: 'paragraph';
  content: Content;
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  content: Content;
  level?: number;
  /** Adds a PDF outline entry. `numbering: 'append'` mirrors Jasper's section numbering. */
  outline?: { level?: number; numbering?: 'append' | 'none' } | false;
}

export interface SpacerBlock extends BlockBase {
  type: 'spacer';
  size?: number;
}

export interface PageBreakBlock extends BlockBase {
  type: 'pageBreak';
  /**
   * @deprecated Accepted and ignored. A break is never taken at the top of a page, so
   * consecutive `pageBreak` blocks cannot leave a blank page.
   */
  always?: boolean;
}

/**
 * A raster image block (PNG / JPEG / GIF / BMP). `src` is a filesystem path, a
 * `data:` URI, or raw bytes; the writer hands it to pdfkit unchanged.
 *
 * Sizing rules resolved at layout time (see `core/image.ts`):
 *  - `width`/`height` (any `Length`, default unit pt) are honoured exactly;
 *  - when only one is given, the other follows the image's intrinsic aspect
 *    ratio (read from the file header — no pdfkit in the layout pass);
 *  - with neither given, the intrinsic size (px → pt at 96 dpi) is used, capped
 *    to the content width.
 */
export interface ImageBlock extends BlockBase {
  type: 'image';
  src: string | Uint8Array;
  /** Explicit intrinsic size (px); probed from `src` when omitted. */
  intrinsic?: { width: number; height: number };
  alt?: string;
}

/**
 * A vector SVG image, drawn as real PDF paths (crisp at any zoom, selectable as
 * geometry rather than pixels). `src` is inline `<svg>` markup, a
 * `data:image/svg+xml` URI, a filesystem path, or raw bytes; `http(s)` URLs are
 * fetched to bytes by the remote-image pre-pass before layout.
 *
 * Sizing mirrors {@link ImageBlock}: explicit `width`/`height` win, otherwise the
 * viewBox (or `width`/`height` attributes) give the intrinsic aspect ratio and a
 * 96-dpi default size, capped to the content width.
 *
 * Supported SVG subset: `path`/`rect`/`circle`/`ellipse`/`line`/`polyline`/
 * `polygon`, nested `g` groups with `transform`, and fill/stroke paint including
 * `fill-rule`, `-opacity`, `stroke-width` and `stroke-dasharray`. Text, gradients,
 * filters and clip/mask are not modelled (a gradient fill falls back to solid).
 */
export interface SvgBlock extends BlockBase {
  type: 'svg';
  src: string | Uint8Array;
  /** Explicit intrinsic size (px); derived from the viewBox when omitted. */
  intrinsic?: { width: number; height: number };
  alt?: string;
}

// --- charts ---------------------------------------------------------------

export type ChartKind =
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'combo'
  | 'waterfall'
  | 'scatter'
  | 'bubble'
  | 'radar'
  | 'gauge'
  | 'heatmap'
  | 'gantt';

export interface ChartSeries {
  /** Legend label. */
  name?: string;
  /**
   * Series values. Either a literal array, a comma-separated string
   * (`'12,18,9'`), a binding expression string (`'$data.revenue'`), or an
   * explicit `Expr`. Bindings must resolve to an array of numbers.
   */
  values: number[] | string | Expr;
  /**
   * Scatter / bubble charts: the x-coordinate of each point. Defaults to the
   * category index (0, 1, 2, …) when omitted, so a single `values` array still
   * plots as an evenly spaced cloud. Same three shapes `values` accepts.
   */
  xValues?: number[] | string | Expr;
  /**
   * Bubble charts only: the marker radius for each point (same shapes as
   * `values`). Radii are normalised to a sensible on-plot pixel range.
   */
  rValues?: number[] | string | Expr;
  /**
   * Range bar charts only (`block.range === true`): the lower end of each bar.
   * Paired with `high`; when only one of them is given, `values` supplies the
   * other end.
   */
  low?: number[] | string | Expr;
  /** Range bar charts only: the upper end of each bar. */
  high?: number[] | string | Expr;
  color?: ColorInput;
  /** Number pattern for value labels on this series. */
  format?: string;
  /**
   * Combo charts only: how this series is drawn. Defaults to `'bar'`.
   * Ignored by the single-kind charts.
   */
  type?: 'bar' | 'line' | 'area';
  /**
   * Combo charts only: which value axis this series reads. Defaults to
   * `'left'`; right-axis series scale against `rightAxis` and are labelled on
   * the right edge of the plot.
   */
  axis?: 'left' | 'right';
}

export interface ValueAxisOptions {
  min?: number;
  max?: number;
  /** Preferred tick count (default 5). */
  ticks?: number;
  /** Number pattern for tick labels (e.g. `'#,##0'`). */
  format?: string;
  /** Scatter / bubble: number pattern for the numeric x-axis tick labels. */
  xFormat?: string;
  /** Draw the value-axis labels (default true). */
  labels?: boolean;
  /** Draw horizontal grid lines (default true). */
  gridLines?: boolean;
}

/**
 * A data-bound vector chart. Everything is drawn with the same primitives as
 * the rest of the engine, so charts stay crisp at any zoom and never depend on
 * a canvas or an external charting library.
 *
 * Pie/donut charts read their slices from `series[0].values` and label them
 * with `categories`; every other kind maps one value per category per series.
 */
export interface ChartBlock extends BlockBase {
  type: 'chart';
  kind: ChartKind;
  /** Heading rendered above the plot, in the inherited style but bold. */
  title?: Content;
  /** Category labels: literal array, CSV string, binding expression, or `Expr`. */
  categories?: string[] | string | Expr;
  series: ChartSeries[];
  /**
   * Stack bars / areas instead of grouping them side by side. `'100%'`
   * normalises every category to a percentage of its own total (the value
   * axis then reads 0–100%).
   */
  stacked?: boolean | '100%';
  legend?: 'none' | 'top' | 'bottom' | 'right';
  /** Palette used when a series has no explicit `color`. */
  colors?: ColorInput[];
  /** Write each value above its bar / point (default false). */
  showValues?: boolean;
  valueAxis?: ValueAxisOptions;
  /** Combo charts: the right-hand axis used by `series[].axis === 'right'`. */
  rightAxis?: ValueAxisOptions;
  /**
   * Waterfall charts: category indices drawn as a running-total bar instead
   * of a delta. The bar spans 0 → running; at index 0 the value seeds the
   * running total (a starting balance), elsewhere the value is ignored.
   */
  totals?: number[];
  /** Waterfall colours (defaults: green increase, red decrease, navy total). */
  waterfallColors?: { increase?: ColorInput; decrease?: ColorInput; total?: ColorInput };
  /** Draw category labels under the plot (default true). */
  categoryLabels?: boolean;
  /** Inner radius of a donut as a fraction of the outer radius (default 0.55). */
  innerRadius?: number;
  /** Plot height; defaults to `height`, or 160pt. */
  plotHeight?: number;
  /**
   * Horizontal reference / threshold lines drawn across the value axis (cartesian
   * charts: bar/line/area/combo/scatter/range). Each is placed at `value`, labelled
   * at its right end, and can read the right axis in a combo chart.
   */
  referenceLines?: ReferenceLine[];
  /**
   * Bar charts: draw each bar as a high–low range instead of a zero-based value.
   * The bar spans `series[].low` → `series[].high` (either may be a binding).
   */
  range?: boolean;
  /** Gauge charts only: the needle value. Defaults to `series[0].values[0]`. */
  gaugeValue?: number | string | Expr;
  /** Gauge charts only: the full-scale maximum (default 100). */
  gaugeMax?: number;
  /** Heatmap charts only: print each cell's value inside it (default true). */
  heatmapLabels?: boolean;
  /** Heatmap colour ramp (default `#eef4ff` → `#1e3a8a`). */
  heatmapColors?: { from?: ColorInput; to?: ColorInput };
  /** Gantt charts: task definitions (alternative to `series`). */
  ganttTasks?: GanttTask[];
  /** Gantt charts: time-axis minimum (day offset or ISO date). */
  ganttStart?: number | string;
  /** Gantt charts: time-axis maximum. */
  ganttEnd?: number | string;
  /** Gantt charts: tick interval (default `'week'`). */
  ganttUnit?: 'day' | 'week' | 'month';
}

/** A single Gantt task bar. */
export interface GanttTask {
  name: string;
  /** Start offset from `ganttStart` (in `ganttUnit` increments, or ISO date string). */
  start: number | string;
  /** Duration in `ganttUnit` increments (or ISO end-date string via `end`). */
  duration?: number | string;
  /** Alternative to `duration`: explicit end offset/date. */
  end?: number | string;
  color?: ColorInput;
  /** Indices of tasks this depends on (draws dependency arrows). */
  dependsOn?: number[];
  /** Progress 0–1 (fills a darker portion within the task bar). */
  progress?: number;
}

/** A horizontal reference / threshold line on a value axis. */
export interface ReferenceLine {
  /** Axis value the line sits at. */
  value: number;
  /** Which value axis to read (combo charts). Default `'left'`. */
  axis?: 'left' | 'right';
  color?: ColorInput;
  /** Label drawn at the right end of the line. */
  label?: string;
  /** Dash pattern (default a solid hairline). */
  dash?: number[];
}

// --- table of contents ----------------------------------------------------

/**
 * A table of contents generated from heading blocks. Page numbers require the
 * document to be paginated first, so the renderer runs a small fixed-point loop:
 * lay out → paginate → rebuild the TOC with real page numbers → repeat until
 * the TOC height is stable (at most four iterations).
 */
export interface TocBlock extends BlockBase {
  type: 'toc';
  /** Heading rendered above the entries (omit for none). */
  title?: Content;
  /** Include headings up to this level (default 3). */
  maxLevel?: number;
  /** Draw dot leaders between the title and the page number (default true). */
  leaders?: boolean;
  /** Left indent per nesting level in points (default 12). */
  indent?: number;
  /** Show page numbers (default true). */
  pageNumbers?: boolean;
  /** Space between the heading text and the leaders in points (default 4). */
  gap?: number;
}

// --- barcodes -------------------------------------------------------------

export type BarcodeSymbology = 'qr' | 'code128' | 'ean13';

/**
 * A machine-readable code block. `qr` and `code128` accept arbitrary text;
 * `ean13` accepts 12 digits (the checksum is appended) or 13 digits
 * (the checksum is validated).
 */
export interface BarcodeBlock extends BlockBase {
  type: 'barcode';
  symbology: BarcodeSymbology;
  /** The encoded value: a literal, or a `ContentSpan`/`Expr` to bind. */
  value: Content;
  /** Module width in points. When omitted, a sensible size is chosen. */
  moduleSize?: number;
  /** QR only: error-correction level (default `'M'`). */
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  /** QR only: quiet zone in modules (default 4). */
  quietZone?: number;
  /** Print the human-readable value below a 1D code (default true). */
  showText?: boolean;
  /** Bar/module colour (default black). */
  color?: ColorInput;
}

/** A single row of a `table`, produced by expanding a `dataSource`. */
export interface RowNode {
  cells: CellNode[];
  kind?: 'header' | 'detail' | 'groupHeader' | 'groupFooter' | 'subtotal' | 'grandTotal';
  /**
   * Conditional row filtering. For a data-driven detail row the expression is
   * evaluated per row and a falsy result drops that row entirely.
   */
  visible?: boolean | Expr;
  /** Conditional styling applied to every cell in the row. */
  styleWhen?: StyleCondition[];
  /** Row level pagination hints. A row is already one atomic fragment, so
   * `breakInside` changes nothing; `keepWithNext` glues it to the following row. */
  breakInside?: 'auto' | 'avoid';
  keepWithNext?: boolean;
  minHeight?: number;
}

export interface ColumnNode {
  /**
   * Fixed length in points (a `Length`; a percentage is *not* resolved against the
   * table). Leave it unset and give the column a `grow` weight to share whatever
   * the pinned columns did not take.
   */
  width?: number | string;
  /** Weight used when the table must stretch to the available width. */
  grow?: number;
  /** Minimum width honoured during shrink, default: widest unbreakable word. */
  minWidth?: number;
  align?: 'left' | 'center' | 'right';
  /** Default style for body cells in this column. */
  style?: Partial<StyleProps>;
  /** Heatmap default for every numeric cell in this column. */
  colorScale?: ColorScale;
  key?: string;
}

/** Cell content: inline `Content`, or a stack of blocks (images, codes, charts…). */
export type CellContent = Content | CellNode;

/**
 * A corner ("bivariate") header cell split by a diagonal line, as used in a
 * two-way / cross-tabulation table: one label names the column axis, the other
 * the row axis. The slash runs corner-to-corner and the two labels sit in the
 * opposite triangles.
 */
export interface DiagonalHeader {
  /** Label in the upper triangle (typically the column-axis name). */
  top?: Content;
  /** Label in the lower triangle (typically the row-axis name). */
  bottom?: Content;
  /**
   * Which diagonal is drawn. `'tl'` (default) runs top-left → bottom-right, so
   * `top` sits upper-right and `bottom` lower-left; `'tr'` runs top-right →
   * bottom-left, mirroring the placement.
   */
  dir?: 'tl' | 'tr';
  /** Draw the corner-to-corner slash (default true). Set false for labels only. */
  line?: boolean;
}

export interface CellNode {
  content?: CellContent;
  /**
   * Rich cell content: any flow block — `image`, `barcode`, `chart`, a nested
   * `table`, paragraphs — laid out inside the cell's padded box. Mutually
   * exclusive with `content`; `content` wins when both are present.
   */
  blocks?: Block[];
  colSpan?: number;
  rowSpan?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  style?: Partial<StyleProps>;
  /** Cell-level box overrides (a group footer usually spans and shades). */
  border?: BorderShorthand;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  backgroundColor?: ColorInput;
  /** Conditional cell visibility; a hidden cell keeps its grid slot and fill. */
  visible?: boolean | Expr;
  /** Conditional styling for this cell, merged after the column/row styles. */
  styleWhen?: StyleCondition[];
  /** Numeric heatmap fill derived from the cell's value. */
  colorScale?: ColorScale;
  /**
   * Turn this cell into a diagonal split header: a corner-to-corner slash with a
   * label in each triangle (see `DiagonalHeader`). Takes over the cell's paint,
   * so its inline `content`/`blocks` are ignored when present.
   */
  diagonal?: DiagonalHeader;
  /**
   * @deprecated Accepted and ignored. Group totals are pre-computed for the whole group;
   * read them in a footer with `$group.<key>_sum` (or `$group.rowCount`).
   */
  subtotal?: 'sum' | 'count' | 'min' | 'max' | 'avg' | 'none';
  format?: string;
}

export type DataSource =
  | Array<Record<string, unknown>>
  | { bind: string | Expr }
  | { each: string; of: string | Expr };

export interface GroupNode {
  /** Expression evaluated per row; rows where it changes start a new group. */
  by: string | Expr;
  /** @deprecated Accepted and ignored (it is only collected for font subsetting). Put the text in `header`. */
  label?: string | Expr;
  header?: Content;
  footer?: Content;
  headerStyle?: Partial<StyleProps>;
  footerStyle?: Partial<StyleProps>;
  /** Force a page break whenever a new group begins. */
  pageBreak?: boolean;
  /** Reset `{PAGE}` numbering at the group boundary (Jasper's "reset page number"). */
  resetPageNumber?: boolean;
  /**
   * @deprecated Accepted and ignored. A group header is printed once, where its group
   * starts; the table's own `headerRows` are what repeat on every page.
   */
  headerRepeat?: 'once' | 'everyPage';
}

export interface TableBlock extends BlockBase {
  type: 'table';
  columns?: ColumnNode[];
  headerRows?: RowNode[];
  footerRows?: RowNode[];
  /**
   * Explicitly authored body rows, rendered (in order) between the header and the
   * data-driven detail. Unlike `detail` (one shared template applied per data row),
   * each static row keeps its own cell styling — backgrounds, borders, padding.
   */
  staticRows?: RowNode[];
  dataSource?: DataSource;
  detail?: RowNode | { cells: CellContent[]; style?: Partial<StyleProps> };
  groups?: GroupNode[];
  /**
   * `headerRows` repeat at the top of every page the table spans automatically; this
   * knob only has one meaningful value — `false` opts the repetition out.
   */
  repeatHeader?: boolean;
  /** Draw alternating row shading (default fill `#f2f2f2`, or pass `{ color }`). */
  striped?: boolean | { color: ColorInput };
  showGrid?: boolean | BorderShorthand;
  /** @deprecated Accepted and ignored: the paginator draws no row-only separators yet. Use `showGrid`. */
  showRowSeparators?: boolean | BorderShorthand;
  rowStyle?: Partial<StyleProps> | ((row: Record<string, unknown>, index: number) => Partial<StyleProps>);
  /** @deprecated Accepted and ignored. Style group bands through `groups[].headerStyle` / `footerStyle`. */
  groupStyle?: Partial<StyleProps>;
  /** @deprecated Accepted and ignored: there is no widow/orphan control yet. */
  widows?: number;
  /** @deprecated Accepted and ignored: there is no widow/orphan control yet. */
  orphans?: number;
  /** @deprecated Accepted and ignored; `{TOP}` / `$page.top` is never populated. */
  subtotalToken?: string;
}

/**
 * A CSS-flexbox container laid out as a single atomic fragment (it never splits
 * across pages). Children are any flow block plus the flex item props below.
 * A pragmatic subset is modelled: row/column main axis, optional wrap, the
 * `justify-content` / `align-items` distributions, `gap`, and `flex-grow` /
 * `flex-shrink` / `flex-basis` sizing.
 */
export interface FlexBlock extends BlockBase {
  type: 'flex';
  /** Main axis. Default `'row'`; `'column'` stacks vertically. */
  direction?: 'row' | 'column';
  /** Allow items to wrap onto new lines (default false). Row axis only. */
  wrap?: boolean;
  /** Main-axis distribution. Default `'flex-start'`. */
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  /** Cross-axis alignment of items within a line. Default `'stretch'`. */
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch';
  /** Spacing between items and between wrapped lines (Length, default 0). */
  gap?: number | string;
  /** Row-gap override (falls back to `gap`). */
  rowGap?: number | string;
  /** Column-gap override (falls back to `gap`). */
  columnGap?: number | string;
  children: FlexItem[];
}

/**
 * One child of a {@link FlexBlock}. `grow`/`shrink`/`basis` drive main-axis
 * sizing; the rest are ordinary block props (width/height/margins/box …).
 */
export interface FlexItem extends BlockBase {
  /** The wrapped content: any flow block, or a nested flex container. */
  block: Block;
  grow?: number;
  shrink?: number;
  /** Main-axis base size (Length); defaults to the block's own width/height. */
  basis?: number | string;
  /** Per-item cross-axis override of the container's `alignItems`. */
  alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch';
}

/** A multi-column layout block: children flow into N equal-width columns. */
export interface ColumnBlock extends BlockBase {
  type: 'columns';
  /** Number of columns (default 2). */
  count?: number;
  /** Gap between columns in pt or Length string (default 12). */
  gap?: number | string;
  /** Vertical rule between columns (default false). */
  rule?: boolean | { color?: ColorInput; width?: number };
  /** Child blocks distributed across columns. */
  children: Block[];
}

export type Block = ParagraphBlock | HeadingBlock | TableBlock | SpacerBlock | PageBreakBlock | ImageBlock | SvgBlock | ChartBlock | TocBlock | BarcodeBlock | FlexBlock | ColumnBlock;

export type BandType = 'pageHeader' | 'pageFooter' | 'title' | 'summary' | 'background';

export interface BandContent {
  blocks?: Block[];
  /** Convenience: a single paragraph/string in the band. */
  text?: Content;
  style?: Partial<StyleProps>;
  /** Fixed band height; when omitted the band is measured. */
  height?: number;
}

/** Declarative remote-font references collected from HTML. Resolved to embedded
 *  faces by `resolveRemoteFonts()` before rendering. */
export type FontReference =
  /** A Google Fonts stylesheet URL (`fonts.googleapis.com/...css...`). */
  | { type: 'google'; url: string }
  /** Raw CSS text containing one or more `@font-face { src: url(...) }` rules. */
  | { type: 'font-face'; css: string }
  /** A direct font file URL (TTF/OTF/TTC/WOFF2), labelled with its family. */
  | { type: 'url'; url: string; family: string; weight?: number; style?: 'normal' | 'italic'; postscriptName?: string };

/** Declarative watermark specification for every page. */
export interface WatermarkSpec {
  /** The watermark text to render. */
  text: string;
  /** Rotation in degrees counter-clockwise (default -35, i.e. diagonal). */
  rotate?: number;
  /** Font size in pt (default 72). */
  fontSize?: number;
  /** Text colour (default `'#c0c0c0'`). */
  color?: ColorInput;
  /** Opacity 0–1 (default 0.18). */
  opacity?: number;
  /** Font family override. */
  fontFamily?: string;
}

export interface ReportDoc {
  /** Optional free-form metadata; `title`/`author`/`subject`/`keywords` become PDF info. */
  info?: {
    title?: string | Expr;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
  };
  page?: PageSpec;
  /** Applied to every node unless overridden (the report's "base style"). */
  style?: Partial<StyleProps>;
  data?: Record<string, unknown>;
  /** Extra symbols available to expressions (`$now`, custom formatters). */
  variables?: Record<string, unknown>;
  bands?: Partial<Record<BandType, BandContent>>;
  body?: Block[];
  /** Remote font references (Google Fonts links, `@font-face`, font URLs). */
  fonts?: FontReference[];
  /**
   * Emit a PDF outline (bookmark pane) from heading blocks. Defaults to `true`
   * when the body contains headings; set `false` to suppress it.
   */
  outline?: boolean;
  /** Page watermark drawn as a rotated, semi-transparent text behind content. */
  watermark?: WatermarkSpec;
}

/** Row descriptor after data expansion: either a concrete row or a band marker. */
export type RowOrMarker =
  | { kind: 'row'; row: ResolvedRowInput }
  | { kind: 'groupStart'; group: GroupNode; value: unknown; index: number }
  | { kind: 'groupEnd'; group: GroupNode; value: unknown; index: number };

export interface ResolvedRowInput {
  data: Record<string, unknown>;
  index: number;
  cells?: CellContent[];
}
