/**
 * PDF writer. Executes paginated pages against pdfkit.
 *
 * pdfkit is the only component allowed to touch the PDF byte stream. It gives us
 * the ToUnicode CMap for free, which is exactly what makes the output selectable
 * and searchable. The writer translates fragment-local draw commands to absolute
 * page space and paints them one at a time.
 */
import type { Page, PlacedFragment } from '../pagination/engine.js';
import type { DrawCommand, DashPattern } from '../layout/flow.js';
import type { PositionedRun } from '../text/typeset.js';
import type { RGB, ColorInput } from '../core/color.js';
import { toRGB } from '../core/color.js';

type PDFDocument = PDFKit.PDFDocument;

export function writePage(doc: PDFDocument, page: Page): void {
  doc.addPage({
    size: [page.width, page.height],
    margin: 0,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  // Reset pdfkit's own layout cursor so it never interferes with our manual
  // positioning; every draw command passes explicit x, y.
  doc.x = 0;
  doc.y = 0;
  for (const pf of page.header) drawFragment(doc, pf);
  for (const pf of page.body) drawFragment(doc, pf);
  for (const pf of page.footer) drawFragment(doc, pf);
}

function drawFragment(doc: PDFDocument, { fragment, x, y }: PlacedFragment): void {
  for (const cmd of fragment.commands) drawCommand(doc, cmd, x, y);
}

function drawCommand(doc: PDFDocument, cmd: DrawCommand, x: number, y: number): void {
  switch (cmd.op) {
    case 'fillRect':
      doc.fillColor(css(cmd.color)).rect(x + cmd.x, y + cmd.y, cmd.w, cmd.h).fill();
      return;
    case 'strokeRect': {
      doc.save();
      doc.lineWidth(cmd.lineWidth).strokeColor(css(cmd.color));
      if (cmd.dash) applyDash(doc, cmd.dash);
      doc.rect(x + cmd.x, y + cmd.y, cmd.w, cmd.h).stroke();
      doc.restore();
      return;
    }
    case 'line': {
      doc.save();
      doc.lineWidth(cmd.lineWidth).strokeColor(css(cmd.color));
      if (cmd.dash) applyDash(doc, cmd.dash);
      doc.moveTo(x + cmd.x1, y + cmd.y1).lineTo(x + cmd.x2, y + cmd.y2).stroke();
      doc.restore();
      return;
    }
    case 'text':
      drawText(doc, cmd, x, y);
      return;
    case 'image': {
      // Layout already resolved a width+height that preserve the aspect ratio,
      // so pass both. `doc.image` accepts a path, a `data:` URI, or raw bytes.
      doc.image(imageSource(cmd.src), x + cmd.x, y + cmd.y, { width: cmd.w, height: cmd.h });
      return;
    }
    case 'underline':
      doc.save();
      doc.lineWidth(cmd.lineWidth).strokeColor(css(cmd.color));
      doc.moveTo(x + cmd.x1, y + cmd.y1).lineTo(x + cmd.x2, y + cmd.y1).stroke();
      doc.restore();
      return;
  }
}

/**
 * Coerce an image source to what pdfkit accepts across runtimes: a filesystem
 * path or `data:` URI passes through; bytes become a Node Buffer where one exists,
 * otherwise a base64 `data:` URI (a browser bundle has no global `Buffer`).
 */
function imageSource(src: string | Uint8Array): string | Buffer {
  if (typeof src === 'string') return src;
  const g = globalThis as { Buffer?: { from: (b: Uint8Array) => unknown } };
  if (typeof g.Buffer?.from === 'function') return g.Buffer.from(src) as Buffer;
  return `data:${sniffImageMime(src)};base64,${bytesToBase64(src)}`;
}

/** PNG or JPEG magic bytes → the mime pdfkit's data-URI decoder expects. */
function sniffImageMime(b: Uint8Array): string {
  if (b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return 'image/png';
}

/** Bytes → base64 without a global Buffer (browser fallback path). */
function bytesToBase64(bytes: Uint8Array): string {
  const btoaFn = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (typeof btoaFn === 'function') {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoaFn(bin);
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return out;
}

function applyDash(doc: PDFDocument, dash: DashPattern): void {
  // pdfkit's typed `dash()` wants a single length plus a space; that covers the
  // 2-value patterns we generate (dashed `[4,3]`, dotted `[1,2]`).
  doc.dash(dash[0]!, { space: dash[1] ?? dash[0] });
}

function drawText(doc: PDFDocument, cmd: Extract<DrawCommand, { op: 'text' }>, x: number, y: number): void {
  let spacesBefore = 0;
  for (const run of cmd.runs) {
    const style = run.style;
    const fontName = style.handle.embeddedName ?? 'Helvetica';
    const ascent = (style.handle.ascender / style.handle.unitsPerEm) * style.fontSize;
    const penX = x + cmd.x + run.x + cmd.gapWidth * spacesBefore;
    // pdfkit's text(x, y) treats y as the top of the line and internally offsets
    // by `ascender/1000 * size`. We want the visual baseline at `y + cmd.baselineY`,
    // so we hand pdfkit `baseline - ascent` and it re-adds the ascent itself.
    const pdfkitY = y + cmd.baselineY - ascent;

    doc.font(fontName);
    doc.fontSize(style.fontSize);
    doc.fillColor(css(resolveRunColor(style.color, run)));
    const options: Record<string, unknown> = { lineBreak: false };
    if (style.features) options.features = style.features;
    if (style.letterSpacing) options.characterSpacing = style.letterSpacing;
    doc.text(run.text, penX, pdfkitY, options);

    drawDecorations(doc, run, penX, y + cmd.baselineY, ascent);
    if (run.space) spacesBefore += 1;
  }
}

function drawDecorations(doc: PDFDocument, run: PositionedRun, x: number, baselineY: number, ascent: number): void {
  const decs = run.style.decoration;
  if (!decs || decs.length === 0) return;
  const width = run.width;
  const weight = Math.max(0.5, run.style.fontSize / 18);
  doc.save();
  doc.lineWidth(weight).strokeColor(css(resolveRunColor(run.style.color, run)));
  for (const d of decs) {
    const yy = d === 'underline' ? baselineY + weight : baselineY - ascent * 0.32;
    doc.moveTo(x, yy).lineTo(x + width, yy).stroke();
  }
  doc.restore();
}

function resolveRunColor(color: ColorInput, _run: PositionedRun): RGB {
  return toRGB(color);
}

function css([r, g, b]: RGB): string {
  const hex = (n: number): string => Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
