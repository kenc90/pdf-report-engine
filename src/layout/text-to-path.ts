/**
 * Text-to-path conversion: renders a string as filled vector outlines instead of
 * PDF text operators, making the result non-selectable. Uses fontkit's glyph path
 * API to extract outlines, then flattens quadratic/cubic bezier curves to polylines
 * (same adaptive-step approach as `core/svg.ts`).
 *
 * Falls back gracefully when the font handle has no real glyph data (e.g.
 * `HeuristicFontHandle` in tests): returns a `text` command so layout assertions
 * still work without a font binary on disk.
 */
import type { FontHandle } from '../fonts/registry.js';
import type { RGB } from '../core/color.js';
import type { DrawCommand, PolyPoint } from './flow.js';

/** Fontkit glyph path command shape (runtime, not in our public types). */
interface GlyphPathCmd {
  command: string;
  args: number[];
}
interface GlyphPath {
  commands: GlyphPathCmd[];
}
interface GlyphWithPath {
  id: number;
  advanceWidth: number;
  readonly path: GlyphPath;
}
interface LayoutResult {
  glyphs: GlyphWithPath[];
  positions: Array<{ xAdvance: number; yAdvance?: number; xOffset?: number; yOffset?: number }>;
}

// --- Curve flattening (mirrors core/svg.ts approach) -------------------------

/** Flatten a cubic bezier to a polyline. Adaptive step count based on control polygon length. */
function flattenCubic(p0: number[], p1: number[], p2: number[], p3: number[]): number[][] {
  const len =
    Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!) +
    Math.hypot(p2[0]! - p1[0]!, p2[1]! - p1[1]!) +
    Math.hypot(p3[0]! - p2[0]!, p3[1]! - p2[1]!);
  const steps = Math.max(4, Math.min(64, Math.round(len / 2)));
  const out: number[][] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    out.push([
      a * p0[0]! + b * p1[0]! + c * p2[0]! + d * p3[0]!,
      a * p0[1]! + b * p1[1]! + c * p2[1]! + d * p3[1]!,
    ]);
  }
  return out;
}

/** Convert a quadratic bezier to a cubic (for unified flattening). */
function quadToCubic(p0: number[], q: number[], p3: number[]): [number[], number[]] {
  const c1 = [p0[0]! + (2 / 3) * (q[0]! - p0[0]!), p0[1]! + (2 / 3) * (q[1]! - p0[1]!)];
  const c2 = [p3[0]! + (2 / 3) * (q[0]! - p3[0]!), p3[1]! + (2 / 3) * (q[1]! - p3[1]!)];
  return [c1, c2];
}

// --- Main API ----------------------------------------------------------------

/**
 * Convert a text string to filled vector `path` DrawCommands.
 *
 * @param handle  The font handle (must have a real `pdfFont` for path extraction).
 * @param text    The string to render.
 * @param fontSize  Size in points.
 * @param originX   Left edge of the text in page-space.
 * @param originY   Baseline y in page-space (PDF coords, Y-down).
 * @param color     Fill colour.
 * @param opacity   Optional fill opacity (0-1).
 * @returns An array of DrawCommands (typically one `path` command with all glyph subpaths).
 */
export function textToPathCommands(
  handle: FontHandle,
  text: string,
  fontSize: number,
  originX: number,
  originY: number,
  color: RGB,
  opacity?: number,
): DrawCommand[] {
  // If the handle lacks real fontkit data (e.g. HeuristicFontHandle in tests), we
  // cannot extract outlines. Return an empty array so the caller can decide on a
  // fallback (typically a `text` DrawCommand built from its own style context).
  const rawFont = handle.pdfFont?.font;
  if (!rawFont || typeof (rawFont as unknown as { layout?: unknown }).layout !== 'function') {
    return [];
  }

  const unitsPerEm: number = (rawFont as unknown as { unitsPerEm: number }).unitsPerEm || 2048;
  const scale = fontSize / unitsPerEm;

  const layoutResult = (rawFont as unknown as { layout(text: string): LayoutResult }).layout(text);
  const { glyphs, positions } = layoutResult;

  const subpaths: Array<{ points: PolyPoint[]; closed: boolean }> = [];
  let penX = 0; // accumulated advance in font units

  for (let gi = 0; gi < glyphs.length; gi += 1) {
    const glyph = glyphs[gi]!;
    const pos = positions[gi];
    const path = glyph.path;

    if (path && path.commands.length > 0) {
      // Walk path commands, building subpaths.
      let cur: number[][] = [];
      let cx = 0;
      let cy = 0;

      for (const cmd of path.commands) {
        switch (cmd.command) {
          case 'moveTo': {
            if (cur.length > 1) subpaths.push({ points: toPagePoints(cur, penX, scale, originX, originY), closed: false });
            cx = cmd.args[0]!;
            cy = cmd.args[1]!;
            cur = [[cx, cy]];
            break;
          }
          case 'lineTo': {
            cx = cmd.args[0]!;
            cy = cmd.args[1]!;
            cur.push([cx, cy]);
            break;
          }
          case 'quadraticCurveTo': {
            const [qx, qy, ex, ey] = cmd.args;
            const [c1, c2] = quadToCubic([cx, cy], [qx!, qy!], [ex!, ey!]);
            cur.push(...flattenCubic([cx, cy], c1, c2, [ex!, ey!]));
            cx = ex!;
            cy = ey!;
            break;
          }
          case 'bezierCurveTo': {
            const [c1x, c1y, c2x, c2y, ex, ey] = cmd.args;
            cur.push(...flattenCubic([cx, cy], [c1x!, c1y!], [c2x!, c2y!], [ex!, ey!]));
            cx = ex!;
            cy = ey!;
            break;
          }
          case 'closePath': {
            if (cur.length > 1) {
              subpaths.push({ points: toPagePoints(cur, penX, scale, originX, originY), closed: true });
              cur = [];
            }
            break;
          }
        }
      }
      // Flush any remaining open subpath.
      if (cur.length > 1) {
        subpaths.push({ points: toPagePoints(cur, penX, scale, originX, originY), closed: false });
      }
    }

    // Advance the pen.
    const advance = pos?.xAdvance ?? glyph.advanceWidth ?? 0;
    penX += advance + (pos?.xOffset ?? 0);
  }

  if (subpaths.length === 0) return [];

  return [{
    op: 'path',
    subpaths,
    fill: color,
    fillOpacity: opacity,
    fillRule: 'nonzero',
  }];
}

/** Convert font-unit points to page-space PolyPoints (scale + flip Y + translate). */
function toPagePoints(
  points: number[][],
  penX: number,
  scale: number,
  originX: number,
  originY: number,
): PolyPoint[] {
  return points.map((p) => [
    originX + (penX + p[0]!) * scale,
    originY - p[1]! * scale, // fontkit Y-up → PDF Y-down
  ] as PolyPoint);
}
