/**
 * HTML-subset adapter: constrained authoring HTML -> `ReportDoc` IR.
 *
 * This is deliberately NOT a general HTML engine. It understands the small slice
 * of markup that maps cleanly onto a paginated report and nothing else, so there
 * is no DOM library to install and no CSS cascade to model:
 *
 *   Blocks   h1..h6, p, div/section/article/header/footer/main, table, hr.
 *   Inline   b/strong, i/em, u, span, font, a — plus `{PAGE}` / `{TOTAL}` tokens.
 *   Style    a flat subset of inline `style` (see `cssToIr`); optional class map.
 *   Data     `data-bind`, `data-each`, `data-format` on a table turn it into a
 *            bound data region; on any leaf it binds that node's text to an
 *            expression instead of its literal content.
 *
 * Geometry (margins/padding/widths/font-size) is converted to points via
 * `toPt`, matching the rest of the engine.
 */
import { toPt } from '../core/units.js';
import { exprSource } from '../expr/eval.js';
import type {
  ReportDoc,
  Block,
  Content,
  ContentSpan,
  StyleProps,
  BoxProps,
  BorderShorthand,
  ColumnNode,
  RowNode,
  CellNode,
  DataSource,
  BandContent,
  BandType,
} from '../ir/schema.js';

// --- tiny, forgiving HTML tokenizer/parser ---------------------------------

export interface HText {
  type: 'text';
  text: string;
}
export interface HElement {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HNode[];
}
export type HNode = HText | HElement;

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'source']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  middot: '\u00b7',
  bull: '\u2022',
  times: '\u00d7',
  deg: '\u00b0',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    const key = body.toLowerCase();
    return ENTITIES[key] ?? whole;
  });
}

function lowerAttr(name: string): string {
  return name.toLowerCase();
}

/**
 * Parse a forgiving subset of HTML. Handles attributes (single/double/unquoted),
 * comments, doctype, void elements and nesting; ignores everything exotic. Throws
 * only on genuinely unbalanced tags, which a report author should see.
 */
export function parseHtml(html: string): HElement {
  const root: HElement = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: HElement[] = [root];
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!\w[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  const attrRe = /([a-zA-Z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  const top = (): HElement => stack[stack.length - 1]!;
  const pushText = (raw: string): void => {
    if (raw.length === 0) return;
    top().children.push({ type: 'text', text: decodeEntities(raw) });
  };

  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    pushText(html.slice(cursor, m.index));
    cursor = tagRe.lastIndex;
    const token = m[0];
    if (token.startsWith('<!')) continue; // comment / doctype / cdata

    if (m[1] !== undefined) {
      // Closing tag: unwind to the matching open element.
      const name = m[1].toLowerCase();
      if (VOID_TAGS.has(name)) continue;
      const idx = findLast(stack, (el) => el.tag === name);
      if (idx > 0) stack.length = idx;
      else throw new Error(`Unexpected closing tag </${name}>`);
      continue;
    }

    const name = m[2]!.toLowerCase();
    const attrs = parseAttrs(m[3] ?? '', attrRe);
    const selfClosed = m[4] === '/';
    const el: HElement = { type: 'element', tag: name, attrs, children: [] };
    top().children.push(el);
    if (!VOID_TAGS.has(name) && !selfClosed) stack.push(el);
  }
  pushText(html.slice(cursor));

  if (stack.length !== 1) {
    const unclosed = stack.slice(1).map((e) => e.tag);
    throw new Error(`Unclosed tags: ${unclosed.join(', ')}`);
  }
  return root;
}

function parseAttrs(src: string, re: RegExp): Record<string, string> {
  const attrs: Record<string, string> = {};
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[lowerAttr(m[1]!)] = decodeEntities(value);
  }
  return attrs;
}

function findLast<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (pred(arr[i]!)) return i;
  return -1;
}

// --- CSS subset -> IR style props ------------------------------------------

type IrBox = Partial<BoxProps>;

