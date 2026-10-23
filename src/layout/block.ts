/**
 * Block layout: turn a flow `Block` into a list of `Fragment`s sized for a given
 * content width. No page decisions are made here — that is the pagination
 * engine's job — so every block is laid out as if it had infinite vertical room.
 *
 * A paragraph becomes one fragment per typeset line so that long prose can flow
 * across pages; margins/padding/borders are baked into fragment-local command
 * coordinates (origin = content-area left edge), which keeps the writer a dumb
 * translate-and-paint executor.
 */
import type {
  Block,
  BoxProps,
  StyleProps,
  ParagraphBlock,
  HeadingBlock,
  SpacerBlock,
  ImageBlock,
  Content,
} from '../ir/schema.js';
import type { ExprContext } from '../expr/eval.js';
import { toPt } from '../core/units.js';
import { toRGB } from '../core/color.js';
import { probeImageSize, pxToPt } from '../core/image.js';
import { resolveContent, type LayoutContext } from './context.js';
import { typeset, type Line } from '../text/typeset.js';
import type { ResolvedStyle } from '../text/style.js';
import { resolveBox, resolveBorders, resolveRadius, resolveShadow, resolveGradient, borderRGB, borderDash, type EdgeInsets } from './box.js';
import type { Fragment, DrawCommand, OutlineEntry, Radius, ResolvedGradient, ResolvedShadow } from './flow.js';
import { applyConditions, isVisible } from './condition.js';
// `block <-> table` is a genuine cycle (a table lays out cell paragraphs via this
// module, and this module dispatches table blocks to the table layout). Both sides
// only *call* the imported function at runtime, and ESM function declarations are
// hoisted, so the cycle resolves correctly without a registration dance.
import { layoutTable } from './table.js';
import { layoutChart } from './chart.js';
import { layoutToc } from './toc.js';
import { layoutBarcode } from './barcode.js';
import { layoutSvg } from './svg.js';
import { layoutFlex } from './flex.js';
import { layoutColumns } from './column.js';

export interface BlockLayoutOptions {
  /** Horizontal origin of the content area within the page (usually 0 here). */
  contentWidth: number;
  scope: ExprContext;
  inherited?: ResolvedStyle;
}

export function layoutBlock(block: Block, ctx: LayoutContext, opts: BlockLayoutOptions): Fragment[] {
  const inherited = opts.inherited ?? ctx.baseStyle;
  // Conditional formatting is resolved before dispatch, so every block kind sees
  // the same visible/styleWhen semantics (a hidden block emits no fragment).
  if (!isVisible(block.visible, ctx, opts.scope)) return [];
  const effective: Block = block.styleWhen?.length
    ? (applyConditions(block, block.styleWhen, ctx, opts.scope) as Block)
    : block;
  let frags: Fragment[];
  switch (effective.type) {
    case 'paragraph':
      frags = layoutTextBlock(effective, ctx, opts, inherited);
      break;
    case 'heading':
      frags = layoutHeading(effective, ctx, opts, inherited);
      break;
    case 'spacer':
      frags = layoutSpacer(effective, ctx, opts, inherited);
      break;
    case 'image':
      frags = layoutImage(effective, ctx, opts, inherited);
      break;
    case 'svg':
      frags = layoutSvg(effective, ctx, opts, inherited);
      break;
    case 'flex':
      frags = layoutFlex(effective, ctx, opts, inherited);
      break;
    case 'columns':
      frags = layoutColumns(effective, ctx, opts, inherited);
      break;
    case 'pageBreak':
      frags = [{ height: 0, before: 0, after: 0, commands: [], isPageBreak: true, breakBefore: 'page' }];
      break;
    case 'table':
      frags = layoutTable(effective, ctx, opts, inherited);
      break;
    case 'chart':
      frags = layoutChart(effective, ctx, opts, inherited);
      break;
    case 'toc':
      frags = layoutToc(effective, ctx, opts, inherited);
      break;
    case 'barcode':
      frags = layoutBarcode(effective, ctx, opts, inherited);
      break;
    default:
      frags = [];
  }
  // `breakInside: 'avoid'` (CSS `page-break-inside: avoid`) keeps the block on one
  // page. A paragraph becomes one fragment per line, so the cheapest faithful
  // implementation is to chain its fragments: pagination moves a keep-with-next run
  // as a unit, which is exactly the machinery table rows already rely on.
  if (effective.breakInside === 'avoid') {
    for (let i = 0; i < frags.length - 1; i += 1) frags[i]!.keepWithNext = true;
  }
  // Any block with an `id` defines a named destination at its first fragment,
  // which is what `#id` links resolve against.
  if (effective.id && frags.length && !frags[0]!.anchor) frags[0]!.anchor = effective.id;
  return frags;
}

