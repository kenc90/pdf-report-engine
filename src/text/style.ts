/**
 * Style resolution.
 *
 * `StyleProps` is what an author writes (sparse, inherited, in relative units).
 * `ResolvedStyle` is what the typesetter consumes (dense, absolute, with the
 * concrete `FontHandle` already picked). The two-step split keeps inheritance
 * logic in one place so the layout engine never has to merge property objects.
 */
import type { ColorInput } from '../core/color.js';
import type { StyleProps } from '../ir/schema.js';
import type { FontHandle } from '../fonts/registry.js';
import { FontRegistry } from '../fonts/registry.js';

export interface ResolvedStyle {
  handle: FontHandle;
  /**
   * The `font-family` stack (or inherited family) that produced {@link handle},
   * kept so per-glyph fallback can re-resolve a code point against the same stack.
   */
  fontStack?: string | string[];
  fontSize: number;
  /** Absolute line height in points. */
  lineHeight: number;
  /**
   * The line-height *declaration* that produced {@link lineHeight}: a unitless
   * multiplier (e.g. `1.5`) or `'normal'`. Kept separate from the absolute value
   * so a dense style can be re-resolved (when `fontSize` changes, or when it is
   * spread as an inherited base) without the absolute value being mistaken for a
   * fresh multiplier and multiplied again.
   */
  lineHeightInput?: number | 'normal';
  letterSpacing: number;
  align: 'left' | 'center' | 'right' | 'justify';
  verticalAlign: 'top' | 'middle' | 'bottom';
  whiteSpace: 'normal' | 'nowrap' | 'pre-wrap';
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  color: ColorInput;
  backgroundColor: ColorInput | undefined;
  features: Record<string, boolean> | undefined;
  decoration: Array<'underline' | 'line-through'>;
}

const DEFAULT_FONT_SIZE = 12;

/**
 * A property bag accepted by {@link resolveStyle}: author `StyleProps` plus the
 * internal `lineHeightInput` carry. A dense `ResolvedStyle` satisfies this, so the
 * same object can be spread as an inherited base without leaking its absolute
 * `lineHeight` back in as a multiplier.
 */
export type StyleInput = Partial<StyleProps> & { lineHeightInput?: number | 'normal' };

function weightOf(w: StyleProps['fontWeight']): number {
  if (w === 'bold') return 700;
  if (w === 'normal' || w === undefined) return 400;
  return w;
}

function styleOf(s: StyleProps['fontStyle']): 'normal' | 'italic' {
  return s === 'italic' ? 'italic' : 'normal';
}

/** Merge an inherited style with an override; `undefined` fields keep the parent value. */
export function mergeProps(base: StyleInput, over: StyleInput | undefined): StyleInput {
  if (!over) return { ...base };
  const out: StyleInput = { ...base };
  for (const key of Object.keys(over) as Array<keyof StyleProps>) {
    const v = over[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  // A fresh *author* declaration of `lineHeight` (a ratio/'normal', on a props bag
  // that carries no `lineHeightInput`) becomes the new declaration. Never rewrite
  // it from an absolute that merely round-tripped through a dense style.
  if (over.lineHeight !== undefined && over.lineHeightInput === undefined) {
    out.lineHeightInput = over.lineHeight;
  }
  // Font features stack additively rather than replacing.
  if (base.features || over.features) out.features = { ...base.features, ...over.features };
  if (base.textDecoration || over.textDecoration) {
    out.textDecoration = [
      ...new Set([...(base.textDecoration ?? []), ...(over.textDecoration ?? [])]),
    ];
  }
  return out;
}

/**
 * Turn a (possibly sparse, inherited) property bag into a dense `ResolvedStyle`.
 * `registry.resolve` never throws: an unknown family falls back to a heuristic
 * handle so layout stays deterministic even before fonts are embedded.
 */
export function resolveStyle(
  props: StyleInput,
  registry: FontRegistry,
  inherited: ResolvedStyle | undefined,
): ResolvedStyle {
  const fontSize = props.fontSize ?? inherited?.fontSize ?? DEFAULT_FONT_SIZE;
  const weight = weightOf(props.fontWeight ?? inherited?.handle.weight);
  const fontStyle = styleOf(props.fontStyle ?? (inherited ? inherited.handle.style : undefined));

  // `fontVariant: 'tabular-nums'` is shorthand for the tnum OpenType feature.
  const features: Record<string, boolean> | undefined =
    props.features || props.fontVariant || inherited?.features
      ? {
          ...(inherited?.features ?? {}),
          ...(props.features ?? {}),
          ...(props.fontVariant === 'tabular-nums' ? { tnum: true } : {}),
        }
      : undefined;

  const stack = props.fontFamily ?? inherited?.handle.family;
  const handle = registry.resolve(stack as string | string[] | undefined, weight, fontStyle);

  // Prefer the carried declaration (a multiplier / 'normal') over the absolute
  // `lineHeight`, which is the value we compute and must not be re-multiplied.
  const lhInput = props.lineHeightInput ?? props.lineHeight ?? inherited?.lineHeightInput;
  const lineHeight = resolveLineHeight(lhInput, handle, fontSize);

  return {
    handle,
    fontStack: stack as string | string[] | undefined,
    fontSize,
    lineHeight,
    lineHeightInput: lhInput,
    letterSpacing: props.letterSpacing ?? inherited?.letterSpacing ?? 0,
    align: props.align ?? inherited?.align ?? 'left',
    verticalAlign: props.verticalAlign ?? inherited?.verticalAlign ?? 'top',
    whiteSpace: props.whiteSpace ?? inherited?.whiteSpace ?? 'normal',
    textTransform: props.textTransform ?? inherited?.textTransform ?? 'none',
    color: props.color ?? inherited?.color ?? [0, 0, 0],
    backgroundColor: props.backgroundColor ?? inherited?.backgroundColor,
    features,
    decoration: (props.textDecoration ?? inherited?.decoration ?? []) as ResolvedStyle['decoration'],
  };
}

function resolveLineHeight(
  lh: StyleProps['lineHeight'],
  handle: FontHandle,
  fontSize: number,
): number {
  if (typeof lh === 'number') return lh * fontSize;
  const natural = (handle.ascender - handle.descender + handle.lineGap) / handle.unitsPerEm;
  // `normal` (or inherited-normal): font's own natural line height, floored so
  // metric-less fonts stay legible.
  return Math.max(natural, 1.15) * fontSize;
}