function cssToIr(style: string, classStyles: IrBox[]): IrBox {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown): void => {
    out[k] = v;
  };
  const decls = style.split(';').map((d) => d.trim()).filter(Boolean);
  for (const decl of decls) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    applyDecl(prop, value, set);
  }
  // Class styles are overridden by inline `style` (applied last).
  const merged: IrBox = {};
  for (const c of classStyles) Object.assign(merged, c);
  Object.assign(merged, out);
  return merged;
}

const ALIGN: Record<string, StyleProps['align']> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
};

function applyDecl(prop: string, value: string, set: (k: string, v: unknown) => void): void {
  switch (prop) {
    case 'font-size':
      set('fontSize', toPt(value));
      return;
    case 'font-family':
      set('fontFamily', value.split(',').map((f) => f.trim()));
      return;
    case 'font-weight':
      set('fontWeight', value === 'bold' ? 700 : value === 'normal' ? 400 : Number(value) || undefined);
      return;
    case 'font-style':
      if (value === 'italic' || value === 'oblique') set('fontStyle', 'italic');
      return;
    case 'color':
      set('color', value);
      return;
    case 'background-color':
    case 'background':
      set('backgroundColor', value.split(/\s+/)[0]);
      return;
    case 'text-align':
      if (ALIGN[value]) set('align', ALIGN[value]);
      return;
    case 'text-decoration':
      if (value.includes('underline')) set('textDecoration', ['underline']);
      else if (value.includes('line-through')) set('textDecoration', ['line-through']);
      return;
    case 'line-height':
      // Only a unitless ratio or `normal` is meaningful to the IR resolver; a
      // fixed `px` line-height without a known font size cannot be scaled, so it
      // is ignored rather than silently mis-multiplied.
      if (/^\d*\.?\d+$/.test(value)) set('lineHeight', Number(value));
      else if (value === 'normal') set('lineHeight', 'normal');
      return;
    case 'letter-spacing':
      set('letterSpacing', toPt(value));
      return;
    case 'white-space':
      if (value === 'nowrap') set('whiteSpace', 'nowrap');
      else if (value === 'pre-wrap' || value === 'pre-line') set('whiteSpace', 'pre-wrap');
      else set('whiteSpace', 'normal');
      return;
    case 'text-transform':
      if (value === 'uppercase' || value === 'lowercase' || value === 'capitalize') set('textTransform', value);
      return;
    case 'width':
      set('width', value);
      return;
    case 'height':
      set('height', value);
      return;
    case 'min-height':
      set('minHeight', value);
      return;
    case 'vertical-align':
      if (value === 'top' || value === 'middle' || value === 'bottom') set('verticalAlign', value);
      return;
    case 'margin':
      applyBox(value, set, 'margin');
      return;
    case 'margin-top':
      set('marginTop', toPt(value));
      return;
    case 'margin-right':
      set('marginRight', toPt(value));
      return;
    case 'margin-bottom':
      set('marginBottom', toPt(value));
      return;
    case 'margin-left':
      set('marginLeft', toPt(value));
      return;
    case 'padding':
      applyBox(value, set, 'padding');
      return;
    case 'padding-top':
      set('paddingTop', toPt(value));
      return;
    case 'padding-right':
      set('paddingRight', toPt(value));
      return;
    case 'padding-bottom':
      set('paddingBottom', toPt(value));
      return;
    case 'padding-left':
      set('paddingLeft', toPt(value));
      return;
    case 'border':
      set('border', parseBorderShorthand(value));
      return;
    case 'border-top':
      set('borderTop', parseBorderShorthand(value));
      return;
    case 'border-bottom':
      set('borderBottom', parseBorderShorthand(value));
      return;
    case 'break-before':
    case 'page-break-before':
      set('breakBefore', value === 'always' || value === 'page' ? 'page' : value === 'avoid' ? 'avoid' : 'auto');
      return;
    case 'break-after':
    case 'page-break-after':
      set('breakAfter', value === 'always' || value === 'page' ? 'page' : value === 'avoid' ? 'avoid' : 'auto');
      return;
    case 'break-inside':
    case 'page-break-inside':
      set('breakInside', value === 'avoid' ? 'avoid' : 'auto');
      return;
    default:
      return;
  }
}

