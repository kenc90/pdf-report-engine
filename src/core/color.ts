/**
 * Colour handling. Colours stay as `[r, g, b]` in 0..1 because that is what the
 * PDF `rg` / `RG` operators consume, which keeps the writer free of conversions.
 */
export type RGB = [number, number, number];

export type ColorInput = string | RGB;

const NAMED: Record<string, RGB> = {
  black: [0, 0, 0],
  white: [1, 1, 1],
  red: [1, 0, 0],
  green: [0, 0.5, 0],
  blue: [0, 0, 1],
  yellow: [1, 1, 0],
  cyan: [0, 1, 1],
  magenta: [1, 0, 1],
  gray: [0.5, 0.5, 0.5],
  grey: [0.5, 0.5, 0.5],
  lightgray: [0.827, 0.827, 0.827],
  lightgrey: [0.827, 0.827, 0.827],
  darkgray: [0.664, 0.664, 0.664],
  darkgrey: [0.664, 0.664, 0.664],
  silver: [0.752, 0.752, 0.752],
  navy: [0, 0, 0.5],
  teal: [0, 0.5, 0.5],
  orange: [1, 0.647, 0],
  purple: [0.5, 0, 0.5],
  maroon: [0.5, 0, 0],
  olive: [0.5, 0.5, 0],
  lime: [0, 1, 0],
  aqua: [0, 1, 1],
  fuchsia: [1, 0, 1],
  transparent: [1, 1, 1],
  // Report-friendly defaults.
  aliceblue: [0.941, 0.973, 1],
  gainsboro: [0.863, 0.863, 0.863],
  whitesmoke: [0.961, 0.961, 0.961],
  dimgray: [0.412, 0.412, 0.412],
  slategray: [0.439, 0.502, 0.569],
  steelblue: [0.275, 0.51, 0.706],
  royalblue: [0.255, 0.412, 0.882],
  firebrick: [0.698, 0.133, 0.133],
  seagreen: [0.18, 0.545, 0.341],
  goldenrod: [0.855, 0.647, 0.125],
  crimson: [0.863, 0.078, 0.235],
  midnightblue: [0.1, 0.1, 0.44],
};

function hex(v: string): RGB {
  const digits = v.replace(/^#/, '');
  const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s.padEnd(2, '0'), 16) / 255;
  if (digits.length === 3 || digits.length === 4) {
    return [expand(digits[0]!), expand(digits[1]!), expand(digits[2]!)];
  }
  if (digits.length === 6 || digits.length === 8) {
    return [
      parseInt(digits.slice(0, 2), 16) / 255,
      parseInt(digits.slice(2, 4), 16) / 255,
      parseInt(digits.slice(4, 6), 16) / 255,
    ];
  }
  throw new Error(`Invalid hex colour: ${v}`);
}

export function toRGB(color: ColorInput): RGB {
  if (Array.isArray(color)) {
    const [r, g, b] = color;
    return [clamp01(r ?? 0), clamp01(g ?? 0), clamp01(b ?? 0)];
  }
  const name = color.trim().toLowerCase();
  if (name.startsWith('#')) return hex(name);
  const fn = /^(rgb|rgba)\(([^)]+)\)$/.exec(name);
  if (fn) {
    const parts = fn[2]!.split(/[,/\s]+/).filter(Boolean);
    const num = (s: string | undefined): number => {
      if (!s) return 0;
      if (s.endsWith('%')) return parseFloat(s) / 100;
      const value = parseFloat(s);
      // Tolerate 0..255 and 0..1 the way humans expect a quick rgb() call to work.
      return value > 1 ? value / 255 : value;
    };
    return [num(parts[0]), num(parts[1]), num(parts[2])];
  }
  const named = NAMED[name];
  if (named) return named;
  throw new Error(`Unknown colour: ${color}`);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Multiply a colour toward black/white, used for border and band-shade derivation. */
export function shade(color: RGB, factor: number): RGB {
  const f = clamp01(factor);
  return [color[0] * f, color[1] * f, color[2] * f];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
