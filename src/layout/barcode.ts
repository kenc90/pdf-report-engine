/**
 * Barcode blocks: QR (2D) and the two 1D symbologies report engines usually
 * need — Code 128 and EAN-13.
 *
 * Both paths emit plain rectangles through the same `fillRect` primitive as
 * everything else, so a barcode scales with the page like vector art and needs
 * no rasterisation. Dark modules are merged per row (QR) or per bar (1D) to
 * keep the command list small.
 */
import type { BarcodeBlock } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import { typeset } from '../text/typeset.js';
import type { LayoutContext } from './context.js';
import type { BlockLayoutOptions } from './block.js';
import { resolveBox } from './box.js';
import { resolveContent } from './context.js';
import type { DrawCommand, Fragment } from './flow.js';
import { toRGB, type RGB } from '../core/color.js';
import { toPt } from '../core/units.js';
import { encodeQR } from '../barcode/qr.js';
import { CODE128_QUIET, encodeCode128 } from '../barcode/code128.js';
import { encodeEan13, normalizeEan13 } from '../barcode/ean13.js';

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const BLACK: RGB = [0, 0, 0];

const QR_QUIET = 4;
const EAN13_QUIET_LEFT = 11;
const EAN13_QUIET_RIGHT = 7;
const DEFAULT_BAR_HEIGHT = 46;

export function layoutBarcode(
  block: BarcodeBlock,
  ctx: LayoutContext,
  opts: BlockLayoutOptions,
  inherited: ResolvedStyle,
): Fragment[] {
  const style = ctx.style(block, inherited);
  const { margin, padding } = resolveBox(block);
  const left = margin.left + padding.left;
  const available = Math.max(24, opts.contentWidth - margin.left - margin.right - padding.left - padding.right);
  const color = block.color !== undefined ? toRGB(block.color) : BLACK;

  const value = resolveContent(block.value, ctx, style, opts.scope)
    .map((run) => run.text)
    .join('');
  const commands: DrawCommand[] = [];

  let codeWidth: number;
  let codeHeight: number;
  let label = '';
  let barHeight = 0;

  try {
    if (block.symbology === 'qr') {
      const qr = encodeQR(value, block.errorCorrection ?? 'M');
      const quiet = Math.max(0, block.quietZone ?? QR_QUIET);
      const total = qr.size + quiet * 2;
      const module = block.moduleSize ?? Math.max(0.5, Math.min(4, Math.min(available, 120) / total));
      codeWidth = total * module;
      codeHeight = codeWidth;
      drawQr(commands, qr.modules, qr.size, quiet, module, color);
    } else {
      const isEan = block.symbology === 'ean13';
      const digits13 = isEan ? normalizeEan13(value) : '';
      if (isEan) label = `${digits13.slice(0, 1)} ${digits13.slice(1, 7)} ${digits13.slice(7)}`;
      else label = value;
      const bits = isEan ? encodeEan13(digits13) : encodeCode128(value);
      const quietLeft = isEan ? EAN13_QUIET_LEFT : CODE128_QUIET;
      const quietRight = isEan ? EAN13_QUIET_RIGHT : CODE128_QUIET;
      const total = bits.length + quietLeft + quietRight;
      const module = block.moduleSize ?? Math.max(0.3, Math.min(2, Math.min(available, 240) / total));
      codeWidth = total * module;
      barHeight = Math.max(12, toPt(block.height, DEFAULT_BAR_HEIGHT));
      codeHeight = barHeight;
      drawBars(commands, bits, quietLeft * module, 0, module, barHeight, color);
    }
  } catch (err) {
    throw new Error(`barcode (${block.symbology}): ${(err as Error).message}`);
  }

  // The printed value, centred under the bars (never inside a QR code).
  const showText = block.showText !== false && block.symbology !== 'qr' && label.length > 0;
  const labelStyle = ctx.style({ fontSize: Math.min(9, style.fontSize) }, style);
  let textCommand: DrawCommand | undefined;
  if (showText) {
    const text = clipText(label, labelStyle, Math.max(1, codeWidth));
    const line = typeset([{ text, style: labelStyle }], UNBOUNDED).lines[0];
    if (line) {
      textCommand = { op: 'text', x: 0, baselineY: barHeight + 3 + line.ascent, runs: line.runs, gapWidth: 0, decorations: [] };
      codeHeight += 3 + line.height;
    }
  }

  // Horizontal placement follows the block's alignment inside the content box.
  const align = block.align ?? inherited.align ?? 'left';
  const x = left + (align === 'center' ? (available - codeWidth) / 2 : align === 'right' ? available - codeWidth : 0);
  for (const cmd of commands) {
    if (cmd.op === 'fillRect') cmd.x += x;
  }
  if (textCommand && textCommand.op === 'text') {
    const runs = textCommand.runs;
    const width = runs.reduce((w, r) => Math.max(w, r.x + r.width), 0);
    textCommand.x = x + (codeWidth - width) / 2;
  }
  if (textCommand) commands.push(textCommand);

  const boxW = opts.contentWidth - margin.left - margin.right;
  const framed: DrawCommand[] = [];
  if (style.backgroundColor !== undefined) {
    framed.push({ op: 'fillRect', x: 0, y: 0, w: boxW, h: codeHeight, color: toRGB(style.backgroundColor) });
  }
  framed.push(...commands);

  return [
    {
      height: codeHeight,
      before: margin.top + padding.top,
      after: margin.bottom + padding.bottom,
      commands: framed,
      avoidSplit: true,
      breakBefore: block.breakBefore,
      breakAfter: block.breakAfter,
      keepWithNext: block.keepWithNext,
    },
  ];
}

/** Merge each QR row into horizontal dark runs, then emit one rect per run. */
function drawQr(
  commands: DrawCommand[],
  modules: boolean[][],
  size: number,
  quiet: number,
  module: number,
  color: RGB,
): void {
  for (let y = 0; y < size; y += 1) {
    const row = modules[y]!;
    let runStart = -1;
    for (let x = 0; x <= size; x += 1) {
      const dark = x < size && row[x] === true;
      if (dark && runStart < 0) runStart = x;
      if (!dark && runStart >= 0) {
        commands.push({
          op: 'fillRect',
          x: (quiet + runStart) * module,
          y: (quiet + y) * module,
          w: (x - runStart) * module,
          h: module,
          color,
        });
        runStart = -1;
      }
    }
  }
}

/** Emit one rect per contiguous run of `1`s in a 1D module string. */
function drawBars(
  commands: DrawCommand[],
  bits: string,
  xOffset: number,
  y: number,
  module: number,
  height: number,
  color: RGB,
): void {
  let runStart = -1;
  for (let i = 0; i <= bits.length; i += 1) {
    const bar = i < bits.length && bits[i] === '1';
    if (bar && runStart < 0) runStart = i;
    if (!bar && runStart >= 0) {
      commands.push({
        op: 'fillRect',
        x: xOffset + runStart * module,
        y,
        w: (i - runStart) * module,
        h: height,
        color,
      });
      runStart = -1;
    }
  }
}

/** Truncate with an ellipsis so a long code value cannot bleed past the bars. */
function clipText(text: string, style: ResolvedStyle, maxWidth: number): string {
  if (measure(text, style) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + '\u2026', style) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? text.slice(0, lo) + '\u2026' : '';
}

function measure(text: string, style: ResolvedStyle): number {
  if (!text) return 0;
  return typeset([{ text, style }], UNBOUNDED).lines[0]?.width ?? 0;
}
