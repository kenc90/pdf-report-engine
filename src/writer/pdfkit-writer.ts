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
import { imagePathAccessEnabled, isFileSystemSource } from '../core/image.js';

type PDFDocument = PDFKit.PDFDocument;

export interface WritePageOptions {
  /** Emit PDF outline (bookmark) items for this page's headings (default true). */
  outline?: boolean;
}

export function writePage(doc: PDFDocument, page: Page, options: WritePageOptions = {}): void {
  doc.addPage({
    size: [page.width, page.height],
    margin: 0,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  // Reset pdfkit's own layout cursor so it never interferes with our manual
  // positioning; every draw command passes explicit x, y.
  doc.x = 0;
  doc.y = 0;
  // Destinations and outline items must be registered while this page is the
  // document's current page — both APIs bind to `doc.page` at call time.
  registerAnchors(doc, page);
  if (options.outline !== false) addBookmarks(doc, page);
  for (const pf of page.background) drawFragment(doc, pf);
  for (const pf of page.header) drawFragment(doc, pf);
  for (const pf of page.body) drawFragment(doc, pf);
  for (const pf of page.footer) drawFragment(doc, pf);
}

function drawFragment(doc: PDFDocument, { fragment, x, y }: PlacedFragment): void {
  const faded = fragment.opacity !== undefined && fragment.opacity < 1;
  if (faded) {
    doc.save();
    doc.opacity(fragment.opacity!);
  }
  // A full-height fill is the block's own background. Runs inherit that colour
  // through the style cascade, and repainting it per glyph would only add
  // seams — so it is passed down as the "already painted" colour.
  const baseFill = fragmentBaseFill(fragment);
  for (const cmd of fragment.commands) drawCommand(doc, cmd, x, y, baseFill);
  if (faded) doc.restore();
}

function fragmentBaseFill(fragment: PlacedFragment['fragment']): RGB | undefined {
  for (const cmd of fragment.commands) {
    if (cmd.op === 'fillRect' && cmd.y === 0 && cmd.h >= fragment.height - 0.01 && cmd.w > 0) return cmd.color;
  }
  return undefined;
}

function sameRGB(a: RGB, b: RGB): boolean {
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3;
}

/**
 * Register every anchor on this page as a named destination. pdfkit converts the
 * top-down y we pass into PDF's bottom-up coordinate space.
 */
function registerAnchors(doc: PDFDocument, page: Page): void {
  const target = doc as unknown as {
    addNamedDestination(name: string, ...args: unknown[]): void;
  };
  for (const a of page.anchors) target.addNamedDestination(a.name, 'XYZ', 0, a.y, null);
}

/**
 * Emit one PDF outline item per heading fragment. `PDFOutline.addItem` links to
 * the *current* page, so items are added page by page and their `Dest` is then
 * refined with the exact heading top (XYZ) for a precise jump.
 *
 * The open-ancestor stack lives on the document, not on the page: a heading on
 * page 2 must still nest under the chapter heading opened on page 1.
 */
const outlineStacks = new WeakMap<PDFDocument, Array<OutlineItem | undefined>>();

function addBookmarks(doc: PDFDocument, page: Page): void {
  if (page.outline.length === 0) return;
  const root = (doc as unknown as { outline: OutlineItem }).outline;
  if (!root) return;
  let stack = outlineStacks.get(doc);
  if (!stack) {
    stack = [];
    outlineStacks.set(doc, stack);
  }
  for (const entry of page.outline) {
    const level = Math.max(1, Math.min(6, entry.level));
    // Attach to the nearest open ancestor, not the exact level below: a heading
    // may legally jump from h1 straight to h3.
    let parent = root;
    for (let l = level - 1; l >= 1; l -= 1) {
      const candidate = stack[l];
      if (candidate) {
        parent = candidate;
        break;
      }
    }
    const item = parent.addItem(entry.title);
    const dest: [unknown, string, number, number, null] = [
      (doc as unknown as { page: { dictionary: unknown } }).page.dictionary,
      'XYZ',
      0,
      page.height - entry.y,
      null,
    ];
    (item as unknown as { outlineData: Record<string, unknown> }).outlineData.Dest = dest;
    stack.length = level + 1;
    stack[level] = item;
  }
}

interface OutlineItem {
  addItem(title: string): OutlineItem;
}

function drawCommand(doc: PDFDocument, cmd: DrawCommand, x: number, y: number, baseFill?: RGB): void {
  switch (cmd.op) {
    case 'fillRect':
      if (cmd.opacity !== undefined && cmd.opacity < 1) {
        doc.save();
        doc.fillOpacity(cmd.opacity);
        doc.fillColor(css(cmd.color)).rect(x + cmd.x, y + cmd.y, cmd.w, cmd.h).fill();
        doc.restore();
      } else {
        doc.fillColor(css(cmd.color)).rect(x + cmd.x, y + cmd.y, cmd.w, cmd.h).fill();
      }
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
    case 'poly': {
      const pts = cmd.points;
      if (pts.length < 2) return;
      doc.save();
      doc.moveTo(x + pts[0]![0], y + pts[0]![1]);
      for (let i = 1; i < pts.length; i += 1) doc.lineTo(x + pts[i]![0], y + pts[i]![1]);
      if (cmd.close) doc.closePath();
      if (cmd.fill && cmd.stroke) {
        // `f` consumes the path, so `fill()` then `stroke()` would silently drop
        // the outline. `B` paints both in one pass (pie/donut slice separators).
        // Round joins keep thin wedges from growing miter spikes at the centre.
        doc
          .lineWidth(cmd.stroke.lineWidth)
          .lineJoin('round')
          .fillColor(css(cmd.fill))
          .strokeColor(css(cmd.stroke.color));
        if (cmd.stroke.dash) applyDash(doc, cmd.stroke.dash);
        if (cmd.fillOpacity !== undefined) doc.fillOpacity(cmd.fillOpacity);
        doc.fillAndStroke(undefined, undefined, cmd.fillRule ?? 'nonzero');
        if (cmd.fillOpacity !== undefined) doc.fillOpacity(1);
      } else {
        if (cmd.fill) {
          if (cmd.fillOpacity !== undefined) doc.fillOpacity(cmd.fillOpacity);
          doc.fillColor(css(cmd.fill)).fill(cmd.fillRule ?? 'nonzero');
          if (cmd.fillOpacity !== undefined) doc.fillOpacity(1);
        }
        if (cmd.stroke) {
          doc.lineWidth(cmd.stroke.lineWidth).strokeColor(css(cmd.stroke.color));
          if (cmd.stroke.dash) applyDash(doc, cmd.stroke.dash);
          doc.stroke();
        }
      }
      doc.restore();
      return;
    }
    case 'path': {
      const rings = cmd.subpaths.filter((sp) => sp.points.length >= 2);
      if (rings.length === 0) return;
      doc.save();
      // Fill first: every ring is closed (SVG fills implicitly close) and they
      // share one path so `evenodd`/reverse-wound holes cancel correctly.
      if (cmd.fill) {
        for (const sp of rings) {
          doc.moveTo(x + sp.points[0]![0], y + sp.points[0]![1]);
          for (let i = 1; i < sp.points.length; i += 1) doc.lineTo(x + sp.points[i]![0], y + sp.points[i]![1]);
          doc.closePath();
        }
        if (cmd.fillOpacity !== undefined) doc.fillOpacity(cmd.fillOpacity);
        doc.fillColor(css(cmd.fill)).fill(cmd.fillRule ?? 'nonzero');
        if (cmd.fillOpacity !== undefined) doc.fillOpacity(1);
      }
      // Stroke second: honour each ring's own `closed` flag so an open
      // `<polyline>` outline does not gain a closing segment.
      if (cmd.stroke) {
        doc.lineWidth(cmd.stroke.lineWidth).strokeColor(css(cmd.stroke.color));
        if (cmd.stroke.dash) applyDash(doc, cmd.stroke.dash);
        for (const sp of rings) {
          doc.moveTo(x + sp.points[0]![0], y + sp.points[0]![1]);
          for (let i = 1; i < sp.points.length; i += 1) doc.lineTo(x + sp.points[i]![0], y + sp.points[i]![1]);
          if (sp.closed) doc.closePath();
          doc.stroke();
        }
      }
      doc.restore();
      return;
    }
    case 'text':
      drawText(doc, cmd, x, y, baseFill);
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
 *
 * A path string is refused while the host has disabled filesystem image sources
 * (`setImagePathAccess('deny')`): pdfkit opens path strings itself, so the policy
 * has to be enforced here as well as in `core/image.ts`.
 */
function imageSource(src: string | Uint8Array): string | Buffer {
  if (typeof src === 'string') {
    if (!imagePathAccessEnabled() && isFileSystemSource(src)) {
      throw new Error(
        `image source "${src}" is a filesystem path, which this host has disabled ` +
          '(setImagePathAccess("deny")); pass bytes, a data: URI, or an http(s) URL',
      );
    }
    return src;
  }
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

function drawText(
  doc: PDFDocument,
  cmd: Extract<DrawCommand, { op: 'text' }>,
  x: number,
  y: number,
  baseFill?: RGB,
): void {
  // Pass 1 — inline highlight backgrounds. Painted before any glyph so a
  // `<mark>` or badge fill can never cover the text it belongs to.
  let spacesBefore = 0;
  for (const run of cmd.runs) {
    const style = run.style;
    const penX = x + cmd.x + run.x + cmd.gapWidth * spacesBefore;
    if (style.backgroundColor !== undefined) {
      const bg = toRGB(style.backgroundColor);
      // Skip a run whose background is just the block fill (already painted).
      if (!baseFill || !sameRGB(bg, baseFill)) {
        const ascent = (style.handle.ascender / style.handle.unitsPerEm) * style.fontSize;
        const descent = -(style.handle.descender / style.handle.unitsPerEm) * style.fontSize;
        doc.save();
        if (style.opacity < 1) doc.fillOpacity(style.opacity);
        doc.fillColor(css(bg));
        doc.rect(penX, y + cmd.baselineY - ascent, Math.max(0.1, run.width), ascent + descent).fill();
        doc.restore();
      }
    }
    if (run.space) spacesBefore += 1;
  }

  // Pass 2 — glyphs, decorations and link rectangles.
  spacesBefore = 0;
  for (const run of cmd.runs) {
    const style = run.style;
    const fontName = style.handle.embeddedName ?? 'Helvetica';
    const ascent = (style.handle.ascender / style.handle.unitsPerEm) * style.fontSize;
    const descent = -(style.handle.descender / style.handle.unitsPerEm) * style.fontSize;
    const penX = x + cmd.x + run.x + cmd.gapWidth * spacesBefore;
    // pdfkit's text(x, y) treats y as the top of the line and internally offsets
    // by `ascender/1000 * size`. We want the visual baseline at `y + cmd.baselineY`,
    // so we hand pdfkit `baseline - ascent` and it re-adds the ascent itself.
    const pdfkitY = y + cmd.baselineY - ascent;

    if (style.opacity < 1) doc.save();
    if (style.opacity < 1) doc.fillOpacity(style.opacity);
    doc.font(fontName);
    doc.fontSize(style.fontSize);
    doc.fillColor(css(resolveRunColor(style.color, run)));
    const options: Record<string, unknown> = { lineBreak: false };
    if (style.features) options.features = style.features;
    if (style.letterSpacing) options.characterSpacing = style.letterSpacing;
    doc.text(run.text, penX, pdfkitY, options);
    if (style.opacity < 1) doc.restore();

    drawDecorations(doc, run, penX, y + cmd.baselineY, ascent);

    if (run.link && run.text.trim().length > 0) {
      const rectY = y + cmd.baselineY - ascent;
      const rectH = Math.max(1, ascent + descent);
      const rectW = Math.max(1, run.width);
      if (run.link.startsWith('#')) doc.goTo(penX, rectY, rectW, rectH, run.link.slice(1));
      else doc.link(penX, rectY, rectW, rectH, run.link);
    }
    if (run.space) spacesBefore += 1;
  }
}

function drawDecorations(doc: PDFDocument, run: PositionedRun, x: number, baselineY: number, ascent: number): void {
  const decs = run.style.decoration;
  if (!decs || decs.length === 0) return;
  const width = run.width;
  const weight = Math.max(0.5, run.style.fontSize / 18);
  doc.save();
  if (run.style.opacity < 1) doc.strokeOpacity(run.style.opacity);
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