// Apply a CSS box shorthand (1..4 values) to top/right/bottom/left margins or
// paddings, in points.
function applyBox(value: string, set: (k: string, v: unknown) => void, kind: 'margin' | 'padding'): void {
  const parts = value.split(/\s+/).filter(Boolean);
  const [top = '0', right = top, bottom = top, left = right] = parts;
  set(`${kind}Top`, toPt(top));
  set(`${kind}Right`, toPt(right));
  set(`${kind}Bottom`, toPt(bottom));
  set(`${kind}Left`, toPt(left));
}

function parseBorderShorthand(value: string): BorderShorthand | undefined {
  if (!value || value === 'none' || value === '0') return undefined;
  const parts = value.split(/\s+/).filter(Boolean);
  let width = 1;
  let style: 'solid' | 'dashed' | 'dotted' | 'double' = 'solid';
  let color = 'black';
  for (const p of parts) {
    if (/px|pt|em|rem|cm|mm|in|%$/.test(p) && /^\d/.test(p)) width = toPt(p);
    else if (p === 'solid' || p === 'dashed' || p === 'dotted' || p === 'double') style = p;
    else color = p;
  }
  return [width, style, color];
}

// --- content mapping -------------------------------------------------------

const INLINE_BOLD = new Set(['b', 'strong']);
const INLINE_ITALIC = new Set(['i', 'em']);
const INLINE_UNDERLINE = new Set(['u', 'ins']);
const RUN_TOKENS: Record<string, string> = { PAGE: '$page.number', TOTAL: '$page.total', TOP: '$page.top' };
const TOKEN_RE = /\{(PAGE|TOTAL|TOP)\}/g;

function textToContent(text: string, style: IrBox | undefined): Content {
  // Split out {PAGE}/{TOTAL}/{TOP} running-token placeholders.
  const pieces: Array<string | ContentSpan> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) pieces.push(text.slice(last, m.index));
    const span: ContentSpan = { bind: exprSource(RUN_TOKENS[m[1]!]!) };
    if (style && Object.keys(style).length) span.style = style as Partial<StyleProps>;
    pieces.push(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces.length === 1 && typeof pieces[0] === 'string' ? pieces[0] : pieces;
}

function elementStyle(el: HElement, opts: HtmlOptions): IrBox {
  const classes = (el.attrs['class'] ?? '').split(/\s+/).filter(Boolean);
  const classStyles = classes.map((c) => opts.styles?.[c] ?? {}).filter(Boolean);
  return cssToIr(el.attrs['style'] ?? '', classStyles);
}

/** Merge two IR box props; `over` wins on defined keys. */
function mergeIr(base: IrBox, over: IrBox): IrBox {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k] = v;
  return out as IrBox;
}

function isBlock(node: HNode): node is HElement {
  return node.type === 'element' && BLOCK_TAGS.has(node.tag);
}

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'li', 'hr', 'blockquote']);

/** Inline content of an element (its text + nested inline spans). */
function inlineContent(el: HElement, opts: HtmlOptions, inherited: IrBox): Content {
  const out: Array<string | number | ContentSpan> = [];
  const push = (v: string | ContentSpan): void => {
    const prev = out[out.length - 1];
    if (typeof v === 'string' && typeof prev === 'string') out[out.length - 1] = prev + v;
    else out.push(v);
  };
  const walk = (node: HNode, style: IrBox): void => {
    if (node.type === 'text') {
      if (!/\S/.test(node.text) && node.text.length && !node.text.includes(' ')) return;
      const content = textToContent(node.text, Object.keys(style).length ? style : undefined);
      if (Array.isArray(content)) for (const c of content) push(c as string | ContentSpan);
      else push(content as string);
      return;
    }
    if (node.tag === 'br') {
      push('\n');
      return;
    }
    const elStyle = mergeIr(style, elementStyle(node, opts));
    const delta: IrBox = { ...elStyle };
    if (INLINE_BOLD.has(node.tag)) delta.fontWeight = 700;
    if (INLINE_ITALIC.has(node.tag)) delta.fontStyle = 'italic';
    if (INLINE_UNDERLINE.has(node.tag)) delta.textDecoration = ['underline'];
    const spanStyle = mergeIr(style, delta);
    if (node.attrs['data-bind'] !== undefined) {
      const span: ContentSpan = { bind: exprSource(node.attrs['data-bind']) };
      if (node.attrs['data-format']) span.format = node.attrs['data-format'];
      if (Object.keys(spanStyle).length) span.style = spanStyle as Partial<StyleProps>;
      push(span);
      return;
    }
    const children = inlineContent(node, opts, spanStyle);
    const span: ContentSpan = { text: children };
    if (Object.keys(delta).length || node.tag !== 'span') span.style = delta as Partial<StyleProps>;
    push(span);
  };
  for (const child of el.children) walk(child, inherited);
  return out.length === 1 ? out[0]! : out;
}

