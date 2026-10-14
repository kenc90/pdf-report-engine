/**
 * Box model helpers shared by every block: margin/padding resolution and border
 * shorthand normalisation. Kept tiny and pure so layout stays deterministic.
 */
import { toPt, expandBox } from '../core/units.js';
import { toRGB, type RGB, type ColorInput } from '../core/color.js';
import type { BoxProps, BorderShorthand, BorderStyle, ResolvedBorder } from '../ir/schema.js';
import type { DashPattern } from './flow.js';

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
