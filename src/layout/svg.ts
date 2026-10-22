/**
 * SVG (vector image) layout.
 *
 * `core/svg.ts` already reduced the markup to styled polygons in the viewBox's
 * own coordinate space; here we resolve a display size exactly like a raster
 * {@link ImageBlock} (explicit `width`/`height`, else the intrinsic aspect ratio,
 * capped to the content width), scale the geometry into points and emit the
 * engine's `path` draw commands. Everything is baked into absolute coordinates
 * (offset by the aligned x), so the writer is a dumb painter and the block stays
 * one atomic fragment.
 */
import type { SvgBlock } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import { toPt } from '../core/units.js';
import { pxToPt } from '../core/image.js';
import { svgSourceToText, parseSvg } from '../core/svg.js';
import type { LayoutContext } from './context.js';
import type { BlockLayoutOptions } from './block.js';
import { resolveBox } from './box.js';
import type { DrawCommand, Fragment, PolyPoint } from './flow.js';

export function layoutSvg(
  block: SvgBlock,
  _ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
): Fragment[] {
  const { margin, padding } = resolveBox(block);
  const contentW = Math.max(1, opts.contentWidth - margin.left - margin.right - padding.left - padding.right);

  const text = svgSourceToText(block.src);
  const tree = text ? parseSvg(text) : null;
  if (!tree || tree.width <= 0 || tree.height <= 0) {
    return [{ height: 0, before: margin.top, after: margin.bottom, commands: [], avoidSplit: true }];
  }

  // Intrinsic size: an explicit `intrinsic`, else the viewBox/attr size.
  const intrinsic = block.intrinsic ?? { width: tree.width, height: tree.height };
  const ratio = intrinsic.height > 0 ? intrinsic.width / intrinsic.height : undefined;
  const intrinsicW = pxToPt(intrinsic.width);
  const intrinsicH = pxToPt(intrinsic.height);

  const declaredW = block.width !== undefined ? toPt(block.width) : undefined;
  const declaredH = block.height !== undefined ? toPt(block.height) : undefined;

  let w: number;
  let h: number;
  if (declaredW !== undefined && declaredH !== undefined) {
    w = declaredW;
    h = declaredH;
  } else if (declaredW !== undefined) {
    w = declaredW;
    h = ratio ? declaredW / ratio : intrinsicH;
  } else if (declaredH !== undefined) {
    h = declaredH;
    w = ratio ? declaredH * ratio : intrinsicW;
  } else {
    w = Math.min(intrinsicW, contentW);
    h = ratio ? w / ratio : intrinsicH;
  }
  if (w > contentW) {
    h = (h * contentW) / w;
    w = contentW;
  }
  w = Math.max(1, w);
  h = Math.max(1, h);

  const align = block.align ?? inherited.align ?? 'left';
  const ox = margin.left + padding.left + (align === 'center' ? (contentW - w) / 2 : align === 'right' ? contentW - w : 0);
  const oy = padding.top;

  // viewBox units → points. Aspect is preserved above, so sx ≈ sy.
  const sx = w / tree.width;
  const sy = h / tree.height;

  const commands: DrawCommand[] = [];
  for (const shape of tree.shapes) {
    commands.push({
      op: 'path',
      subpaths: shape.subpaths.map((sp) => ({
        closed: sp.closed,
        points: sp.points.map((p) => [ox + (p[0] ?? 0) * sx, oy + (p[1] ?? 0) * sy] as PolyPoint),
      })),
      fill: shape.fill?.color,
      fillOpacity: shape.fill?.opacity,
      fillRule: shape.fill?.rule,
      stroke: shape.stroke
        ? { color: shape.stroke.color, lineWidth: Math.max(0.2, shape.stroke.width * sx), dash: shape.stroke.dash?.map((d) => d * sx) }
        : undefined,
    });
  }

  return [
    {
      height: h + padding.top + padding.bottom,
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
