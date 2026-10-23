/**
 * Box model helpers shared by every block: margin/padding resolution and border
 * shorthand normalisation. Kept tiny and pure so layout stays deterministic.
 */
import { toPt, expandBox, type Length } from '../core/units.js';
import { toRGB, type RGB, type ColorInput } from '../core/color.js';
import type { BoxProps, BorderShorthand, BorderStyle, ResolvedBorder, BoxShadow, LinearGradient } from '../ir/schema.js';
import type { DashPattern, Radius, ResolvedGradient, ResolvedShadow } from './flow.js';

export interface EdgeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function resolveBox(box: BoxProps): { margin: EdgeInsets; padding: EdgeInsets } {
  const margin = expandBox<number>(
    [box.marginTop ?? 0, box.marginRight ?? 0, box.marginBottom ?? 0, box.marginLeft ?? 0] as [
      number,
      number,
      number,
      number,
    ],
    0,
  );
  const pad = expandBox<number>(
    [box.paddingTop ?? 0, box.paddingRight ?? 0, box.paddingBottom ?? 0, box.paddingLeft ?? 0] as [
      number,
      number,
      number,
      number,
    ],
    0,
  );
  const conv = (e: typeof margin): EdgeInsets => ({
    top: toPt(e.top),
    right: toPt(e.right),
    bottom: toPt(e.bottom),
    left: toPt(e.left),
  });
  return { margin: conv(margin), padding: conv(pad) };
}

export interface Sides {
  top: ResolvedBorder | undefined;
  right: ResolvedBorder | undefined;
  bottom: ResolvedBorder | undefined;
  left: ResolvedBorder | undefined;
}

const DASH: Record<BorderStyle, DashPattern | undefined> = {
  solid: undefined,
  dashed: [4, 3],
  dotted: [1, 2],
  double: undefined,
  none: undefined,
};

/** Normalise the `border` / `borderX` shorthands into four resolved sides. */
export function resolveBorders(box: BoxProps, defaultWidth = 1): Sides {
  const base = parseBorder(box.border, defaultWidth);
  return {
    top: parseBorder(box.borderTop, defaultWidth) ?? base,
    right: parseBorder(box.borderRight, defaultWidth) ?? base,
    bottom: parseBorder(box.borderBottom, defaultWidth) ?? base,
    left: parseBorder(box.borderLeft, defaultWidth) ?? base,
  };
}

export function parseBorder(value: BorderShorthand | undefined, defaultWidth: number): ResolvedBorder | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' || Array.isArray(value) && isRGB(value)) {
    return { width: defaultWidth, style: 'solid', color: value as ColorInput };
  }
  if (typeof value === 'number') return undefined;
  const arr = value as unknown[];
  if (arr.length === 2) return { width: toPt(arr[0] as number), style: 'solid', color: arr[1] as ColorInput };
  if (arr.length === 3) {
    const style = arr[1] as BorderStyle;
    return { width: toPt(arr[0] as number), style, color: arr[2] as ColorInput };
  }
  return { width: defaultWidth, style: 'solid', color: value as ColorInput };
}

function isRGB(v: unknown[]): boolean {
  return v.length === 3 && v.every((n) => typeof n === 'number');
}

export function borderRGB(b: ResolvedBorder): RGB {
  return toRGB(b.color);
}

export function borderDash(b: ResolvedBorder): DashPattern | undefined {
  return DASH[b.style];
}

/**
 * Resolve `border-radius` into a `[top-left, top-right, bottom-right, bottom-left]`
 * tuple in points. Returns `undefined` when no radius is declared. Negative
 * corners clamp to 0; the writer additionally clamps each radius to half the
 * shorter edge, so an over-large value cannot self-overlap.
 */
export function resolveRadius(box: BoxProps): Radius | undefined {
  if (box.borderRadius === undefined) return undefined;
  const e = expandBox<Length>(box.borderRadius as Length | [Length, Length] | [Length, Length, Length, Length], 0);
  const c = (v: Length): number => Math.max(0, toPt(v, 0));
  return [c(e.top), c(e.right), c(e.bottom), c(e.left)];
}

/**
 * Resolve a `backgroundImage` two-stop gradient to paint colours plus a snapped
 * cardinal direction. `boxTop`/`boxHeight` are filled in by the emitter, which
 * knows the logical box the (possibly multi-line) background spans.
 */
export function resolveGradient(box: BoxProps): Omit<ResolvedGradient, 'boxTop' | 'boxHeight'> | undefined {
  const g: LinearGradient | undefined = box.backgroundImage;
  if (!g) return undefined;
  return { from: toRGB(g.from), to: toRGB(g.to), dir: gradientDir(g.direction) };
}

function gradientDir(dir: string | undefined): ResolvedGradient['dir'] {
  const d = (dir ?? 'to bottom').trim().toLowerCase();
  const angle = /^(-?(?:\d+\.?\d*|\.\d+))deg$/.exec(d);
  if (angle) {
    // CSS: 0deg points up, increasing clockwise. Snap to the nearest cardinal.
    const deg = ((parseFloat(angle[1]!) % 360) + 360) % 360;
    const cardinals: ResolvedGradient['dir'][] = ['top', 'right', 'bottom', 'left'];
    return cardinals[Math.round(deg / 90) % 4]!;
  }
  // Keyword / corner form (e.g. `to bottom right`): the vertical side wins over
  // the horizontal one, so a corner snaps to a cardinal axis rather than erroring.
  if (d.includes('top')) return 'top';
  if (d.includes('bottom')) return 'bottom';
  if (d.includes('left')) return 'left';
  if (d.includes('right')) return 'right';
  return 'bottom';
}

/**
 * Resolve a `boxShadow` to absolute points and colour. Inset shadows are not
 * modelled and return `undefined`; the blur is clamped non-negative.
 */
export function resolveShadow(box: BoxProps): ResolvedShadow | undefined {
  const s: BoxShadow | undefined = box.boxShadow;
  if (!s || s.inset) return undefined;
  return {
    dx: toPt(s.offsetX ?? 0, 0),
    dy: toPt(s.offsetY ?? 0, 0),
    blur: Math.max(0, toPt(s.blur ?? 0, 0)),
    color: s.color !== undefined ? toRGB(s.color) : [0, 0, 0],
    opacity: s.opacity ?? 0.28,
  };
}