const HEADING_SCALE = [2, 1.6, 1.4, 1.2, 1.1, 1];

function layoutHeading(block: HeadingBlock, ctx: LayoutContext, opts: BlockLayoutOptions, inherited: ResolvedStyle): Fragment[] {
  const level = Math.min(Math.max(block.level ?? 1, 1), 6);
  const scale = HEADING_SCALE[level - 1]!;
  const headingProps: Partial<BoxProps> = {
    fontSize: Math.round(inherited.fontSize * scale * 100) / 100,
    fontWeight: 'bold',
    marginTop: inherited.fontSize * 0.9,
    marginBottom: inherited.fontSize * 0.4,
    align: block.align ?? 'left',
  };
  const merged: BoxProps = { ...headingProps, ...block };
  const style = ctx.style(merged, inherited);
  let outline: OutlineEntry | undefined;
  if (block.outline !== false) {
    outline = {
      level: block.outline?.level ?? level,
      title: '',
      anchor: block.id,
      numbering: block.outline?.numbering,
    };
  }
  return layoutParagraphCore(block.content, block, style, ctx, opts, inherited, outline);
}

function layoutTextBlock(block: ParagraphBlock, ctx: LayoutContext, opts: BlockLayoutOptions, inherited: ResolvedStyle): Fragment[] {
  const style = ctx.style(block as StyleProps, inherited);
  return layoutParagraphCore(block.content, block, style, ctx, opts, inherited);
}

