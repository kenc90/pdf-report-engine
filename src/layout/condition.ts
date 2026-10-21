/**
 * Conditional formatting primitives shared by block layout and table layout.
 *
 * Three features live here:
 *  - `visible` expressions (a boolean hides, an `Expr` is evaluated in scope);
 *  - `styleWhen` rules, merged in order on top of the node's own props;
 *  - numeric colour scales, which turn a value into a heatmap fill.
 *
 * Evaluation goes through `LayoutContext.eval`, so the same sandbox, scope
 * roots and function library apply as every other binding.
 */
import type { ColorInput } from '../core/color.js';
import { toRGB, type RGB } from '../core/color.js';
import type { ColorScale, StyleCondition } from '../ir/schema.js';
import type { LayoutContext } from './context.js';
import type { ExprContext } from '../expr/eval.js';

/** Evaluate a `when` expression (bare string or `{ expr }`). */
export function conditionHolds(when: string | { expr: string } | undefined, ctx: LayoutContext, scope: ExprContext): boolean {
  if (when === undefined) return false;
  return Boolean(ctx.eval(when, scope));
}

/** Evaluate a `visible` flag: `undefined`/`true` show the node, `false`/falsy hides it. */
export function isVisible(visible: boolean | { expr: string } | undefined, ctx: LayoutContext, scope: ExprContext): boolean {
  if (visible === undefined) return true;
  if (typeof visible === 'boolean') return visible;
  return Boolean(ctx.eval(visible, scope));
}

/**
 * Merge every matching condition's `style` into `base` (later rules win).
 * `undefined` values never erase a property, matching the style cascade.
 */
export function applyConditions<T extends object>(
  base: T,
  conditions: StyleCondition[] | undefined,
  ctx: LayoutContext,
  scope: ExprContext,
): T {
  if (!conditions?.length) return base;
  let out = base;
  for (const condition of conditions) {
    if (!conditionHolds(condition.when, ctx, scope)) continue;
    if (!condition.style) continue;
    const next = { ...out } as Record<string, unknown>;
    for (const [key, value] of Object.entries(condition.style)) {
      if (value !== undefined) next[key] = value;
    }
    out = next as T;
  }
  return out;
}

const SCALE_FROM: ColorInput = '#eef4ff';
const SCALE_TO: ColorInput = '#1e3a8a';

/**
 * Turn a cell value into a heatmap fill. `range` supplies the domain when the
 * scale itself omits `min`/`max` (computed per column from the table's data).
 * Returns `undefined` when the value is not numeric.
 */
export function scaleFillFor(
  scale: ColorScale | undefined,
  value: number | undefined,
  range?: { min: number; max: number },
): { fill: RGB; color?: RGB } | undefined {
  if (!scale || value === undefined || !Number.isFinite(value)) return undefined;
  const min = scale.min ?? range?.min ?? 0;
  const max = scale.max ?? range?.max ?? 1;
  const span = max - min;
  const t = span === 0 ? (value >= max ? 1 : 0) : Math.min(1, Math.max(0, (value - min) / span));
  const from = toRGB(scale.from ?? SCALE_FROM);
  const to = toRGB(scale.to ?? SCALE_TO);
  const fill: RGB = [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
  // Dark fills need light text to stay readable; authors can opt out.
  if (scale.text !== false && luminance(fill) < 0.45) return { fill, color: [1, 1, 1] };
  return { fill };
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