// --- block/table mapping ---------------------------------------------------

function leafContent(el: HElement, opts: HtmlOptions, style: IrBox): Content {
  if (el.attrs['data-bind'] !== undefined) {
    const span: ContentSpan = { bind: exprSource(el.attrs['data-bind']) };
    if (el.attrs['data-format']) span.format = el.attrs['data-format'];
    return [span];
  }
  return inlineContent(el, opts, style);
}

function elToBlock(el: HElement, opts: HtmlOptions): Block[] {
  if (el.tag === 'hr') {
    return [{ type: 'spacer', size: 6, ...(elementStyle(el, opts)) } as Block];
  }
  const style = elementStyle(el, opts);
  const heading = /^h([1-6])$/.exec(el.tag);
  if (heading) {
    return [{ type: 'heading', level: Number(heading[1]), content: leafContent(el, opts, style), ...style } as Block];
  }
  if (el.tag === 'table') return [tableBlock(el, opts, style)];

  const blockChildren = el.children.filter(isBlock);
  if (blockChildren.length > 0) {
    const nested: Block[] = [];
    for (const c of el.children) {
      if (c.type === 'element' && isBlock(c)) nested.push(...elToBlock(c, opts));
      else if (c.type === 'text' && /\S/.test(c.text)) nested.push({ type: 'paragraph', content: textToContent(c.text, style), ...style } as Block);
    }
    return nested;
  }
  if (el.tag === 'li') {
    const content = inlineContent(el, opts, style);
    const bullet = Array.isArray(content) ? ['\u2022 ', ...content] : ['\u2022 ', content];
    return [{ type: 'paragraph', content: bullet, ...style, marginLeft: (style.marginLeft ?? 0) + 12 } as Block];
  }
  return [{ type: 'paragraph', content: leafContent(el, opts, style), ...style } as Block];
}

