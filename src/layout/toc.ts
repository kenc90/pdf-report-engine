/**
 * Table-of-contents block.
 *
 * A TOC is the one block whose content depends on the pagination result, so it
 * is layout *twice* by the renderer: once with an empty entry list to establish
 * a baseline, then again with the headings and page numbers discovered by that
 * pass. `LayoutContext.tocEntries` carries the current snapshot; the renderer
 * iterates until the entry list (and therefore the TOC height) stops changing.
 *
 * Every row is drawn as a single `text` command carrying three absolutely
 * positioned runs (title, dot leader, page number), which keeps the page number
 * flush right no matter how the title measures or which fallback face it uses.
 */
import type { TocBlock } from '../ir/schema.js';
import type { ResolvedStyle } from '../text/style.js';
import { typeset, type PositionedRun } from '../text/typeset.js';
import type { LayoutContext } from './context.js';
import type { BlockLayoutOptions } from './block.js';
import { resolveBox } from './box.js';
import { resolveContent } from './context.js';
import type { DrawCommand, Fragment } from './flow.js';
import { toRGB } from '../core/color.js';

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

interface MeasuredLine {
  runs: PositionedRun[];
  width: number;
  /** True when the text had to wrap (and was truncated to its first line). */
  clipped: boolean;
}

function measureLine(text: string, style: ResolvedStyle): MeasuredLine {
  if (!text) return { runs: [], width: 0, clipped: false };
  const result = typeset([{ text, style }], UNBOUNDED);
  const line = result.lines[0];
  if (!line) return { runs: [], width: 0, clipped: false };
  return { runs: line.runs, width: line.width, clipped: result.lines.length > 1 };
}

/** Measure with a hard width budget, truncating with an ellipsis when needed. */
function measureClipped(text: string, style: ResolvedStyle, maxWidth: number): MeasuredLine {
  const full = measureLine(text, style);
  if (full.width <= maxWidth || maxWidth <= 0) return full;
  const result = typeset([{ text, style }], maxWidth);
  const line = result.lines[0];
  if (!line) return { runs: [], width: 0, clipped: true };
  // Append an ellipsis only when it still fits inside the budget.
  const ellipsis = measureLine('\u2026', style);
  const runs = [...line.runs];
  let width = line.width;
  if (width + ellipsis.width <= maxWidth && ellipsis.runs.length) {
    const last = runs[runs.length - 1];
    if (last) {
      runs[runs.length - 1] = { ...last, text: last.text + '\u2026', width: last.width + ellipsis.width };
    } else {
      runs.push({ ...ellipsis.runs[0]!, x: 0 });
    }
    width += ellipsis.width;
  }
  return { runs, width, clipped: true };
}

function shiftRuns(runs: PositionedRun[], dx: number, link?: string): PositionedRun[] {
  return runs.map((r) => {
    const next: PositionedRun = { ...r, x: r.x + dx };
    if (link) next.link = link;
    return next;
  });
}

export function layoutToc(block: TocBlock, ctx: LayoutContext, opts: BlockLayoutOptions, inherited: ResolvedStyle): Fragment[] {
  const style = ctx.style(block, inherited);
  const { margin, padding } = resolveBox(block);
  const left = margin.left + padding.left;
  const right = opts.contentWidth - margin.right - padding.right;
  const available = Math.max(1, right - left);

  const frags: Fragment[] = [];
  let pendingBefore = margin.top + padding.top;
  const addLine = (command: DrawCommand, height: number, gapAfter = 0): void => {
    const commands: DrawCommand[] = [];
    if (style.backgroundColor !== undefined) {
      commands.push({
        op: 'fillRect',
        x: 0,
        y: 0,
        w: opts.contentWidth - margin.left - margin.right,
        h: height,
        color: toRGB(style.backgroundColor),
      });
    }
    commands.push(command);
    frags.push({
      height,
      before: pendingBefore,
      after: gapAfter,
      commands,
      avoidSplit: true,
    });
    pendingBefore = 0;
  };

  // --- title ---------------------------------------------------------------
  if (block.title !== undefined) {
    const titleInline = resolveContent(block.title, ctx, style, opts.scope);
    const titleResult = typeset(titleInline, available);
    for (let i = 0; i < titleResult.lines.length; i += 1) {
      const line = titleResult.lines[i]!;
      addLine(
        {
          op: 'text',
          x: left,
          baselineY: line.ascent,
          runs: line.runs,
          gapWidth: 0,
          decorations: [],
        },
        line.height,
        i === titleResult.lines.length - 1 ? 6 : 0,
      );
    }
  }

  // --- entries -------------------------------------------------------------
  const maxLevel = block.maxLevel ?? 3;
  const entries = ctx.tocEntries.filter((e) => e.level <= maxLevel);
  const indent = block.indent ?? 12;
  const leaders = block.leaders !== false;
  const pageNumbers = block.pageNumbers !== false;
  const gap = block.gap ?? 4;

  for (const entry of entries) {
    const levelStyle = ctx.style({ fontWeight: entry.level === 1 ? 700 : 400 }, style);
    const x = left + Math.max(0, entry.level - 1) * indent;
    const page = pageNumbers ? measureLine(String(entry.page), levelStyle) : { runs: [], width: 0, clipped: false };

    const reserved = page.width > 0 ? page.width + gap : 0;
    const title = measureClipped(entry.title, levelStyle, Math.max(1, right - x - reserved));

    const runs: PositionedRun[] = shiftRuns(title.runs, x, entry.anchor ? `#${entry.anchor}` : undefined);

    if (leaders && page.width > 0) {
      const tail = x + title.width + 2;
      const dotsSpace = right - page.width - gap - tail;
      if (dotsSpace > 0) {
        const dot = measureLine('.', levelStyle);
        const count = dot.width > 0 ? Math.floor(dotsSpace / dot.width) : 0;
        if (count > 0) {
          const dots = measureLine('.'.repeat(count), levelStyle);
          runs.push(...shiftRuns(dots.runs, tail, entry.anchor ? `#${entry.anchor}` : undefined));
        }
      }
    }

    if (page.width > 0) {
      runs.push(...shiftRuns(page.runs, right - page.width, entry.anchor ? `#${entry.anchor}` : undefined));
    }

    const ascent = (levelStyle.handle.ascender / levelStyle.handle.unitsPerEm) * levelStyle.fontSize;
    addLine(
      { op: 'text', x: 0, baselineY: ascent, runs, gapWidth: 0, decorations: [] },
      levelStyle.lineHeight,
    );
  }

  if (frags.length === 0) {
    // Keep vertical rhythm (and the fixed-point loop stable) even when the
    // document has no headings yet.
    return [{ height: style.lineHeight, before: margin.top + padding.top, after: margin.bottom + padding.bottom, commands: [] }];
  }
  frags[frags.length - 1]!.after += margin.bottom + padding.bottom;
  return frags;
}


