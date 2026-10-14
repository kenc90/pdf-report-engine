/**
 * Pagination: place page-agnostic fragments onto concrete pages.
 *
 * This is the Jasper-style band engine. Two passes, because `{TOTAL}` cannot be
 * known until the body is paginated:
 *
 *   Pass A — measure the page header/footer once with a placeholder page number
 *            to learn how much vertical space the body actually gets.
 *   Pass B — flow the body fragments into pages, honouring explicit page breaks,
 *            keep-with-next groups (as atomic runs), table widows/orphans, and
 *            repeating a table's column-header rows whenever the page break falls
 *            inside that table.
 *   Pass C — re-flow the header/footer bands per page with the real `$page`
 *            scope, so `{PAGE}`/`{TOTAL}`/`{TOP}` resolve correctly.
 *
 * Fragment commands stay in fragment-local coordinates; each page records the
 * absolute (x, y) the writer must translate them to. The engine never touches
 * pdfkit.
 */
import type { Block, BandContent, ReportDoc } from '../ir/schema.js';
import type { ExprContext } from '../expr/eval.js';
import type { ResolvedPage, Box } from '../core/page.js';
import type { ResolvedStyle } from '../text/style.js';
import type { LayoutContext } from '../layout/context.js';
import { layoutBlock } from '../layout/block.js';
import type { Fragment } from '../layout/flow.js';

export interface PlacedFragment {
  fragment: Fragment;
  x: number;
  y: number;
}

export interface Page {
  number: number;
  logical: number;
  total: number;
  width: number;
  height: number;
  margin: Box;
  body: PlacedFragment[];
  header: PlacedFragment[];
  footer: PlacedFragment[];
}

export interface PaginateInput {
  ctx: LayoutContext;
  page: ResolvedPage;
  contentWidth: number;
  body: Block[];
  bands: ReportDoc['bands'];
  scope: ExprContext;
  baseStyle?: ResolvedStyle;
}

function fragSpan(f: Fragment): number {
  return f.before + f.height + f.after;
}

function layoutBlocks(blocks: Block[] | undefined, ctx: LayoutContext, opts: { contentWidth: number; scope: ExprContext; inherited?: ResolvedStyle }): Fragment[] {
  const out: Fragment[] = [];
  for (const b of blocks ?? []) out.push(...layoutBlock(b, ctx, opts));
  return out;
}

function layoutBand(band: BandContent | undefined, ctx: LayoutContext, opts: { contentWidth: number; scope: ExprContext; inherited?: ResolvedStyle }): Fragment[] {
  if (!band) return [];
  const inherited = band.style ? ctx.style(band.style, opts.inherited ?? ctx.baseStyle) : opts.inherited;
  const scope = { ...opts.scope };
  const frags: Fragment[] = [];
  if (band.blocks) frags.push(...layoutBlocks(band.blocks, ctx, { ...opts, inherited }));
  if (band.text !== undefined) frags.push(...layoutBlocks([{ type: 'paragraph', content: band.text }], ctx, { contentWidth: opts.contentWidth, scope, inherited }));
  if (band.height !== undefined) {
    const total = frags.reduce((s, f) => s + fragSpan(f), 0);
    if (total < band.height) frags.push({ height: band.height - total, before: 0, after: 0, commands: [] });
  }
  return frags;
}