export function layoutParagraphCore(
  content: Content,
  box: BoxProps,
  style: ResolvedStyle,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
  outline?: OutlineEntry,
): Fragment[] {
  const { margin, padding } = resolveBox(box);
  const borders = resolveBorders(box);
  const innerWidth = Math.max(1, opts.contentWidth - margin.left - margin.right - padding.left - padding.right);
  const inline = resolveContent(content, ctx, style, opts.scope);
  if (inline.length === 0) {
    return emptyFragment(style, margin, padding, opts.contentWidth);
  }
  const result = typeset(inline, innerWidth);
  const frags = fragmentsFromLines(result.lines, {
    style,
    margin,
    padding,
    borders,
    contentWidth: opts.contentWidth,
    breakBefore: box.breakBefore,
    breakAfter: box.breakAfter,
    keepWithNext: box.keepWithNext,
    fill: style.backgroundColor,
    fillOffsetLeft: margin.left,
    radius: resolveRadius(box),
    gradient: resolveGradient(box),
    shadow: resolveShadow(box),
  });
  // Reconstruct the rendered title from the typeset lines: bindings have been
  // evaluated and `text-transform` applied, so bookmarks match what the page shows.
  if (outline && frags.length) {
    const title = result.lines
      .map((l) => l.runs.map((r) => r.text).join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (title) frags[0]!.outline = { ...outline, title };
  }
  return frags;
}

export interface FragParams {
  style: ResolvedStyle;
  margin: EdgeInsets;
  padding: EdgeInsets;
  borders: ReturnType<typeof resolveBorders>;
  contentWidth: number;
  breakBefore?: 'auto' | 'page' | 'avoid';
  breakAfter?: 'auto' | 'page' | 'avoid';
  keepWithNext?: boolean;
  fill?: ResolvedStyle['backgroundColor'];
  fillOffsetLeft: number;
  /** Optional per-line x shift already applied to run.x (used by table cells). */
  borderMode?: 'block' | 'cell';
  /** Corner rounding for the background box (CSS order). Applied to outer edges only. */
  radius?: Radius;
  /** Two-stop gradient painted instead of the flat `fill`. */
  gradient?: Omit<ResolvedGradient, 'boxTop' | 'boxHeight'>;
  /** Drop shadow drawn behind the background box. */
  shadow?: ResolvedShadow;
}

/** Convert typeset lines into per-line fragments with backgrounds and borders baked in. */
export function fragmentsFromLines(lines: Line[], p: FragParams): Fragment[] {
  const boxX = p.fillOffsetLeft;
  const boxW = p.contentWidth - p.margin.left - p.margin.right;
  const first = 0;
  const last = lines.length - 1;
  const frags: Fragment[] = [];
  // The background box is painted as one `fillRect` per line (so it can split
  // across pages); the gradient and corner rounding need the *whole* box's
  // height and each slice's offset to stay continuous across the stack.
  const boxHeight = lines.reduce((sum, l) => sum + l.height, 0);
  let boxTop = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const commands: DrawCommand[] = [];
    const height = line.height;

    if (p.fill !== undefined || p.gradient) {
      const cmd: DrawCommand = {
        op: 'fillRect',
        x: boxX,
        y: 0,
        w: boxW,
        h: height,
        color: p.fill !== undefined ? toRGB(p.fill) : [0, 0, 0],
      };
      if (p.radius) cmd.radius = outerCorners(p.radius, i === first, i === last);
      if (p.gradient) cmd.gradient = { ...p.gradient, boxTop, boxHeight };
      // Draw the drop shadow exactly once, as the whole box's silhouette, on the
      // first line's rect. Painting it per line would stack the blurred layers of
      // adjacent lines and band the side shadows. The later lines' fills land on
      // top of it, so only the soft outer halo stays visible.
      if (p.shadow && i === first) {
        cmd.shadow = p.shadow;
        cmd.shadowH = boxHeight;
        if (p.radius) cmd.shadowRadius = p.radius;
      }
      commands.push(cmd);
    }

    const textX = boxX + p.padding.left;
    commands.push({
      op: 'text',
      x: textX,
      baselineY: line.ascent,
      runs: line.runs,
      gapWidth: line.gapWidth,
      decorations: [],
    });

    drawBorders(commands, p.borders, boxX, 0, boxW, height, i === first, i === last, p.borderMode === 'cell');

    frags.push({
      height,
      before: i === first ? p.margin.top + p.padding.top : 0,
      after: i === last ? p.margin.bottom + p.padding.bottom : 0,
      commands,
      breakBefore: i === first ? p.breakBefore : undefined,
      breakAfter: i === last ? p.breakAfter : undefined,
      keepWithNext: i === last ? p.keepWithNext : false,
    });
    boxTop += height;
  }
  return frags;
}

/**
 * Keep only the corners that touch the box's outer edge: top corners round on
 * the first line, bottom corners on the last, all four when the box is a single
 * line. The straight left/right edges make interior rounding invisible anyway.
 */
function outerCorners(radius: Radius, isFirst: boolean, isLast: boolean): Radius {
  const [tl, tr, br, bl] = radius;
  return [isFirst ? tl : 0, isFirst ? tr : 0, isLast ? br : 0, isLast ? bl : 0];
}

function drawBorders(
  commands: DrawCommand[],
  borders: ReturnType<typeof resolveBorders>,
  x: number,
  y: number,
  w: number,
  h: number,
  top: boolean,
  bottom: boolean,
  cell: boolean,
): void {
  const line = (x1: number, y1: number, x2: number, y2: number, b: NonNullable<ReturnType<typeof resolveBorders>['top']>) =>
    commands.push({ op: 'line', x1, y1, x2, y2, color: borderRGB(b), lineWidth: b.width, dash: borderDash(b) });

  if (borders.top && (top || cell)) line(x, y + borders.top.width / 2, x + w, y + borders.top.width / 2, borders.top);
  if (borders.bottom && (bottom || cell)) line(x, y + h - borders.bottom.width / 2, x + w, y + h - borders.bottom.width / 2, borders.bottom);
  if (borders.left) line(x + borders.left.width / 2, y, x + borders.left.width / 2, y + h, borders.left);
  if (borders.right) line(x + w - borders.right.width / 2, y, x + w - borders.right.width / 2, y + h, borders.right);
}

