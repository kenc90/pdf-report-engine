import { MM_TO_PT, IN_TO_PT, type Length, toPt } from './units.js';

/**
 * Page geometry. Widths/heights are points, matching PDF user space with the
 * default 1:1 scale.
 */
export interface PageSize {
  width: number;
  height: number;
}

export type StandardPageName =
  | 'a3'
  | 'a4'
  | 'a5'
  | 'b4'
  | 'b5'
  | 'letter'
  | 'legal'
  | 'tabloid'
  | 'executive';

/** ISO 216 sizes are given as [width, height] in millimetres. */
const MM_SIZES: Record<string, [number, number]> = {
  a3: [297, 420],
  a4: [210, 297],
  a5: [148, 210],
  b4: [250, 353],
  b5: [176, 250],
};

const INCH_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  executive: [7.25, 10.5],
};

export function standardPageSize(name: StandardPageName | string): PageSize {
  const key = String(name).toLowerCase();
  const mm = MM_SIZES[key];
  if (mm) return { width: mm[0] * MM_TO_PT, height: mm[1] * MM_TO_PT };
  const inch = INCH_SIZES[key];
  if (inch) return { width: inch[0] * IN_TO_PT, height: inch[1] * IN_TO_PT };
  throw new Error(`Unknown page size: ${name}`);
}

export type PageSpecSize =
  | StandardPageName
  | string
  | PageSize
  | [Length, Length];

export interface PageSpec {
  /** Named size, `[w, h]` in any supported unit, or `{width, height}`. */
  size?: PageSpecSize;
  orientation?: 'portrait' | 'landscape';
  margin?: Length | [Length] | [Length, Length] | [Length, Length, Length, Length];
}

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ResolvedPage {
  width: number;
  height: number;
  margin: Box;
  /** Content area inside the margins; bands further reduce this. */
  content: { x: number; y: number; width: number };
}

export function resolveMargins(margin: PageSpec['margin']): Box {
  const single = (v: Length): number => toPt(v);
  if (margin === undefined) {
    const m = single('20mm');
    return { top: m, right: m, bottom: m, left: m };
  }
  if (!Array.isArray(margin)) {
    const m = single(margin);
    return { top: m, right: m, bottom: m, left: m };
  }
  const a = margin as Length[];
  if (a.length === 1) return resolveMargins(a[0]);
  if (a.length === 2) return { top: single(a[0]!), bottom: single(a[0]!), left: single(a[1]!), right: single(a[1]!) };
  if (a.length === 3) return { top: single(a[0]!), left: single(a[2]!), right: single(a[2]!), bottom: single(a[1]!) };
  return {
    top: single(a[0]!),
    right: single(a[1]!),
    bottom: single(a[2]!),
    left: single(a[3]!),
  };
}

export function resolvePage(spec: PageSpec = {}): ResolvedPage {
  let size = spec.size ?? 'a4';
  let box: PageSize;
  if (typeof size === 'string') box = standardPageSize(size);
  else if (Array.isArray(size)) box = { width: toPt(size[0]), height: toPt(size[1]) };
  else box = { width: size.width, height: size.height };

  if (spec.orientation === 'landscape') {
    box = { width: Math.max(box.width, box.height), height: Math.min(box.width, box.height) };
  } else if (spec.orientation === 'portrait') {
    box = { width: Math.min(box.width, box.height), height: Math.max(box.width, box.height) };
  }

  const margin = resolveMargins(spec.margin);
  const width = Math.max(0, box.width - margin.left - margin.right);
  return {
    width: box.width,
    height: box.height,
    margin,
    content: { x: margin.left, y: margin.top, width },
  };
}
