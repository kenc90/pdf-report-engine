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
}

/** Properties that inherit down the node tree. */
export interface StyleProps {
  fontFamily?: string | string[];
  fontSize?: number;
  fontWeight?: number | 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic' | 'oblique';
  color?: ColorInput;
  backgroundColor?: ColorInput;
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
  outline?: { level?: number; numbering?: 'append' | 'none' };
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

export type Block = ParagraphBlock | HeadingBlock | TableBlock | SpacerBlock | PageBreakBlock;

export type BandType = 'pageHeader' | 'pageFooter' | 'title' | 'summary' | 'background';

export interface BandContent {
  blocks?: Block[];
  /** Convenience: a single paragraph/string in the band. */
  text?: Content;
  style?: Partial<StyleProps>;
  /** Fixed band height; when omitted the band is measured. */
  height?: number;
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
