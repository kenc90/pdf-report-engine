/**
 * Layout context: the ambient services every layout pass needs — the font
 * registry, the sandboxed expression compiler, report data, and the resolved
 * base style — plus the one piece of real logic that lives here: turning an IR
 * `Content` node into styled inline runs ready for `typeset`.
 *
 * Content resolution is where bindings are evaluated: a `ContentSpan` with a
 * `bind` is run through `ExprCompiler` against the current scope, formatted with
 * an optional pattern, then wrapped in a run carrying its own (merged) style.
 * Nested `children` allow rich text like "Total: **$1,234.00**".
 */
import type { Content, ContentSpan, StyleProps } from '../ir/schema.js';
import { ExprCompiler, exprSource, type ExprContext } from '../expr/eval.js';
import { createFunctions } from '../expr/functions.js';
import { formatNumber, formatDate } from '../expr/format.js';
import { getPath } from '../expr/functions.js';
import { FontRegistry } from '../fonts/registry.js';
import { resolveStyle, type ResolvedStyle } from '../text/style.js';
import type { InlineSource } from '../text/typeset.js';

export interface LayoutContextInit {
  registry: FontRegistry;
  baseStyle: ResolvedStyle;
  data?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  compiler?: ExprCompiler;
}

/** One row of a generated table of contents. */
export interface TocEntry {
  level: number;
  title: string;
  /** Logical page number the heading was placed on. */
  page: number;
  anchor?: string;
}

export class LayoutContext {
  readonly registry: FontRegistry;
  readonly baseStyle: ResolvedStyle;
  readonly compiler: ExprCompiler;
  readonly data: Record<string, unknown>;
  readonly vars: Record<string, unknown>;
  /**
   * Heading entries available to `toc` blocks. The renderer refreshes this
   * between fixed-point pagination passes; layout itself never mutates it.
   */
  tocEntries: TocEntry[] = [];

  constructor(init: LayoutContextInit) {
    this.registry = init.registry;
    this.baseStyle = init.baseStyle;
    this.data = init.data ?? {};
    this.vars = init.vars ?? {};
    this.compiler = init.compiler ?? new ExprCompiler(createFunctions());
  }

  /** Merge an author's `StyleProps` override into a resolved parent style. */
  style(props: Partial<StyleProps> | undefined, inherited: ResolvedStyle): ResolvedStyle {
    // Resolve straight from the (sparse) author override against the dense
    // parent. Do NOT merge the parent into the props first: that would leak the
    // parent's absolute `lineHeight` back in as if it were a fresh multiplier.
    return resolveStyle(props ?? {}, this.registry, inherited);
  }

  eval(expr: unknown, scope: ExprContext): unknown {
    return this.compiler.evaluate(expr, { $data: this.data, $vars: this.vars, ...scope });
  }

  resolve(value: unknown, format: string | undefined, scope: ExprContext): string {
    if (value === null || value === undefined) return '';
    if (format) return applyFormat(value, format);
    if (typeof value === 'number') return String(value);
    if (value instanceof Date) return formatDate(value, 'yyyy-MM-dd');
    return String(value);
  }
}

/**
 * Format a bound value with an ICU-ish pattern. A pattern with number glyphs
 * (`0 # . , %`) is treated as numeric, otherwise as a date pattern.
 */
export function applyFormat(value: unknown, pattern: string): string {
  const numeric = /[0#]/.test(pattern) || pattern.includes('%') || pattern.includes('‰');
  if (numeric) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return formatNumber(n, pattern).text;
  }
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') {
    try {
      return formatDate(value as Date | string | number, pattern);
    } catch {
      /* fall through to string */
    }
  }
  return String(value);
}

type ContentPiece = string | number | ContentSpan;

function isSpan(v: ContentPiece): v is ContentSpan {
  return typeof v === 'object' && v !== null;
}

/**
 * Flatten an IR `Content` node into `InlineSource[]`.
 * Strings/numbers become one run under the inherited style; spans recurse with a
 * merged style and may resolve a `bind` (data path or expression) instead of a
 * literal.
 */
export function resolveContent(
  content: Content | undefined,
  ctx: LayoutContext,
  inherited: ResolvedStyle,
  scope: ExprContext,
): InlineSource[] {
  const out: InlineSource[] = [];
  if (content === undefined || content === null) return out;
  const walk = (node: Content, style: ResolvedStyle): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node as Array<string | number | ContentSpan>) walkChild(child, style);
      return;
    }
    walkChild(node as string | number | ContentSpan, style);
  };
  const walkChild = (piece: string | number | ContentSpan, style: ResolvedStyle): void => {
    if (typeof piece === 'string' || typeof piece === 'number') {
      out.push({ text: String(piece), style });
      return;
    }
    if (!isSpan(piece)) return;
    const spanStyle = ctx.style(piece.style, style);
    if (piece.bind !== undefined) {
      const raw = resolveBind(piece.bind, ctx, scope);
      const source: InlineSource = { text: ctx.resolve(raw, piece.format, scope), style: spanStyle };
      if (piece.link) source.link = piece.link;
      out.push(source);
    } else if (piece.text !== undefined) {
      walkWithLink(piece.text, spanStyle, piece.link);
    } else if (piece.children !== undefined) {
      walkWithLink(piece.children, spanStyle, piece.link);
    }
  };

  /** Walk children and stamp a span-level link onto every produced inline. */
  const walkWithLink = (node: Content, style: ResolvedStyle, link: string | undefined): void => {
    if (!link) {
      walk(node, style);
      return;
    }
    const start = out.length;
    walk(node, style);
    for (let i = start; i < out.length; i += 1) out[i]!.link = link;
  };
  walk(content, inherited);
  return out;
}

function resolveBind(bind: string | { expr: string }, ctx: LayoutContext, scope: ExprContext): unknown {
  const source = exprSource(bind);
  if (source === undefined) return undefined;
  // A plain field path is cheaper and safer than compiling it as code.
  if (/^[$]?[\w.[\]]+$/.test(source) && !/[+\-*/?:()]/.test(source)) {
    const row = scope.$row;
    if (row && getPath(row, source) !== undefined) return getPath(row, source);
    if (getPath(ctx.data, source) !== undefined) return getPath(ctx.data, source);
  }
  return ctx.eval(source, scope);
}
