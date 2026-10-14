/**
 * Public surface of `pdf-report-engine`.
 *
 * The normal entry points are {@link createReport} / {@link renderToBuffer}:
 * feed them a {@link ReportDoc} (or something an adapter produced) and get real,
 * selectable-text, Jasper-style paginated PDF bytes back. Adapters (the HTML
 * subset) and lower-level pieces are exported so callers can build a pipeline by
 * hand or extend the IR.
 */
export { createReport, renderToBuffer, type RenderOptions, type RenderResult } from './render.js';

export { htmlToReportDoc, parseHtml, type HtmlOptions, type HElement, type HNode, type HText } from './adapter/html.js';

export { readFontFiles, FontRegistry, type FontSource, type FontFileEntry, type FontHandle } from './fonts/registry.js';

export type {
  ReportDoc,
  Block,
  ParagraphBlock,
  HeadingBlock,
  TableBlock,
  SpacerBlock,
  PageBreakBlock,
  BandContent,
  BandType,
  StyleProps,
  BoxProps,
  Content,
  ContentSpan,
  ColumnNode,
  RowNode,
  CellNode,
  GroupNode,
  DataSource,
  Expr,
} from './ir/schema.js';

export { resolvePage, type ResolvedPage, type PageSpec } from './core/page.js';
export { toPt, expandBox, MM_TO_PT, CM_TO_PT, IN_TO_PT, PX_TO_PT, type Length } from './core/units.js';

export { paginate, type Page, type PlacedFragment, type PaginateInput } from './pagination/engine.js';
export type { Fragment, DrawCommand } from './layout/flow.js';
