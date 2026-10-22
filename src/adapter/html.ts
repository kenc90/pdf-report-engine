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
import type { PageSpec } from '../core/page.js';
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
  FontReference,
  ChartBlock,
  ChartKind,
  ColorScale,
  StyleCondition,
  TocBlock,
  BarcodeBlock,
  BarcodeSymbology,
  DiagonalHeader,
  SvgBlock,
  FlexBlock,
  FlexItem,
  ReferenceLine,
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
  // Quoted attribute values may legally contain `<`/`>` (e.g. `data-if="$row.amount > 0"`),
  // so the tag body is scanned as quoted spans plus bare non-`>` characters.
  const tagRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!\w[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?)\s*(\/?)>/g;
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
  // Class styles are overridden by inline `style` (applied last).
  const merged: IrBox = {};
  for (const c of classStyles) Object.assign(merged, c);
  Object.assign(merged, declarationsToIr(style));
  return merged;
}

/** Parse one declaration block (`font-size: 12px; color: #333`) into IR props. */
function declarationsToIr(style: string): IrBox {
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown): void => {
    out[k] = v;
  };
  for (const decl of style.split(';').map((d) => d.trim()).filter(Boolean)) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim().replace(/\s*!important$/i, '');
    applyDecl(prop, value, set);
  }
  return out as IrBox;
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
      {
        const deco: Array<'underline' | 'line-through'> = [];
        if (value.includes('underline')) deco.push('underline');
        if (value.includes('line-through')) deco.push('line-through');
        if (deco.length) set('textDecoration', deco);
      }
      return;
    case 'opacity':
      {
        const n = Number(value);
        if (Number.isFinite(n)) set('opacity', Math.min(1, Math.max(0, n)));
      }
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
    // --- flexbox (subset) -------------------------------------------------
    case 'display':
      if (value === 'flex' || value === 'inline-flex') set('display', 'flex');
      return;
    case 'flex-direction':
      if (value === 'column' || value === 'column-reverse') set('direction', 'column');
      else if (value === 'row' || value === 'row-reverse') set('direction', 'row');
      return;
    case 'flex-wrap':
      set('wrap', value === 'wrap' || value === 'wrap-reverse');
      return;
    case 'justify-content':
      if (/^(flex-start|start|left)$/.test(value)) set('justify', 'flex-start');
      else if (/^(flex-end|end|right)$/.test(value)) set('justify', 'flex-end');
      else if (value === 'center') set('justify', 'center');
      else if (value === 'space-between') set('justify', 'space-between');
      else if (value === 'space-around') set('justify', 'space-around');
      else if (value === 'space-evenly') set('justify', 'space-evenly');
      return;
    case 'align-items':
      if (value === 'flex-start' || value === 'start') set('alignItems', 'flex-start');
      else if (value === 'flex-end' || value === 'end') set('alignItems', 'flex-end');
      else if (value === 'center') set('alignItems', 'center');
      else if (value === 'stretch') set('alignItems', 'stretch');
      return;
    case 'gap':
    case 'grid-gap': {
      // `gap` accepts one or two values: `gap: <row> <column>`. A single value
      // sets both axes; two values split into rowGap / columnGap.
      const parts = value.trim().split(/\s+/);
      if (parts.length > 1) {
        set('rowGap', parts[0]!);
        set('columnGap', parts[1]!);
      } else {
        set('gap', parts[0]!);
      }
      return;
    }
    case 'row-gap':
      set('rowGap', value.trim());
      return;
    case 'column-gap':
      set('columnGap', value.trim());
      return;
    case 'flex-grow': {
      const n = Number(value);
      if (Number.isFinite(n)) set('grow', n);
      return;
    }
    case 'flex-shrink': {
      const n = Number(value);
      if (Number.isFinite(n)) set('shrink', n);
      return;
    }
    case 'flex-basis':
      if (value !== 'auto') set('basis', value.trim());
      return;
    case 'flex': {
      // `flex: <grow> <shrink> <basis>` shorthand.
      const parts = value.trim().split(/\s+/);
      const g = Number(parts[0]);
      if (Number.isFinite(g)) set('grow', g);
      if (parts.length > 1) {
        const sh = Number(parts[1]);
        if (Number.isFinite(sh)) set('shrink', sh);
      }
      if (parts.length > 2 && parts[2] !== 'auto') set('basis', parts[2]!);
      return;
    }
    case 'align-self':
      if (value === 'auto') set('alignSelf', 'auto');
      else if (value === 'flex-start' || value === 'start') set('alignSelf', 'flex-start');
      else if (value === 'flex-end' || value === 'end') set('alignSelf', 'flex-end');
      else if (value === 'center') set('alignSelf', 'center');
      else if (value === 'stretch') set('alignSelf', 'stretch');
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

// --- stylesheet cascade ----------------------------------------------------

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
}
interface SelectorStep extends Compound {
  /** Relationship to the part on its left (`a > b` = child, `a b` = descendant). */
  combinator: 'descendant' | 'child';
}
interface CssRule {
  parts: SelectorStep[];
  style: IrBox;
  order: number;
  specificity: number;
}

/**
 * Parse `<style>` contents into flat rules. At-rules (`@media`, `@font-face`,
 * `@page`) are skipped whole — their bodies are not flat declaration blocks.
 */
function parseStyleSheet(css: string): CssRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let order = 0;
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) break;
    const prelude = source.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      j += 1;
    }
    const body = source.slice(open + 1, j - 1);
    i = j;
    if (!prelude || prelude.startsWith('@')) continue;
    const style = declarationsToIr(body);
    if (Object.keys(style).length === 0) continue;
    for (const raw of prelude.split(',')) {
      const parts = parseSelector(raw.trim());
      if (parts.length === 0) continue;
      rules.push({ parts, style, order: order++, specificity: specificityOf(parts) });
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

/** `h2.title > em` → [h2.title, em(child)]; unsupported syntax yields []. */
function parseSelector(text: string): SelectorStep[] {
  if (!text || /[:[]/.test(text)) return [];
  const tokens = text.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  const parts: SelectorStep[] = [];
  let pending: 'descendant' | 'child' = 'descendant';
  for (const token of tokens) {
    if (token === '>') {
      pending = 'child';
      continue;
    }
    const compound = parseCompound(token);
    if (!compound) return [];
    parts.push({ ...compound, combinator: parts.length === 0 ? 'descendant' : pending });
    pending = 'descendant';
  }
  return parts;
}

function parseCompound(token: string): Compound | undefined {
  let rest = token;
  let tag: string | undefined;
  const tagMatch = /^(\*|[a-zA-Z][\w-]*)/.exec(rest);
  if (tagMatch) {
    if (tagMatch[1] !== '*') tag = tagMatch[1]!.toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }
  let id: string | undefined;
  const classes: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m) return undefined;
      id = m[1];
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('.')) {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m) return undefined;
      classes.push(m[1]!);
      rest = rest.slice(m[0].length);
    } else {
      return undefined;
    }
  }
  return tag || id || classes.length ? { tag, id, classes } : undefined;
}

