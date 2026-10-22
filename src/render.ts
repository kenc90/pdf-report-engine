/**
 * The public render pipeline: ReportDoc -> pages -> PDF bytes.
 *
 * `createReport` returns the live pdfkit document plus the paginated model, so a
 * caller can add their own content or stream incrementally. `renderToBuffer` is
 * the one-shot convenience wrapper.
 */
import PDFDocument from 'pdfkit';
import { resolvePage } from './core/page.js';
import { FontRegistry, type FontSource } from './fonts/registry.js';
import { resolveStyle } from './text/style.js';
import { LayoutContext, type TocEntry } from './layout/context.js';
import { ExprCompiler } from './expr/eval.js';
import { createFunctions } from './expr/functions.js';
import { paginate, type Page } from './pagination/engine.js';
import { writePage } from './writer/pdfkit-writer.js';
import { resolveRemoteImages, type ImageResolveOptions } from './core/remote-image.js';
import { resolveRemoteFonts, type FontResolveOptions } from './fonts/remote.js';
import type { ReportDoc, StyleProps } from './ir/schema.js';
import type { ResolvedStyle } from './text/style.js';
import type { ExprContext } from './expr/eval.js';

type PDFKitDoc = PDFKit.PDFDocument;

export interface RenderOptions {
  /** Font programs to embed. Without them only the standard PDF fonts render. */
  fonts?: FontSource[];
  /** Injectable clock for `now()` in expressions (deterministic tests). */
  now?: () => Date;
  /** Overrides the document's base style before inheritance. */
  baseStyle?: Partial<StyleProps>;
  /**
   * Keep every page's content in memory until `doc.end()` (pdfkit's `bufferPages`).
   *
   * Default `true`, which is what the engine has always done: pdfkit holds each page's
   * encoded stream in its page buffer and flushes only when the document ends, so
   * nothing is written out until the whole document is assembled. That is required
   * if a caller wants to revisit pages (`switchToPage`, `bufferedPageRange`).
   *
   * Hosts that write pages out once and never look back — notably servers piping the
   * finished document straight to a response — can pass `false` to have pdfkit flush
   * each page as the next one starts: the encoded page stream then leaves memory
   * instead of accumulating into a second full copy of the document, giving lower
   * peak memory and earlier first bytes. This engine writes pages strictly in order
   * and never revisits one (TOC/page cross-references are resolved by re-paginating
   * before any writing), so `false` is safe for it.
   */
  bufferPages?: boolean;
  /** How `http(s)` image sources are handled (used by the async {@link renderToBuffer}). */
  images?: ImageResolveOptions;
  /**
   * How remote font references (`report.fonts`: Google Fonts links, `@font-face`,
   * font URLs) are resolved into embedded faces. Used by the async
   * {@link renderToBuffer}; ignored by the synchronous {@link createReport} — call
   * `resolveRemoteFonts` yourself and pass the result in `fonts` when streaming.
   */
  resolveFonts?: FontResolveOptions;
}

export interface RenderResult {
  doc: PDFKitDoc;
  pages: Page[];
  registry: FontRegistry;
}

const DEFAULT_BASE: StyleProps = { fontFamily: 'Helvetica', fontSize: 11 };

export function createReport(report: ReportDoc, options: RenderOptions = {}): RenderResult {
  const page = resolvePage(report.page);
  const doc: PDFKitDoc = new PDFDocument({
    size: [page.width, page.height],
    margin: 0,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    autoFirstPage: false,
    bufferPages: options.bufferPages ?? true,
    info: toPdfInfo(report),
  });

  const registry = new FontRegistry();
  if (options.fonts?.length) registry.registerAll(doc, options.fonts);

  const baseStyle: ResolvedStyle = resolveStyle(
    { ...DEFAULT_BASE, ...options.baseStyle, ...report.style },
    registry,
    undefined,
  );

  const compiler = new ExprCompiler(createFunctions({ now: options.now }));
  const ctx = new LayoutContext({
    registry,
    baseStyle,
    data: report.data,
    vars: report.variables,
    compiler,
  });

  const scope: ExprContext = {
    $data: report.data,
    $report: report.data,
    $vars: report.variables,
  };

  // A TOC needs the page numbers that only exist after pagination, while its own
  // height affects those numbers. Iterate until the entry list stops changing
  // (bounded so a pathological document cannot loop forever).
  let pages: Page[] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    pages = paginate({
      ctx,
      page,
      contentWidth: page.content.width,
      body: report.body ?? [],
      bands: report.bands,
      scope,
      baseStyle,
    });
    const entries = collectTocEntries(pages);
    if (sameEntries(ctx.tocEntries, entries)) break;
    ctx.tocEntries = entries;
  }

  for (const p of pages) writePage(doc, p, { outline: report.outline });

  return { doc, pages, registry };
}

/** Flatten the paginated outline into the rows a `toc` block renders. */
function collectTocEntries(pages: Page[]): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const page of pages) {
    for (const entry of page.outline) {
      entries.push({ level: entry.level, title: entry.title, page: entry.logical, anchor: entry.anchor });
    }
  }
  return entries;
}

function sameEntries(a: TocEntry[], b: TocEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.level !== y.level || x.page !== y.page || x.title !== y.title || x.anchor !== y.anchor) return false;
  }
  return true;
}

/** Render to bytes (collects the stream). Resolves remote images and fonts first. */
export async function renderToBuffer(report: ReportDoc, options: RenderOptions = {}): Promise<Buffer> {
  const resolved = await resolveRemoteImages(report, options.images);
  // Turn declarative font references (Google `<link>`/`@import`, `@font-face`,
  // font URLs) into embedded faces and append them to any explicitly supplied
  // `fonts`. A failed remote font is skipped (not fatal) by default.
  let effective = options;
  if (report.fonts?.length) {
    const remoteFonts = await resolveRemoteFonts(resolved, options.resolveFonts);
    if (remoteFonts.length) effective = { ...options, fonts: [...(options.fonts ?? []), ...remoteFonts] };
  }
  const { doc } = createReport(resolved, effective);
  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (c: Uint8Array) => chunks.push(c));
    doc.on('end', () => resolve(concatChunks(chunks)));
    doc.on('error', reject);
  });
}

/**
 * Join streamed chunks into one buffer. In Node this returns a real `Buffer`
 * (so callers can `.toString('latin1')` etc.); in a browser bundle there is no
 * global `Buffer`, so we fall back to plain `Uint8Array` bytes (wrap in a `Blob`).
 */
function concatChunks(chunks: Uint8Array[]): Buffer {
  const g = (globalThis as { Buffer?: { concat: (c: Uint8Array[]) => Buffer } }).Buffer;
  if (g && typeof g.concat === 'function') return g.concat(chunks);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out as unknown as Buffer;
}

function toPdfInfo(report: ReportDoc): Record<string, string> {
  const info = report.info ?? {};
  const out: Record<string, string> = { Creator: 'pdf-report-engine', Producer: 'pdf-report-engine' };
  if (typeof info.title === 'string') out.Title = info.title;
  if (info.author) out.Author = info.author;
  if (info.subject) out.Subject = info.subject;
  if (info.keywords) out.Keywords = info.keywords;
  if (info.creator) out.Creater = info.creator;
  if (info.producer) out.Producer = info.producer;
  return out;
}