function rowsOf(el: HElement): HElement[] {
  return el.children.filter((c): c is HElement => c.type === 'element' && c.tag === 'tr');
}
function cellsOf(tr: HElement): HElement[] {
  return tr.children.filter((c): c is HElement => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'));
}

function toCellNode(td: HElement, opts: HtmlOptions): CellNode {
  const style = elementStyle(td, opts);
  const cell: CellNode = {};
  if (td.attrs['data-bind'] !== undefined) cell.content = [{ bind: exprSource(td.attrs['data-bind']), format: td.attrs['data-format'] }];
  else cell.content = inlineContent(td, opts, style);
  if (Object.keys(style).length) cell.style = style as Partial<StyleProps>;
  if (td.attrs['colspan']) cell.colSpan = Number(td.attrs['colspan']) || undefined;
  if (td.attrs['rowspan']) cell.rowSpan = Number(td.attrs['rowspan']) || undefined;
  if (td.attrs['align']) cell.align = (ALIGN[td.attrs['align']] ?? 'left') as CellNode['align'];
  // Lift box props from the parsed style onto the dedicated CellNode fields the
  // layout engine actually paints (fill, drawn border, padding, vertical align).
  const s = style as Record<string, unknown>;
  if (s.backgroundColor !== undefined) cell.backgroundColor = s.backgroundColor as CellNode['backgroundColor'];
  if (s.border !== undefined) cell.border = s.border as BorderShorthand;
  if (s.paddingTop !== undefined) cell.paddingTop = s.paddingTop as number;
  if (s.paddingRight !== undefined) cell.paddingRight = s.paddingRight as number;
  if (s.paddingBottom !== undefined) cell.paddingBottom = s.paddingBottom as number;
  if (s.paddingLeft !== undefined) cell.paddingLeft = s.paddingLeft as number;
  if (s.verticalAlign !== undefined) cell.verticalAlign = s.verticalAlign as CellNode['verticalAlign'];
  if (cell.align === undefined && s.align !== undefined) cell.align = s.align as CellNode['align'];
  return cell;
}

function toRowNode(tr: HElement, opts: HtmlOptions, kind: RowNode['kind']): RowNode {
  return { kind, cells: cellsOf(tr).map((td) => toCellNode(td, opts)) };
}

function tableBlock(table: HElement, opts: HtmlOptions, style: IrBox): Block {
  const groups = table.children.filter((c): c is HElement => c.type === 'element');
  const thead = groups.find((g) => g.tag === 'thead');
  const tbody = groups.find((g) => g.tag === 'tbody');
  const tfoot = groups.find((g) => g.tag === 'tfoot');

  const block: Record<string, unknown> = { type: 'table', ...style };

  // Table grid + striping, driven by idiomatic attributes:
  //   <table border>            -> default 0.5pt gray grid on every cell
  //   <table data-grid="1px solid #444"> -> custom grid shorthand
  //   <table data-striped [data-striped-color="#f2f2f2"]> -> alternating row fill
  const gridAttr = table.attrs['data-grid'];
  const borderAttr = table.attrs['border'];
  if (gridAttr !== undefined) {
    block.showGrid = gridAttr === '' || gridAttr === 'true' ? true : (parseBorderShorthand(gridAttr) ?? true);
  } else if (borderAttr !== undefined && borderAttr !== '0') {
    block.showGrid = true;
  }
  const stripedAttr = table.attrs['data-striped'];
  if (stripedAttr !== undefined) {
    const color = table.attrs['data-striped-color'];
    block.striped = color ? { color } : true;
  }

  let headerRows = thead ? rowsOf(thead) : [];
  const dataRows = tbody ? rowsOf(tbody) : rowsOf(table);
  const footRows = tfoot ? rowsOf(tfoot) : [];

  const eachAttr = table.attrs['data-each'] ?? table.attrs['data-bind'];

  if (eachAttr) {
    // Bound data table: `<tbody>`'s first `<tr>` is the row template.
    block.dataSource = buildDataSource(table.attrs['data-each'], table.attrs['data-bind']);
    const template = dataRows[0];
    if (template) {
      block.detail = { cells: cellsOf(template).map((td) => toCellNode(td, opts)) };
      block.columns = cellsOf(template).map((td) => columnOf(td, opts));
    }
  } else if (dataRows.length) {
    // Literal table: a leading all-`<th>` row (without a `<thead>`) is the header.
    if (headerRows.length === 0 && firstRowIsHeader(dataRows[0])) headerRows = [dataRows.shift()!];
    // Each body row is kept as an authored static row so its per-cell background,
    // border and padding survive (a shared `detail` template would discard them).
    block.staticRows = dataRows.map((tr) => toRowNode(tr, opts, 'detail'));
  }

  if (headerRows.length) block.headerRows = headerRows.map((tr) => toRowNode(tr, opts, 'header'));
  if (footRows.length) block.footerRows = footRows.map((tr) => toRowNode(tr, opts, 'subtotal'));
  block.repeatHeader = block.headerRows ? true : undefined;
  return block as unknown as Block;
}

/** `data-each="item in $data.list"` / `data-bind="$data.list"` -> a DataSource. */
function buildDataSource(eachRaw: string | undefined, bindRaw: string | undefined): DataSource {
  if (eachRaw !== undefined) {
    const parts = eachRaw.split(/\s+in\s+/i);
    const alias = (parts[0] ?? 'item').trim();
    const list = (parts.length > 1 ? parts[1] ?? '' : parts[0] ?? '').trim();
    return { each: alias, of: exprSource(list) ?? list };
  }
  const src = exprSource(bindRaw) ?? bindRaw ?? '';
  return { bind: src };
}


function columnOf(td: HElement, opts: HtmlOptions): ColumnNode {
  const style = elementStyle(td, opts);
  const col: ColumnNode = {};
  if (style.width !== undefined) col.width = style.width as number | string;
  if (td.attrs['align']) col.align = (ALIGN[td.attrs['align']] ?? 'left') as ColumnNode['align'];
  else if (style.align === 'right' || style.align === 'center') col.align = style.align;
  if (Object.keys(style).length) col.style = style as Partial<StyleProps>;
  const bind = td.attrs['data-bind'];
  if (bind) col.key = exprSource(bind) ?? bind;
  return col;
}

function firstRowIsHeader(tr: HElement | undefined): boolean {
  if (!tr) return false;
  return cellsOf(tr).every((c) => c.tag === 'th');
}

/** Flatten a cell subtree to plain text (for the synthesised literal-table data). */
function literalText(el: HNode): string {
  if (el.type === 'text') return el.text.replace(/\s+/g, ' ').trim();
  return el.children.map(literalText).join(' ').replace(/\s+/g, ' ').trim();
}

// --- entry point -----------------------------------------------------------

export interface HtmlOptions {
  /** Class-name -> IR style overrides, applied before inline `style`. */
  styles?: Record<string, IrBox>;
  /** Report data made available to `data-bind` / `data-each` expressions. */
  data?: Record<string, unknown>;
  /** Report-level base style, merged under `<body style>`. */
  style?: Partial<StyleProps>;
  info?: ReportDoc['info'];
}

function findFirst(root: HElement, tag: string): HElement | undefined {
  let found: HElement | undefined;
  const walk = (el: HElement): void => {
    if (found) return;
    for (const c of el.children) {
      if (c.type === 'element') {
        if (c.tag === tag) {
          found = c;
          return;
        }
        walk(c);
        if (found) return;
      }
    }
  };
  walk(root);
  return found;
}

/** Elements tagged `data-band="..."` become repeated page bands, not body flow. */
const BAND_TYPES = new Set<BandType>(['pageHeader', 'pageFooter', 'title', 'summary', 'background']);

/** Turn a band element into `BandContent` (its inline content + optional height). */
function bandContent(el: HElement, opts: HtmlOptions): BandContent {
  const style = elementStyle(el, opts);
  const band: BandContent = { blocks: elToBlock(el, opts) };
  if (style.height !== undefined) band.height = toPt(style.height);
  return band;
}

/** Convert constrained authoring HTML into the report IR. */
export function htmlToReportDoc(html: string, opts: HtmlOptions = {}): ReportDoc {
  const tree = parseHtml(html);
  const body = findFirst(tree, 'body') ?? tree;
  const reportStyle = cssToIr(body.attrs['style'] ?? '', []) as Partial<StyleProps>;

  const blocks: Block[] = [];
  const bands: Partial<Record<BandType, BandContent>> = {};
  for (const child of body.children) {
    if (child.type === 'text') {
      if (/\S/.test(child.text)) blocks.push({ type: 'paragraph', content: textToContent(child.text.trim(), undefined) } as Block);
      continue;
    }
    const bandName = child.attrs['data-band'] as BandType | undefined;
    if (bandName && BAND_TYPES.has(bandName)) {
      bands[bandName] = bandContent(child, opts);
      continue;
    }
    blocks.push(...elToBlock(child, opts));
  }

  return {
    info: opts.info,
    data: opts.data,
    style: { ...opts.style, ...reportStyle },
    ...(Object.keys(bands).length ? { bands } : {}),
    body: blocks,
  };
}