function layoutSpacer(block: SpacerBlock, ctx: LayoutContext, opts: BlockLayoutOptions, inherited: ResolvedStyle): Fragment[] {
  const { margin } = resolveBox(block);
  const size = toPt(block.size ?? inherited.fontSize, 0);
  return [{ height: Math.max(0, size), before: margin.top, after: margin.bottom, commands: [] }];
}

/**
 * Lay out an image block: resolve display size (honouring explicit `width`/
 * `height`, then the intrinsic aspect ratio probed from the file header), align
 * it inside the content box, and reserve a single atomic fragment of that height.
 */
function layoutImage(block: ImageBlock, _ctx: LayoutContext, opts: BlockLayoutOptions, inherited: ResolvedStyle): Fragment[] {
  const { margin } = resolveBox(block);
  const contentW = Math.max(1, opts.contentWidth - margin.left - margin.right);

  const intrinsic = block.intrinsic ?? probeImageSize(block.src);
  const ratio = intrinsic && intrinsic.height > 0 ? intrinsic.width / intrinsic.height : undefined;
  const intrinsicW = intrinsic ? pxToPt(intrinsic.width) : undefined;
  const intrinsicH = intrinsic ? pxToPt(intrinsic.height) : undefined;

  const declaredW = block.width !== undefined ? toPt(block.width) : undefined;
  const declaredH = block.height !== undefined ? toPt(block.height) : undefined;

  let w: number;
  let h: number;
  if (declaredW !== undefined && declaredH !== undefined) {
    w = declaredW;
    h = declaredH;
  } else if (declaredW !== undefined) {
    w = declaredW;
    h = ratio ? declaredW / ratio : intrinsicH ?? declaredW;
  } else if (declaredH !== undefined) {
    h = declaredH;
    w = ratio ? declaredH * ratio : intrinsicW ?? declaredH;
  } else {
    w = Math.min(intrinsicW ?? contentW, contentW);
    h = ratio ? w / ratio : intrinsicH ?? w;
  }
  // Never let an image bleed past the content box.
  if (w > contentW) {
    h = (h * contentW) / w;
    w = contentW;
  }
  w = Math.max(1, w);
  h = Math.max(1, h);

  const align = block.align ?? inherited.align ?? 'left';
  const x = margin.left + (align === 'center' ? (contentW - w) / 2 : align === 'right' ? contentW - w : 0);

  const radius = resolveRadius(block);
  const shadow = resolveShadow(block);
  const imgCmd: DrawCommand = { op: 'image', x, y: 0, w, h, src: block.src };
  if (radius) (imgCmd as Extract<DrawCommand, { op: 'image' }>).radius = radius;
  if (shadow) (imgCmd as Extract<DrawCommand, { op: 'image' }>).shadow = shadow;
  const commands: DrawCommand[] = [imgCmd];
  const borders = resolveBorders(block);
  if (borders.top || borders.bottom || borders.left || borders.right) {
    drawBorders(commands, borders, x, 0, w, h, true, true, false);
  }

  return [
    {
      height: h,
      before: margin.top,
      after: margin.bottom,
      commands,
      avoidSplit: true,
      breakBefore: block.breakBefore,
      breakAfter: block.breakAfter,
      keepWithNext: block.keepWithNext,
    },
  ];
}

function emptyFragment(style: ResolvedStyle, margin: EdgeInsets, padding: EdgeInsets, contentWidth: number): Fragment[] {
  const height = style.lineHeight;
  return [
    {
      height,
      before: margin.top + padding.top,
      after: margin.bottom + padding.bottom,
      commands: style.backgroundColor
        ? [{ op: 'fillRect', x: margin.left, y: 0, w: contentWidth - margin.left - margin.right, h: height, color: toRGB(style.backgroundColor) }]
        : [],
    },
  ];
}