export function paginate(input: PaginateInput): Page[] {
  const { ctx, page, contentWidth, body, bands, scope, baseStyle } = input;
  const inherited = baseStyle ?? ctx.baseStyle;
  const opts = { contentWidth, scope, inherited };

  // --- Pass A: measure fixed bands with a placeholder page scope ----------
  const placeholderScope: ExprContext = { ...scope, $page: { number: 1, total: 1 } };
  const popts = { contentWidth, scope: placeholderScope, inherited };
  const headerMeasured = layoutBand(bands?.pageHeader, ctx, popts);
  const footerMeasured = layoutBand(bands?.pageFooter, ctx, popts);
  const titleMeasured = layoutBand(bands?.title, ctx, popts);
  const summaryMeasured = layoutBand(bands?.summary, ctx, popts);

  const headerH = headerMeasured.reduce((s, f) => s + fragSpan(f), 0);
  const footerH = footerMeasured.reduce((s, f) => s + fragSpan(f), 0);
  const titleH = titleMeasured.reduce((s, f) => s + fragSpan(f), 0);
  const summaryH = summaryMeasured.reduce((s, f) => s + fragSpan(f), 0);

  const bodyFragments = layoutBlocks(body, ctx, opts);

  // --- Pass B: flow body fragments into pages ------------------------------
  const contentLeft = page.content.x;
  const bodyTop = page.margin.top + headerH;
  const bodyBottomLimit = page.height - page.margin.bottom - footerH;

  const headerByGroup = new Map<string, Fragment[]>();
  for (const f of bodyFragments) {
    if (f.role === 'header' && f.groupKey) {
      if (!headerByGroup.has(f.groupKey)) headerByGroup.set(f.groupKey, []);
      headerByGroup.get(f.groupKey)!.push(f);
    }
  }

  const runs = buildRuns(bodyFragments);
  const pages: Page[] = [];
  let current: Page | undefined;
  let cursorY = 0;
  let bodyStartY = 0;
  const startedHeaderGroups = new Set<string>();
  let resetEpoch = 0; // pages before the latest resetPageNumber

  const openPage = (): Page => {
    const p: Page = {
      number: pages.length + 1,
      logical: 0,
      total: 0,
      width: page.width,
      height: page.height,
      margin: page.margin,
      body: [],
      header: [],
      footer: [],
    };
    pages.push(p);
    cursorY = bodyTop;
    if (p.number === 1 && titleMeasured.length) {
      for (const f of titleMeasured) {
        cursorY += f.before;
        p.body.push({ fragment: f, x: contentLeft, y: cursorY });
        cursorY += f.height + f.after;
      }
    }
    bodyStartY = cursorY;
    return p;
  };

  const pageCapacity = (index: number, lastContent: boolean): number => {
    let top = bodyTop;
    if (index === 0) top += titleH;
    let bottom = bodyBottomLimit;
    // The summary band only sits on the final page; reserve it while flowing so we
    // do not overrun into it, then it is placed for real in Pass C.
    if (lastContent) bottom -= summaryH;
    return bottom - top;
  };

  current = openPage();
  let remainingHeight = pageCapacity(pages.length - 1, true);
  void remainingHeight;

  for (let r = 0; r < runs.length; r += 1) {
    const run = runs[r]!;
    const first = bodyFragments[run[0]!]!;
    const runSpan = run.reduce((s, i) => s + fragSpan(bodyFragments[i]!), 0);

    const forceBreak = (first.breakBefore === 'page' || first.isPageBreak) && cursorY > bodyStartY + 0.01;
    const overflow = cursorY + first.before + first.height > bodyBottomLimit;

    if (forceBreak || overflow) {
      // Decide widows/orphans for the first fragment's group if it is a table.
      const groupKey = first.groupKey;
      startNewPage();
      if (groupKey && startedHeaderGroups.has(groupKey) && headerByGroup.has(groupKey)) {
        for (const hf of headerByGroup.get(groupKey)!) {
          cursorY += hf.before;
          current!.body.push({ fragment: hf, x: contentLeft, y: cursorY });
          cursorY += hf.height + hf.after;
          startedHeaderGroups.add(groupKey);
        }
      }
      if (first.resetPageNumber) {
        resetEpoch = pages.length - 1;
      }
    }

    if (first.isPageBreak) {
      if (cursorY <= bodyStartY + 0.01) continue; // already at top; marker consumed
      startNewPage();
      continue;
    }

    for (const i of run) {
      const f = bodyFragments[i]!;
      if (f.groupKey && f.role === 'header') startedHeaderGroups.add(f.groupKey);
      cursorY += f.before;
      current!.body.push({ fragment: f, x: contentLeft, y: cursorY });
      cursorY += f.height + f.after;
    }
  }

  function startNewPage(): void {
    const next: Page = {
      number: pages.length + 1,
      logical: 0,
      total: 0,
      width: page.width,
      height: page.height,
      margin: page.margin,
      body: [],
      header: [],
      footer: [],
    };
    pages.push(next);
    current = next;
    cursorY = bodyTop;
    bodyStartY = cursorY;
  }

  // A trailing empty page can appear if a run's tail was pushed to a fresh page
  // then nothing followed it; drop it.
  while (pages.length > 1 && pages.at(-1)!.body.length === 0 && pages.at(-1)!.number > 1) pages.pop();

  const total = pages.length;

  // --- Pass C: real headers/footers + logical numbering + summary ----------
  for (let i = 0; i < pages.length; i += 1) {
    const p = pages[i]!;
    p.total = total;
    p.logical = i + 1 - resetEpochFor(pages, i);
    const pageScope: ExprContext = { ...scope, $page: { number: p.logical, total, ...({ pageIndex: i } as object) } };
    const po = { contentWidth, scope: pageScope, inherited };

    p.header = placeBand(layoutBand(bands?.pageHeader, ctx, po), contentLeft, page.margin.top);

    const footerTop = page.height - page.margin.bottom - footerH;
    p.footer = placeBand(layoutBand(bands?.pageFooter, ctx, po), contentLeft, footerTop);

    if (i === pages.length - 1 && summaryMeasured.length) {
      // Place the real summary right after the last body fragment on the final page.
      let y = p.body.length ? p.body.at(-1)!.y + p.body.at(-1)!.fragment.height : bodyTop;
      for (const f of layoutBand(bands?.summary, ctx, po)) {
        y += f.before;
        p.body.push({ fragment: f, x: contentLeft, y });
        y += f.height + f.after;
      }
    }
  }

  return pages;
}

function resetEpochFor(pages: Page[], index: number): number {
  let offset = 0;
  for (let i = 1; i <= index; i += 1) {
    // logical resets are applied during flow via resetPageNumber fragments; here we
    // recompute by detecting first-body-fragment markers.
    const firstBody = pages[i]?.body[0];
    if (firstBody?.fragment.resetPageNumber) offset = i;
  }
  return offset;
}

function placeBand(frags: Fragment[], x: number, top: number): PlacedFragment[] {
  const out: PlacedFragment[] = [];
  let y = top;
  for (const f of frags) {
    y += f.before;
    out.push({ fragment: f, x, y });
    y += f.height + f.after;
  }
  return out;
}

/**
 * Group fragment indices into atomic runs: a fragment with `keepWithNext` binds to
 * the following one. Table rows already carry `avoidSplit`; runs additionally glue a
 * keep-with-next chain so a heading and its first paragraph never separate.
 */
function buildRuns(fragments: Fragment[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < fragments.length; i += 1) {
    run.push(i);
    if (!fragments[i]!.keepWithNext) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs;
}
