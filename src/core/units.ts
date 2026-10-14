/**
 * Absolute units. Everything inside the engine works in PostScript points
 * (1/72 inch) because that is the PDF user-space unit, so the layout pass never
 * has to think about DPI. Only the public API accepts human units.
 */
export const MM_TO_PT = 72 / 25.4;
export const CM_TO_PT = MM_TO_PT * 10;
export const IN_TO_PT = 72;
/** CSS reference pixel, i.e. 96dpi px -> 72dpi pt. */
export const PX_TO_PT = 0.75;

/** A length: a bare number is already points, otherwise an explicit unit. */
export type Length = number | string;

export function toPt(value: Length | undefined, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return value;
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(pt|mm|cm|in|pc|px|%)?\s*$/i.exec(value);
  if (!m) throw new Error(`Invalid length: ${JSON.stringify(value)}`);
  const num = parseFloat(m[1]!);
  switch ((m[2] ?? 'pt').toLowerCase()) {
    case 'pt':
      return num;
    case 'mm':
      return num * MM_TO_PT;
    case 'cm':
      return num * CM_TO_PT;
    case 'in':
      return num * IN_TO_PT;
    case 'pc':
      return num * 12;
    case 'px':
      return num * PX_TO_PT;
    default:
      // Percentages are context dependent and must be resolved by the caller.
      return num;
  }
}

/** Resolve one-or-four valued shorthand (CSS box model order: top right bottom left). */
export function expandBox<T>(
  value: T | [T] | [T, T] | [T, T, T] | [T, T, T, T] | undefined,
  fallback: T,
): { top: T; right: T; bottom: T; left: T } {
  if (value === undefined) return { top: fallback, right: fallback, bottom: fallback, left: fallback };
  if (!Array.isArray(value)) {
    const v = value as T;
    return { top: v, right: v, bottom: v, left: v };
  }
  const a = value as unknown[];
  if (a.length === 1) return { top: a[0] as T, right: a[0] as T, bottom: a[0] as T, left: a[0] as T };
  if (a.length === 2) return { top: a[0] as T, right: a[1] as T, bottom: a[0] as T, left: a[1] as T };
  if (a.length === 3) return { top: a[0] as T, right: a[1] as T, bottom: a[2] as T, left: a[1] as T };
  return { top: a[0] as T, right: a[1] as T, bottom: a[2] as T, left: a[3] as T };
}

/** Round to the PDF float precision we actually emit; keeps content streams comparable in tests. */
export function pt(value: number): number {
  return Math.round(value * 1000) / 1000;
}
