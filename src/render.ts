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
import { LayoutContext } from './layout/context.js';
import { ExprCompiler } from './expr/eval.js';
import { createFunctions } from './expr/functions.js';
import { paginate, type Page } from './pagination/engine.js';
import { writePage } from './writer/pdfkit-writer.js';
import { resolveRemoteImages, type ImageResolveOptions } from './core/remote-image.js';
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
  /** How `http(s)` image sources are handled (used by the async {@link renderToBuffer}). */
  images?: ImageResolveOptions;
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
    bufferPages: true,
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

  const pages = paginate({
    ctx,
    page,
    contentWidth: page.content.width,
    body: report.body ?? [],
    bands: report.bands,
    scope,
    baseStyle,
  });

  for (const p of pages) writePage(doc, p);

  addOutline(doc, report);

  return { doc, pages, registry };
}

/** Render to a Buffer (collects the stream). Resolves any remote images first. */
export async function renderToBuffer(report: ReportDoc, options: RenderOptions = {}): Promise<Buffer> {
  const resolved = await resolveRemoteImages(report, options.images);
  const { doc } = createReport(resolved, options);
  doc.end();
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
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

/**
 * Build a PDF outline from heading blocks. We walk the already-paginated model so
 * each entry points at the correct page; the y is the fragment's placed top.
 */
function addOutline(doc: PDFKitDoc, report: ReportDoc): void {
  void doc;
  void report;
  // Outline emission is deferred: it needs heading fragments tagged during layout,
  // which the demo does not yet require. Wired in when `{TOP}`/bookmarks land.
}
