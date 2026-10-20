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
  /** Pagination behaviour. */
  breakBefore?: 'auto' | 'page' | 'avoid';
  breakAfter?: 'auto' | 'page' | 'avoid';
  breakInside?: 'auto' | 'avoid';
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

export interface BlockBase extends BoxProps {
  id?: string;
  /** Conditional visibility. */
  visible?: boolean | Expr;
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
  /** Only force a break if we are not already at the top of a page. */
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

// --- charts ---------------------------------------------------------------

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'donut';

export interface ChartSeries {
  /** Legend label. */
  name?: string;
  /**
   * Series values. Either a literal array, a comma-separated string
   * (`'12,18,9'`), a binding expression string (`'$data.revenue'`), or an
   * explicit `Expr`. Bindings must resolve to an array of numbers.
   */
  values: number[] | string | Expr;
  color?: ColorInput;
  /** Number pattern for value labels on this series. */
  format?: string;
}

export interface ValueAxisOptions {
  min?: number;
  max?: number;
  /** Preferred tick count (default 5). */
  ticks?: number;
  /** Number pattern for tick labels (e.g. `'#,##0'`). */
  format?: string;
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
  /** Stack bars / areas instead of grouping them side by side. */
  stacked?: boolean;
  legend?: 'none' | 'top' | 'bottom' | 'right';
  /** Palette used when a series has no explicit `color`. */
  colors?: ColorInput[];
  /** Write each value above its bar / point (default false). */
  showValues?: boolean;
  valueAxis?: ValueAxisOptions;
  /** Draw category labels under the plot (default true). */
  categoryLabels?: boolean;
  /** Inner radius of a donut as a fraction of the outer radius (default 0.55). */
  innerRadius?: number;
  /** Plot height; defaults to `height`, or 160pt. */
  plotHeight?: number;
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
  /** Row level pagination hints. */
  breakInside?: 'auto' | 'avoid';
  keepWithNext?: boolean;
  minHeight?: number;
}

export interface ColumnNode {
  /** Fixed length, or a fraction of the available content width (0..1). */
  width?: number | string;
  /** Weight used when the table must stretch to the available width. */
  grow?: number;
  /** Minimum width honoured during shrink, default: widest unbreakable word. */
  minWidth?: number;
  align?: 'left' | 'center' | 'right';
  /** Default style for body cells in this column. */
  style?: Partial<StyleProps>;
  key?: string;
}

export type CellContent = Content | CellNode;

export interface CellNode {
  content?: CellContent;
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
  /** Aggregate to compute for the enclosing group, written back into `{TOP}` style tokens. */
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
  label?: string | Expr;
  header?: Content;
  footer?: Content;
  headerStyle?: Partial<StyleProps>;
  footerStyle?: Partial<StyleProps>;
  /** Force a page break whenever a new group begins. */
  pageBreak?: boolean;
  /** Reset `{PAGE}` numbering at the group boundary (Jasper's "reset page number"). */
  resetPageNumber?: boolean;
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
  /** Repeat `headerRows` at the top of every page the table spans. */
  repeatHeader?: boolean;
  /** Draw alternating row shading. */
  striped?: boolean | { color: ColorInput };
  showGrid?: boolean | BorderShorthand;
  showRowSeparators?: boolean | BorderShorthand;
  rowStyle?: Partial<StyleProps> | ((row: Record<string, unknown>, index: number) => Partial<StyleProps>);
  groupStyle?: Partial<StyleProps>;
  /** Minimum rows kept together at the bottom/top of a page. */
  widows?: number;
  orphans?: number;
  /** Column name used for a `{TOP}`-style running subtotal token, if any. */
  subtotalToken?: string;
}

export type Block = ParagraphBlock | HeadingBlock | TableBlock | SpacerBlock | PageBreakBlock | ImageBlock | ChartBlock | TocBlock | BarcodeBlock;

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
