/**
 * Multi-column layout: distribute child blocks across N equal-width columns.
 *
 * Children are sequentially laid out at column width, then their fragments are
 * distributed across columns by filling each column until it reaches the target
 * height (total / count). The result is one atomic fragment so pagination keeps
 * all columns together (similar to a flex container).
 *
 * Optional vertical rules are drawn between adjacent columns.
 */
import type { ColumnBlock, Block } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import type { LayoutContext } from './context.js';
import { layoutBlock, type BlockLayoutOptions } from './block.js';
import { resolveBox } from './box.js';
import { toRGB } from '../core/color.js';
import { toPt } from '../core/units.js';
import { translateCommands, type DrawCommand, type Fragment } from './flow.js';

export function layoutColumns(
  block: ColumnBlock,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
): Fragment[] {
  const count = Math.max(1, block.count ?? 2);
  const gap = block.gap !== undefined ? toPt(String(block.gap)) : 12;
  const { margin, padding } = resolveBox(block);
  const innerW = opts.contentWidth - margin.left - margin.right - padding.left - padding.right;
  const colW = count > 1 ? (innerW - gap * (count - 1)) / count : innerW;

  // 1. Layout all children at column width.
  const allFrags: Fragment[] = [];
  for (const child of block.children) {
    const frags = layoutBlock(child, ctx, { ...opts, contentWidth: colW, inherited });
    allFrags.push(...frags);
  }

  if (allFrags.length === 0) {
    // Empty columns block: produce a spacer fragment.
    return [{ height: 0, before: margin.top, after: margin.bottom, commands: [] }];
  }

  // 2. Calculate target height per column and distribute fragments.
  const totalH = allFrags.reduce((s, f) => s + f.before + f.height + f.after, 0);
  const targetH = totalH / count;

  const columns: Fragment[][] = Array.from({ length: count }, () => []);
  let col = 0;
  let colH = 0;
  for (const f of allFrags) {
    const span = f.before + f.height + f.after;
    columns[col]!.push(f);
    colH += span;
    if (colH >= targetH && col < count - 1) {
      col++;
      colH = 0;
    }
  }

  // 3. Compose the result: place each column at its x-offset, track max height.
  //    Follow the same convention as layoutFlex: commands' y coords are relative
  //    to the fragment's padding-box top (0 = padding edge), and `before` carries
  //    the margin separately so pagination never double-counts it.
  const commands: DrawCommand[] = [];
  const contentOffX = margin.left + padding.left;
  let maxColH = 0;

  for (let c = 0; c < count; c++) {
    const colX = contentOffX + c * (colW + gap);
    let y = 0;
    for (const f of columns[c]!) {
      y += f.before;
      const shifted = translateCommands(f.commands, colX, y);
      commands.push(...shifted);
      y += f.height + f.after;
    }
    maxColH = Math.max(maxColH, y);
  }

  // Shift all content commands down by padding.top (matches flex convention).
  const padded = translateCommands(commands, 0, padding.top);

  // 4. Column rules (vertical lines between adjacent columns).
  if (block.rule) {
    const ruleColor = typeof block.rule === 'object' && block.rule.color
      ? toRGB(block.rule.color)
      : toRGB('#d0d0d0');
    const ruleW = typeof block.rule === 'object' && block.rule.width
      ? block.rule.width
      : 0.5;
    for (let c = 1; c < count; c++) {
      const x = contentOffX + c * colW + (c - 1) * gap + gap / 2;
      padded.push({
        op: 'line',
        x1: x,
        y1: padding.top,
        x2: x,
        y2: padding.top + maxColH,
        color: ruleColor,
        lineWidth: ruleW,
      });
    }
  }

  // 5. Background/border box for the container.
  const bg = block.backgroundColor ? toRGB(block.backgroundColor) : undefined;
  const outerW = opts.contentWidth - margin.left - margin.right;
  const outerH = maxColH + padding.top + padding.bottom;
  const finalCommands: DrawCommand[] = [];
  if (bg) {
    finalCommands.push({ op: 'fillRect', x: margin.left, y: 0, w: outerW, h: outerH, color: bg });
  }
  finalCommands.push(...padded);

  const frag: Fragment = {
    height: outerH,
    before: margin.top,
    after: margin.bottom,
    commands: finalCommands,
    avoidSplit: true,
  };
  return [frag];
}