function specificityOf(parts: SelectorStep[]): number {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const part of parts) {
    if (part.id) ids += 1;
    classes += part.classes.length;
    if (part.tag) tags += 1;
  }
  return ids * 10000 + classes * 100 + tags;
}

/**
 * Resolve matched declarations for every element once, before blocks are built.
 * Walking with an ancestor stack keeps descendant/child matching honest without
 * threading parents through every conversion helper.
 */
function computeMatchedStyles(root: HElement, rules: CssRule[]): WeakMap<HElement, IrBox> {
  const matched = new WeakMap<HElement, IrBox>();
  if (rules.length === 0) return matched;
  const walk = (el: HElement, ancestors: HElement[]): void => {
    const style: IrBox = {};
    let any = false;
    for (const rule of rules) {
      if (matchesChain(el, rule.parts, rule.parts.length - 1, ancestors)) {
        Object.assign(style, rule.style);
        any = true;
      }
    }
    if (any) matched.set(el, style);
    for (const child of el.children) if (child.type === 'element') walk(child, [...ancestors, el]);
  };
  for (const child of root.children) if (child.type === 'element') walk(child, [root]);
  return matched;
}

function matchesChain(el: HElement, parts: SelectorStep[], index: number, ancestors: HElement[]): boolean {
  if (!matchesCompound(el, parts[index]!)) return false;
  if (index === 0) return true;
  if (parts[index]!.combinator === 'child') {
    const parent = ancestors[ancestors.length - 1];
    return parent !== undefined && matchesChain(parent, parts, index - 1, ancestors.slice(0, -1));
  }
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (matchesChain(ancestors[i]!, parts, index - 1, ancestors.slice(0, i))) return true;
  }
  return false;
}

function matchesCompound(el: HElement, step: SelectorStep): boolean {
  if (step.tag && step.tag !== el.tag) return false;
  if (step.id && step.id !== el.attrs['id']) return false;
  if (step.classes.length > 0) {
    const classes = new Set((el.attrs['class'] ?? '').split(/\s+/).filter(Boolean));
    for (const name of step.classes) if (!classes.has(name)) return false;
  }
  return true;
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
  // Cascade order: stylesheet rules (already sorted by specificity) < the
  // programmatic class map < inline `style`.
  const matched = opts._selectorStyles?.get(el);
  return cssToIr(el.attrs['style'] ?? '', matched ? [matched, ...classStyles] : classStyles);
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

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'li', 'hr', 'img', 'svg', 'blockquote']);

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
      // U+2028 LINE SEPARATOR, not '\n'. The typesetting normaliser collapses
      // ASCII whitespace (including LF) under `white-space: normal`, which would
      // silently turn <br> into a space. U+2028 survives collapsing and is
      // classified as LB.BK (mandatory break) by findBreaks, so the packer emits
      // a hard line break regardless of the surrounding whitespace mode.
      push('\u2028');
      return;
    }
    const elStyle = mergeIr(style, elementStyle(node, opts));
    const delta: IrBox = { ...elStyle };
    if (INLINE_BOLD.has(node.tag)) delta.fontWeight = 700;
    if (INLINE_ITALIC.has(node.tag)) delta.fontStyle = 'italic';
    if (INLINE_UNDERLINE.has(node.tag)) delta.textDecoration = ['underline'];
    // <mark> carries the browser's default highlight unless the element itself
    // sets a background (a parent block's fill must not mask the highlight).
    if (node.tag === 'mark' && elementStyle(node, opts).backgroundColor === undefined) {
      delta.backgroundColor = '#fff2a8';
    }
    const href = node.tag === 'a' ? node.attrs['href'] : undefined;
    if (href && delta.textDecoration === undefined) delta.textDecoration = ['underline'];
    const spanStyle = mergeIr(style, delta);
    if (node.attrs['data-bind'] !== undefined) {
      const span: ContentSpan = { bind: exprSource(node.attrs['data-bind']) };
      if (node.attrs['data-format']) span.format = node.attrs['data-format'];
      if (href) span.link = href;
      if (Object.keys(spanStyle).length) span.style = spanStyle as Partial<StyleProps>;
      push(span);
      return;
    }
    const children = inlineContent(node, opts, spanStyle);
    const span: ContentSpan = { text: children };
    if (href) span.link = href;
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

// --- declarative chart / toc / barcode blocks ------------------------------

function boolAttr(el: HElement, name: string, fallback: boolean): boolean {
  const raw = el.attrs[name];
  if (raw === undefined) return fallback;
  return !/^(false|0|no|off)$/i.test(raw.trim());
}

function numAttr(el: HElement, name: string): number | undefined {
  const raw = el.attrs[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function chartKind(value: string | undefined, fallback: ChartKind = 'bar'): ChartKind {
  const v = (value ?? '').trim().toLowerCase();
  const known: ChartKind[] = ['bar', 'line', 'area', 'pie', 'donut', 'combo', 'waterfall', 'scatter', 'bubble', 'radar', 'gauge', 'heatmap'];
  return (known as string[]).includes(v) ? (v as ChartKind) : fallback;
}

function applyChartOptions(el: HElement, block: ChartBlock): void {
  const colors = el.attrs['data-colors'];
  if (colors) block.colors = colors.split(',').map((c) => c.trim()).filter(Boolean);
  if (el.attrs['data-stacked'] !== undefined) {
    const raw = el.attrs['data-stacked'].trim().toLowerCase();
    block.stacked = raw === '100%' || raw === '100' || raw === 'percent' ? '100%' : boolAttr(el, 'data-stacked', true);
  }
  if (el.attrs['data-show-values'] !== undefined) block.showValues = boolAttr(el, 'data-show-values', true);
  if (el.attrs['data-category-labels'] !== undefined) block.categoryLabels = boolAttr(el, 'data-category-labels', true);
  const legend = el.attrs['data-legend'];
  if (legend === 'none' || legend === 'top' || legend === 'bottom' || legend === 'right') block.legend = legend;
  else if (legend === 'false') block.legend = 'none';
  const inner = numAttr(el, 'data-inner-radius');
  if (inner !== undefined) block.innerRadius = inner;
  const plotH = numAttr(el, 'data-plot-height');
  if (plotH !== undefined) block.plotHeight = plotH;

  const axis: NonNullable<ChartBlock['valueAxis']> = {};
  const min = numAttr(el, 'data-min');
  const max = numAttr(el, 'data-max');
  const ticks = numAttr(el, 'data-ticks');
  if (min !== undefined) axis.min = min;
  if (max !== undefined) axis.max = max;
  if (ticks !== undefined) axis.ticks = ticks;
  if (el.attrs['data-value-format']) axis.format = el.attrs['data-value-format'];
  if (el.attrs['data-axis-labels'] !== undefined) axis.labels = boolAttr(el, 'data-axis-labels', true);
  if (el.attrs['data-grid-lines'] !== undefined) axis.gridLines = boolAttr(el, 'data-grid-lines', true);
  if (Object.keys(axis).length > 0) block.valueAxis = axis;

  // Combo charts: the secondary axis and per-series type/axis hints.
  const right: NonNullable<ChartBlock['rightAxis']> = {};
  const rMin = numAttr(el, 'data-right-min');
  const rMax = numAttr(el, 'data-right-max');
  const rTicks = numAttr(el, 'data-right-ticks');
  if (rMin !== undefined) right.min = rMin;
  if (rMax !== undefined) right.max = rMax;
  if (rTicks !== undefined) right.ticks = rTicks;
  if (el.attrs['data-right-format']) right.format = el.attrs['data-right-format'];
  if (el.attrs['data-right-axis-labels'] !== undefined) right.labels = boolAttr(el, 'data-right-axis-labels', true);
  if (Object.keys(right).length > 0) block.rightAxis = right;

  // Waterfall: total indices and colour overrides.
  const totals = el.attrs['data-totals'];
  if (totals !== undefined && totals.trim() !== '') {
    block.totals = totals
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  const waterfall = el.attrs['data-waterfall-colors'];
  if (waterfall) {
    const wf: NonNullable<ChartBlock['waterfallColors']> = {};
    for (const part of waterfall.split(/[;,]/)) {
      const [key, value] = part.split('=');
      const k = (key ?? '').trim().toLowerCase();
      const v = (value ?? '').trim();
      if (!v) continue;
      if (k === 'increase' || k === 'decrease' || k === 'total') wf[k] = v;
    }
    if (Object.keys(wf).length > 0) block.waterfallColors = wf;
  }

  // Scatter / bubble: a numeric x-axis format and per-series x/r columns live on
  // the series (see applySeriesShape), so only the axis pattern is read here.
  if (el.attrs['data-x-format']) (block.valueAxis ??= {}).xFormat = el.attrs['data-x-format'];

  // Range bars: draw each bar from low→high instead of zero→value.
  if (el.attrs['data-range'] !== undefined) block.range = boolAttr(el, 'data-range', true);

  // Gauge: needle value + full-scale maximum.
  const gaugeMax = numAttr(el, 'data-gauge-max');
  if (gaugeMax !== undefined) block.gaugeMax = gaugeMax;
  if (el.attrs['data-gauge-value'] !== undefined) block.gaugeValue = el.attrs['data-gauge-value'].trim();

  // Heatmap: value labels + colour ramp.
  if (el.attrs['data-heatmap-labels'] !== undefined) block.heatmapLabels = boolAttr(el, 'data-heatmap-labels', true);
  const heat = el.attrs['data-heatmap-colors'];
  if (heat) {
    const hc: NonNullable<ChartBlock['heatmapColors']> = {};
    for (const part of heat.split(/[;,]/)) {
      const [key, value] = part.split('=');
      const k = (key ?? '').trim().toLowerCase();
      const v = (value ?? '').trim();
      if (!v) continue;
      if (k === 'from' || k === 'to') hc[k] = v;
    }
    if (Object.keys(hc).length > 0) block.heatmapColors = hc;
  }

  // Reference / threshold lines: `data-reference-lines="50:max;80,color=#c00"`
  // semicolon-separated; each line is `value[:label][ key=val ...]`.
  const refs = el.attrs['data-reference-lines'];
  if (refs) {
    const lines: ReferenceLine[] = [];
    for (const segment of refs.split(';')) {
      const parts = segment.trim().split(/[,\s]+/).filter(Boolean);
      if (parts.length === 0) continue;
      // The first token is `value` or `value:label`.
      const head = parts[0]!;
      const colon = head.indexOf(':');
      const value = Number(colon < 0 ? head : head.slice(0, colon));
      if (!Number.isFinite(value)) continue;
      const line: ReferenceLine = { value };
      if (colon >= 0 && head.slice(colon + 1)) line.label = head.slice(colon + 1);
      for (const kv of parts.slice(1)) {
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const k = kv.slice(0, eq).trim().toLowerCase();
        const v = kv.slice(eq + 1).trim();
        if (k === 'label') line.label = v;
        else if (k === 'color' || k === 'colour') line.color = v;
        else if (k === 'axis' && (v === 'left' || v === 'right')) line.axis = v;
        else if (k === 'dash') {
          const nums = v.split(/:/).map((n) => Number(n)).filter((n) => Number.isFinite(n));
          if (nums.length) line.dash = nums;
        }
      }
      lines.push(line);
    }
    if (lines.length) block.referenceLines = lines;
  }
}

/** `data-series-types="bar,line"` / `data-series-axes="left,right"`, aligned by index. */
function applySeriesShape(el: HElement, block: ChartBlock): void {
  const types = (el.attrs['data-series-types'] ?? '').split(',').map((s) => s.trim().toLowerCase());
  const axes = (el.attrs['data-series-axes'] ?? '').split(',').map((s) => s.trim().toLowerCase());
  for (let i = 0; i < block.series.length; i += 1) {
    const type = types[i];
    const axis = axes[i];
    if (type === 'bar' || type === 'line' || type === 'area') block.series[i]!.type = type;
    if (axis === 'left' || axis === 'right') block.series[i]!.axis = axis;
  }
  // Scatter / bubble / range: parallel per-series columns, semicolon-separated.
  assignSeriesColumn(el, block, 'data-series-x', 'xValues');
  assignSeriesColumn(el, block, 'data-series-r', 'rValues');
  assignSeriesColumn(el, block, 'data-series-low', 'low');
  assignSeriesColumn(el, block, 'data-series-high', 'high');
}

/** Split `data-series-x="1,2;3,4"` into per-series arrays aligned by index. */
function assignSeriesColumn(el: HElement, block: ChartBlock, attr: string, key: 'xValues' | 'rValues' | 'low' | 'high'): void {
  const raw = el.attrs[attr];
  if (raw === undefined) return;
  const groups = raw.split(';').map((s) => s.trim());
  for (let i = 0; i < block.series.length; i += 1) {
    const group = groups[i];
    if (group === undefined || group === '') continue;
    const target = block.series[i];
    if (target) (target as unknown as Record<string, unknown>)[key] = group;
  }
}

function chartFromElement(el: HElement, style: IrBox): ChartBlock {
  const kindAttr = el.attrs['data-chart'];
  const kind = chartKind(kindAttr && kindAttr !== 'true' ? kindAttr : el.attrs['data-kind']);
  const block: ChartBlock = { type: 'chart', kind, series: [], ...(style as Partial<ChartBlock>) };
  const title = el.attrs['data-title'] ?? el.attrs['title'];
  if (title) block.title = title;

  if (el.attrs['data-categories'] !== undefined) block.categories = el.attrs['data-categories'];
  const seriesAttr = el.attrs['data-series'];
  if (seriesAttr !== undefined) {
    block.series = seriesAttr
      .split(';')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .map((segment) => {
        const colon = segment.indexOf(':');
        return colon < 0
          ? { values: segment }
          : { name: segment.slice(0, colon).trim(), values: segment.slice(colon + 1).trim() };
      });
  } else if (el.attrs['data-values'] !== undefined) {
    block.series = [
      { name: el.attrs['data-name'], values: el.attrs['data-values'], color: el.attrs['data-color'] },
    ];
  }
  applyChartOptions(el, block);
  applySeriesShape(el, block);
  return block;
}

/** Build a chart from a literal `<table>`: header row = series, first column = categories. */
function chartFromTable(table: HElement, style: IrBox): ChartBlock {
  const thead = table.children.find((c): c is HElement => c.type === 'element' && c.tag === 'thead');
  const tbody = table.children.find((c): c is HElement => c.type === 'element' && c.tag === 'tbody');
  const rows = [...(thead ? rowsOf(thead) : []), ...(tbody ? rowsOf(tbody) : rowsOf(table))];
  const texts = rows.map((tr) => cellsOf(tr).map((td) => literalText(td)));

  let header: string[] = [];
  let body = texts;
  if (texts.length > 1 && texts[0]!.length > 1 && texts[0]!.slice(1).every((t) => !Number.isFinite(parseLooseNumber(t)))) {
    header = texts[0]!;
    body = texts.slice(1);
  }

  const seriesCount = body.reduce((n, row) => Math.max(n, row.length - 1), 0);
  const series = Array.from({ length: seriesCount }, (_, i) => ({
    name: header[i + 1] || undefined,
    values: body.map((row) => parseLooseNumber(row[i + 1] ?? '')),
  }));

  const kindAttr = table.attrs['data-chart'];
  const kind = chartKind(kindAttr && kindAttr !== 'true' ? kindAttr : table.attrs['data-kind']);
  const block: ChartBlock = {
    type: 'chart',
    kind,
    categories: body.map((row) => row[0] ?? ''),
    series,
    ...(style as Partial<ChartBlock>),
  };
  const title = table.attrs['data-title'] ?? table.attrs['title'];
  if (title) block.title = title;
  applyChartOptions(table, block);
  return block;
}

/** Numbers in a rendered table cell: strips currency/grouping, handles `(123)`. */
function parseLooseNumber(text: string): number {
  const trimmed = text.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[,\s$€£¥%()]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return Number.NaN;
  return negative ? -n : n;
}

function tocFromElement(el: HElement, style: IrBox): TocBlock {
  const block: TocBlock = { type: 'toc', ...(style as Partial<TocBlock>) };
  const title = el.attrs['data-title'] ?? el.attrs['title'];
  const text = (title ?? literalText(el)).trim();
  if (text) block.title = text;
  const maxLevel = numAttr(el, 'data-max-level') ?? numAttr(el, 'data-level');
  if (maxLevel !== undefined) block.maxLevel = maxLevel;
  if (el.attrs['data-leaders'] !== undefined) block.leaders = boolAttr(el, 'data-leaders', true);
  if (el.attrs['data-page-numbers'] !== undefined) block.pageNumbers = boolAttr(el, 'data-page-numbers', true);
  const indent = numAttr(el, 'data-indent');
  if (indent !== undefined) block.indent = indent;
  const gap = numAttr(el, 'data-gap');
  if (gap !== undefined) block.gap = gap;
  return block;
}

function barcodeFromElement(el: HElement, style: IrBox): BarcodeBlock {
  const raw = (el.attrs['data-barcode'] ?? '').trim().toLowerCase();
  const symbology: BarcodeSymbology = raw === 'qr' || raw === 'ean13' ? raw : 'code128';
  const bind = el.attrs['data-bind'];
  const value: Content =
    bind !== undefined
      ? [{ bind: exprSource(bind), format: el.attrs['data-format'] }]
      : el.attrs['data-value'] ?? literalText(el);
  const block: BarcodeBlock = { type: 'barcode', symbology, value, ...(style as Partial<BarcodeBlock>) };

  const ec = el.attrs['data-error-correction'];
  if (ec === 'L' || ec === 'M' || ec === 'Q' || ec === 'H') block.errorCorrection = ec;
  const moduleSize = numAttr(el, 'data-module-size');
  if (moduleSize !== undefined) block.moduleSize = moduleSize;
  const quiet = numAttr(el, 'data-quiet-zone');
  if (quiet !== undefined) block.quietZone = quiet;
  if (el.attrs['data-show-text'] !== undefined) block.showText = boolAttr(el, 'data-show-text', true);
  if (el.attrs['data-color']) block.color = el.attrs['data-color'];
  return block;
}

// --- inline svg + flexbox containers ---------------------------------------

/** Does this `<img src>` (or inline source) point at a vector SVG? */
function isSvgSource(src: string): boolean {
  if (!src) return false;
  const t = src.trimStart();
  if (/<svg[\s>]/i.test(t.slice(0, 256))) return true;
  if (/^data:image\/svg\+xml/i.test(t)) return true;
  return /\.svg(\?|#|$)/i.test(t);
}

function escAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Re-serialise a parsed subtree back to markup (used to hand an inline `<svg>`
 *  to `core/svg.ts`, which parses SVG itself). */
function serializeHNode(node: HNode): string {
  if (node.type === 'text') return escText(node.text);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${node.children.map(serializeHNode).join('')}</${node.tag}>`;
}

function svgFromElement(el: HElement, style: IrBox): SvgBlock {
  const s = { ...(style as Record<string, unknown>) };
  delete s.display; // flex carry-over, not a valid SVG-block prop
  const block: SvgBlock = { type: 'svg', src: serializeHNode(el), ...(s as Partial<SvgBlock>) };
  if (block.width === undefined && el.attrs['width'] !== undefined) block.width = `${el.attrs['width']}px`;
  if (block.height === undefined && el.attrs['height'] !== undefined) block.height = `${el.attrs['height']}px`;
  if (el.attrs['alt'] !== undefined) block.alt = el.attrs['alt'];
  return block;
}

function flexItemFromStyle(itemStyle: IrBox, b: Block): FlexItem {
  const s = itemStyle as Record<string, unknown>;
  const item: FlexItem = { block: b };
  if (typeof s.grow === 'number') item.grow = s.grow;
  if (typeof s.shrink === 'number') item.shrink = s.shrink;
  if (s.basis !== undefined) item.basis = s.basis as number | string;
  if (s.alignSelf !== undefined) item.alignSelf = s.alignSelf as FlexItem['alignSelf'];
  if (s.width !== undefined) item.width = s.width as number | string;
  if (s.height !== undefined) item.height = s.height as number | string;
  if (s.backgroundColor !== undefined) item.backgroundColor = s.backgroundColor as FlexItem['backgroundColor'];
  return item;
}

function flexFromElement(el: HElement, opts: HtmlOptions, style: IrBox): FlexBlock {
  const s = { ...(style as Record<string, unknown>) };
  delete s.display;
  const block: FlexBlock = { type: 'flex', children: [], ...(s as Partial<FlexBlock>) };

  const children: FlexItem[] = [];
  let textRun: HNode[] = [];
  const flushText = (): void => {
    if (textRun.length === 0) return;
    const pseudo: HElement = { type: 'element', tag: 'span', attrs: {}, children: textRun };
    const content = inlineContent(pseudo, opts, {} as IrBox);
    const nonEmpty = typeof content === 'string' ? content.trim().length > 0 : Array.isArray(content) ? content.length > 0 : true;
    if (nonEmpty) children.push({ block: { type: 'paragraph', content } as Block });
    textRun = [];
  };

  for (const node of el.children) {
    if (node.type === 'text') {
      if (/\S/.test(node.text)) textRun.push(node);
      continue;
    }
    flushText();
    const built = elToBlock(node, opts);
    if (built.length === 0) continue;
    // A child that yields several blocks becomes a vertical (column) flex, so it
    // still occupies exactly one flex item, as CSS would wrap it.
    const b = built.length === 1 ? built[0]! : ({ type: 'flex', direction: 'column', children: built.map((bb) => ({ block: bb })) } as Block);
    children.push(flexItemFromStyle(elementStyle(node, opts), b));
  }
  flushText();

  block.children = children;
  return block;
}

function elToBlock(el: HElement, opts: HtmlOptions): Block[] {
  const blocks = elToBlockCore(el, opts);
  // Conditional formatting works on any block carrier (`data-if` / `data-when`).
  const visible = visibleAttr(el);
  const conditions = styleWhenAttr(el);
  if (visible === undefined && !conditions) return blocks;
  for (const block of blocks) {
    if (visible !== undefined) block.visible = visible;
    if (conditions) block.styleWhen = conditions;
  }
  return blocks;
}

function elToBlockCore(el: HElement, opts: HtmlOptions): Block[] {
  // Non-visual head/stylesheet elements never become report content.
  if (el.tag === 'style' || el.tag === 'script' || el.tag === 'link' || el.tag === 'meta' || el.tag === 'title') return [];
  const style = elementStyle(el, opts);
  const id = el.attrs['id'];
  const withId = <T extends Block>(block: T): T => {
    if (id && block.id === undefined) block.id = id;
    return block;
  };

  if (el.tag === 'hr') {
    return [withId({ type: 'spacer', size: 6, ...style } as Block)];
  }
  if (el.attrs['data-toc'] !== undefined) return [withId(tocFromElement(el, style))];
  if (el.attrs['data-barcode'] !== undefined) return [withId(barcodeFromElement(el, style))];
  if (el.attrs['data-chart'] !== undefined && el.tag !== 'table') return [withId(chartFromElement(el, style))];

  const heading = /^h([1-6])$/.exec(el.tag);
  if (heading) {
    return [withId({ type: 'heading', level: Number(heading[1]), content: leafContent(el, opts, style), ...style } as Block)];
  }
  if (el.tag === 'table') {
    if (el.attrs['data-chart'] !== undefined) return [withId(chartFromTable(el, style))];
    return [withId(tableBlock(el, opts, style))];
  }
  if (el.tag === 'img') {
    const src = resolveImageSrc(el.attrs['src'] ?? '', opts);
    // A `.svg` / `data:image/svg+xml` / inline-SVG source renders as a vector
    // block instead of a raster image.
    if (isSvgSource(src)) {
      const svgBlock: Record<string, unknown> = { type: 'svg', src, ...style };
      if (svgBlock.width === undefined && el.attrs['width'] !== undefined) svgBlock.width = `${el.attrs['width']}px`;
      if (svgBlock.height === undefined && el.attrs['height'] !== undefined) svgBlock.height = `${el.attrs['height']}px`;
      if (el.attrs['alt'] !== undefined) svgBlock.alt = el.attrs['alt'];
      return [withId(svgBlock as unknown as Block)];
    }
    const block: Record<string, unknown> = { type: 'image', src, ...style };
    // `width`/`height` HTML attributes are CSS pixels; honour them when inline
    // style did not already set a size. Omitting one lets layout infer it from
    // the image's intrinsic aspect ratio.
    if (block.width === undefined && el.attrs['width'] !== undefined) block.width = `${el.attrs['width']}px`;
    if (block.height === undefined && el.attrs['height'] !== undefined) block.height = `${el.attrs['height']}px`;
    if (el.attrs['alt'] !== undefined) block.alt = el.attrs['alt'];
    return [withId(block as unknown as Block)];
  }

  if (el.tag === 'svg') {
    return [withId(svgFromElement(el, style))];
  }

  // A `display: flex` container becomes a single atomic flex block whose children
  // are ordinary blocks wrapped as flex items.
  if ((style as { display?: string }).display === 'flex') {
    return [withId(flexFromElement(el, opts, style))];
  }

  const blockChildren = el.children.filter(isBlock);
  if (blockChildren.length > 0) {
    const nested: Block[] = [];
    for (const c of el.children) {
      if (c.type === 'element' && isBlock(c)) nested.push(...elToBlock(c, opts));
      else if (c.type === 'text' && /\S/.test(c.text)) nested.push({ type: 'paragraph', content: textToContent(c.text, style), ...style } as Block);
    }
    // A wrapper with an id anchors its first real block.
    if (id && nested.length > 0 && nested[0]!.id === undefined) nested[0]!.id = id;
    return nested;
  }
  if (el.tag === 'li') {
    const content = inlineContent(el, opts, style);
    const bullet = Array.isArray(content) ? ['\u2022 ', ...content] : ['\u2022 ', content];
    return [withId({ type: 'paragraph', content: bullet, ...style, marginLeft: (style.marginLeft ?? 0) + 12 } as Block)];
  }
  return [withId({ type: 'paragraph', content: leafContent(el, opts, style), ...style } as Block)];
}

function rowsOf(el: HElement): HElement[] {
  return el.children.filter((c): c is HElement => c.type === 'element' && c.tag === 'tr');
}
function cellsOf(tr: HElement): HElement[] {
  return tr.children.filter((c): c is HElement => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'));
}

/** `data-if` on a table row/cell -> declarative conditional visibility. */
function visibleAttr(el: HElement): boolean | { expr: string } | undefined {
  const raw = el.attrs['data-if'];
  if (raw === undefined) return undefined;
  const source = exprSource(raw);
  if (source === undefined) return undefined;
  if (source === 'true' || source === 'false') return source === 'true';
  return { expr: source };
}

/** `data-when` + `data-when-style` -> one declarative conditional style rule. */
function styleWhenAttr(el: HElement): StyleCondition[] | undefined {
  const when = el.attrs['data-when'];
  if (when === undefined) return undefined;
  const source = exprSource(when);
  if (source === undefined) return undefined;
  return [{ when: { expr: source }, style: cssToIr(el.attrs['data-when-style'] ?? '', []) as Partial<BoxProps> }];
}

/**
 * `data-color-scale="min=0;max=100;from=#eef4ff;to=#1e3a8a;text=false"`.
 * Omitted `min`/`max` are derived from the column's data.
 */
function colorScaleAttr(el: HElement): ColorScale | undefined {
  const raw = el.attrs['data-color-scale'];
  if (raw === undefined) return undefined;
  const scale: ColorScale = {};
  for (const part of raw.split(/[;,]/)) {
    const [key, ...rest] = part.split('=');
    const k = (key ?? '').trim().toLowerCase();
    const v = rest.join('=').trim();
    if (!k || v === '') continue;
    if (k === 'min' || k === 'max') {
      const n = Number(v);
      if (Number.isFinite(n)) scale[k] = n;
    } else if (k === 'from' || k === 'to') {
      scale[k] = v;
    } else if (k === 'text') {
      scale.text = !/^(false|0|no|off)$/i.test(v);
    }
  }
  return scale;
}

/**
 * Rich cells: a `<td>` holding block-level children (`<img>`, a nested table,
 * `<p>`, a chart carrier, …) becomes a block stack; everything else stays inline.
 */
function cellBlocks(td: HElement, opts: HtmlOptions): Block[] {
  const hasBlock = td.children.some((c) => c.type === 'element' && isBlock(c));
  if (!hasBlock) return [];
  const out: Block[] = [];
  let inline: HNode[] = [];
  const flush = (): void => {
    if (inline.length === 0) return;
    // Reuse the normal paragraph path so inline formatting survives.
    const wrapper: HElement = { type: 'element', tag: 'p', attrs: {}, children: inline };
    out.push(...elToBlock(wrapper, opts));
    inline = [];
  };
  for (const child of td.children) {
    if (child.type === 'element' && isBlock(child)) {
      flush();
      out.push(...elToBlock(child, opts));
    } else {
      inline.push(child);
    }
  }
  flush();
  return out;
}

function toCellNode(td: HElement, opts: HtmlOptions): CellNode {
  const style = elementStyle(td, opts);
  const cell: CellNode = {};
  const blocks = cellBlocks(td, opts);
  if (td.attrs['data-bind'] !== undefined) cell.content = [{ bind: exprSource(td.attrs['data-bind']), format: td.attrs['data-format'] }];
  else if (blocks.length > 0) cell.blocks = blocks;
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
  // Match the browser: a `<th>` is centred unless the author aligned it. This is
  // a cell-level default only, so it never leaks into the column's data cells.
  if (cell.align === undefined && td.tag === 'th') cell.align = 'center';
  // Likewise the browser vertically centres table-cell content. Default `<th>` to
  // middle so a header row made tall by one busy cell (e.g. a diagonal corner
  // header) keeps its other labels centred rather than pinned to the top edge.
  if (cell.verticalAlign === undefined && td.tag === 'th') cell.verticalAlign = 'middle';
  // Conditional formatting surface: visibility, conditional styles, heatmaps.
  const visible = visibleAttr(td);
  if (visible !== undefined) cell.visible = visible;
  const conditions = styleWhenAttr(td);
  if (conditions) cell.styleWhen = conditions;
  const scale = colorScaleAttr(td);
  if (scale) cell.colorScale = scale;
  // Diagonal split header: `data-diagonal` turns the cell into a corner cell
  // with a slash; `data-diagonal-top`/`-bottom` name the two axes (the top one
  // defaults to the cell's own text), `data-diagonal="tr"` flips the slash.
  const diag = td.attrs['data-diagonal'];
  if (diag !== undefined) {
    const dirRaw = diag.trim().toLowerCase();
    const diagonal: DiagonalHeader = {
      dir: dirRaw === 'tr' || dirRaw === 'bl' || dirRaw === 'reverse' ? 'tr' : 'tl',
    };
    const top = td.attrs['data-diagonal-top'] ?? cell.content;
    const bottom = td.attrs['data-diagonal-bottom'];
    if (top !== undefined) diagonal.top = top as Content;
    if (bottom !== undefined) diagonal.bottom = bottom;
    if (td.attrs['data-diagonal-line'] !== undefined) diagonal.line = boolAttr(td, 'data-diagonal-line', true);
    cell.diagonal = diagonal;
    cell.content = undefined;
    cell.blocks = undefined;
  }
  return cell;
}

function toRowNode(tr: HElement, opts: HtmlOptions, kind: RowNode['kind']): RowNode {
  const row: RowNode = { kind, cells: cellsOf(tr).map((td) => toCellNode(td, opts)) };
  const visible = visibleAttr(tr);
  if (visible !== undefined) row.visible = visible;
  const conditions = styleWhenAttr(tr);
  if (conditions) row.styleWhen = conditions;
  return row;
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
      // Carry the template's row-level conditions onto the shared detail row.
      const detail = toRowNode(template, opts, 'detail');
      block.detail = { cells: detail.cells, visible: detail.visible, styleWhen: detail.styleWhen };
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
  /** Base directory used to resolve relative `<img src>` paths (e.g. the HTML file's folder). */
  baseDir?: string;
  /**
   * Page geometry. Wins over any `@page` rule / `<meta name="pdf-page">` found in the
   * HTML, so a JS caller can always override what the document declares.
   */
  page?: PageSpec;
  info?: ReportDoc['info'];
  /** @internal Stylesheet declarations precomputed for every element. */
  _selectorStyles?: WeakMap<HElement, IrBox>;
}

/** Absolute filesystem path? (POSIX `/…`, Windows `C:\…` / `C:/…`). */
function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
}

/**
 * Join a base directory and a relative image path without depending on `node:path`
 * (so this module bundles for the browser). Handles POSIX, Windows, and URL bases
 * and collapses `.`/`..` segments.
 */
function joinPath(base: string, rel: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rel)) return rel; // absolute URL always wins
  const isUrlBase = /^[a-z][a-z0-9+.-]*:\/\//i.test(base);
  const win = !isUrlBase && base.includes('\\') && !base.includes('/');
  const sep = isUrlBase ? '/' : win ? '\\' : '/';
  if (!isUrlBase && (rel.startsWith('/') || rel.startsWith('\\'))) return rel;

  let prefix = '';
  let segs: string[];
  if (isUrlBase) {
    const m = /^([a-z][a-z0-9+.-]*\/\/[^/]+)(\/[^?#]*)?/i.exec(base);
    prefix = (m?.[1] ?? base) + '/';
    segs = (m?.[2] ?? '').split('/').filter(Boolean);
  } else {
    const root = /^([a-zA-Z]:)/.exec(base)?.[1];
    if (root) prefix = root + sep;
    else if (!win && base.startsWith('/')) prefix = '/';
    segs = base.replace(/^[a-zA-Z]:/, '').split(/[\\/]/).filter(Boolean);
  }

  const stack = [...segs];
  for (const raw of rel.split(/[\\/]/)) {
    if (!raw || raw === '.') continue;
    if (raw === '..') stack.pop();
    else stack.push(raw);
  }
  return prefix + stack.join(sep);
}

/** Resolve an `<img>` `src`: absolute paths, `data:` URIs and URLs pass through;
 *  relative paths are joined against `baseDir` when it is set. */
function resolveImageSrc(src: string, opts: HtmlOptions): string {
  if (!src || /^(data:|https?:|file:)/i.test(src) || isAbsolutePath(src)) return src;
  return opts.baseDir ? joinPath(opts.baseDir, src) : src;
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

/** CSS text inside a `<style>` element (its raw text children). */
function styleText(el: HElement): string {
  return el.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/**
 * Walk the whole document (head + body) collecting remote-font references the
 * renderer should resolve: Google Fonts `<link rel=stylesheet>` / `@import`,
 * and inline `@font-face` blocks. `@import`-ing a Google stylesheet is treated
 * exactly like the `<link>` form.
 */
function collectFontRefs(root: HElement): FontReference[] {
  const refs: FontReference[] = [];
  const seen = new Set<string>();
  const push = (ref: FontReference): void => {
    const k = JSON.stringify(ref);
    if (seen.has(k)) return;
    seen.add(k);
    refs.push(ref);
  };
  const isGoogle = (u: string): boolean => /fonts\.(?:googleapis|gstatic)\.com\//i.test(u);
  const walk = (el: HElement): void => {
    if (el.tag === 'link') {
      const rel = (el.attrs['rel'] ?? '').toLowerCase();
      const href = el.attrs['href'] ?? '';
      if (href && rel.includes('stylesheet') && isGoogle(href)) push({ type: 'google', url: href });
    }
    if (el.tag === 'style') {
      const css = styleText(el);
      const importRe = /@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\s*\)?/gi;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(css))) {
        const u = m[1];
        if (u && isGoogle(u)) push({ type: 'google', url: u });
      }
      if (/@font-face/i.test(css)) push({ type: 'font-face', css });
    }
    for (const c of el.children) if (c.type === 'element') walk(c);
  };
  walk(root);
  return refs;
}

/** Elements tagged `data-band="..."` become repeated page bands, not body flow. */
const BAND_TYPES = new Set<BandType>(['pageHeader', 'pageFooter', 'title', 'summary', 'background']);

/** Turn a band element into `BandContent` (its inline content + optional height). */
function bandContent(el: HElement, opts: HtmlOptions): BandContent {
  const style = elementStyle(el, opts);
  const band: BandContent = { blocks: elToBlock(el, opts) };
  if (style.height !== undefined) band.height = toPt(style.height);
  // Band-level style (notably `opacity`) inherits into every block and lets the
  // pagination engine paint the whole band translucently.
  if (Object.keys(style).length > 0) band.style = style as Partial<StyleProps>;
  return band;
}

// --- page geometry: `@page` rule + `<meta name="pdf-page">` ----------------

const LENGTH_TOKEN = /^[0-9]*\.?[0-9]+(pt|mm|cm|in|px|%)?$/i;
const IGNORED_PAGE_KEYWORDS = /^(auto|inherit|initial|unset)$/i;

type PagePairs = Array<[string, string]>;

// Split a declaration body (`a: b; c: d`) on `;` then the first `:`.
function cssPairs(body: string): PagePairs {
  return body
    .split(';')
    .map((seg) => {
      const i = seg.indexOf(':');
      return i < 0 ? ([seg, ''] as [string, string]) : ([seg.slice(0, i), seg.slice(i + 1)] as [string, string]);
    });
}

// Split a meta `content` (`size=letter; margin=0.5in`) on `;`/`,`/newline then `=` or `:`.
function attrPairs(content: string): PagePairs {
  return content
    .split(/[;,\n]+/)
    .map((seg) => {
      const i = seg.search(/[=:]/);
      return i < 0 ? ([seg, ''] as [string, string]) : ([seg.slice(0, i), seg.slice(i + 1)] as [string, string]);
    });
}

function applySize(target: PageSpec, value: string): void {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  let orientation: 'portrait' | 'landscape' | undefined;
  let name: string | undefined;
  const dims: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (lower === 'landscape' || lower === 'portrait') orientation = lower;
    else if (IGNORED_PAGE_KEYWORDS.test(lower)) continue;
    else if (LENGTH_TOKEN.test(t)) dims.push(t);
    else name = lower;
  }
  if (dims.length >= 2) target.size = [dims[0]!, dims[1]!];
  else if (name) target.size = name;
  if (orientation) target.orientation = orientation;
}

// Normalize a CSS margin shorthand (1..4 values) to a `[top, right, bottom, left]`
// tuple in the order `resolveMargins` expects (avoiding its 3-value ambiguity).
function applyMargin(target: PageSpec, value: string): void {
  const parts = value.trim().split(/\s+/).filter((p) => p && !IGNORED_PAGE_KEYWORDS.test(p));
  if (parts.length === 0) return;
  let top: string, right: string, bottom: string, left: string;
  if (parts.length === 1) [top, right, bottom, left] = [parts[0]!, parts[0]!, parts[0]!, parts[0]!];
  else if (parts.length === 2) [top, right, bottom, left] = [parts[0]!, parts[1]!, parts[0]!, parts[1]!];
  else if (parts.length === 3) [top, right, bottom, left] = [parts[0]!, parts[1]!, parts[2]!, parts[1]!];
  else [top, right, bottom, left] = [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  target.margin = [top, right, bottom, left];
}

function applyPagePairs(target: PageSpec, pairs: PagePairs): void {
  for (const [rawKey, rawVal] of pairs) {
    const key = rawKey.trim().toLowerCase();
    const val = rawVal.trim();
    if (!key || !val) continue;
    if (key === 'size') applySize(target, val);
    else if (key === 'margin') applyMargin(target, val);
    else if (key === 'orientation') {
      const l = val.toLowerCase();
      if (l === 'portrait' || l === 'landscape') target.orientation = l;
    }
  }
}

function findMetaPages(root: HElement): PagePairs[] {
  const out: PagePairs[] = [];
  const walk = (el: HElement): void => {
    for (const c of el.children) {
      if (c.type === 'element') {
        if (c.tag === 'meta' && (c.attrs['name'] ?? '').toLowerCase() === 'pdf-page') {
          out.push(attrPairs(c.attrs['content'] ?? ''));
        }
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

/** Build a `PageSpec` from the document's `<meta name="pdf-page">` and `@page` rules. */
function pageSpecFromHtml(html: string, root: HElement): PageSpec {
  const spec: PageSpec = {};
  // Meta provides defaults; a `@page` block (later in the cascade) overrides it.
  for (const pairs of findMetaPages(root)) applyPagePairs(spec, pairs);
  const rule = /@page[^{]*\{([^}]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(html)) !== null) applyPagePairs(spec, cssPairs(m[1] ?? ''));
  return spec;
}

function pickDefined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Record<string, unknown> = {};
  if (obj) for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** CSS text from every `<style>` element, concatenated in document order. */
function collectStyleText(root: HElement): string {
  let css = '';
  const walk = (el: HElement): void => {
    if (el.tag === 'style') {
      css += `\n${styleText(el)}`;
      return;
    }
    for (const c of el.children) if (c.type === 'element') walk(c);
  };
  walk(root);
  return css;
}

/** Convert constrained authoring HTML into the report IR. */
export function htmlToReportDoc(html: string, opts: HtmlOptions = {}): ReportDoc {
  const tree = parseHtml(html);
  // Resolve the `<style>` cascade once, up front: every later conversion reads
  // the precomputed match for its element instead of re-walking ancestors.
  const rules = parseStyleSheet(collectStyleText(tree));
  const effective: HtmlOptions = rules.length > 0 ? { ...opts, _selectorStyles: computeMatchedStyles(tree, rules) } : opts;
  const body = findFirst(tree, 'body') ?? tree;
  const reportStyle = elementStyle(body, effective) as Partial<StyleProps>;

  const blocks: Block[] = [];
  const bands: Partial<Record<BandType, BandContent>> = {};
  for (const child of body.children) {
    if (child.type === 'text') {
      if (/\S/.test(child.text)) blocks.push({ type: 'paragraph', content: textToContent(child.text.trim(), undefined) } as Block);
      continue;
    }
    if (child.tag === 'style' || child.tag === 'script' || child.tag === 'link' || child.tag === 'meta' || child.tag === 'title') continue;
    const bandName = child.attrs['data-band'] as BandType | undefined;
    if (bandName && BAND_TYPES.has(bandName)) {
      bands[bandName] = bandContent(child, effective);
      continue;
    }
    blocks.push(...elToBlock(child, effective));
  }

  const htmlPage = pageSpecFromHtml(html, tree);
  const page = { ...htmlPage, ...pickDefined(opts.page) };
  const hasPage = Object.keys(page).length > 0;
  const fonts = collectFontRefs(tree);

  return {
    info: opts.info,
    data: opts.data,
    style: { ...opts.style, ...reportStyle },
    ...(hasPage ? { page } : {}),
    ...(Object.keys(bands).length ? { bands } : {}),
    body: blocks,
    ...(fonts.length ? { fonts } : {}),
  };
}
