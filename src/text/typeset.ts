/**
 * Typesetting: turn styled inline text into measured, wrapped lines.
 *
 * This is the engine half of todo a4. It consumes `findBreaks` (UAX #14 subset)
 * for *where* a line may break and a `FontHandle` for *how wide* each run is,
 * then greedily fills lines to a pixel-exact budget and resolves alignment.
 *
 * Two invariants make the rest of the pipeline trustworthy:
 *  - widths come from `FontHandle.widthOf`, the same code path pdfkit paints
 *    with, so a wrapped line cannot overflow when it is drawn;
 *  - a line's stored width is recomputed from its positioned runs at flush time,
 *    never trusted from the incremental estimate used during packing.
 *
 * Rich text (multiple styles in one paragraph) is handled by carrying, for every
 * code point, which inline it came from, so break tokens can be split back into
 * per-run pieces at paint time.
 */
import { findBreaks, type BreakToken } from './linebreak.js';
import type { ResolvedStyle } from './style.js';
import type { FontHandle } from '../fonts/registry.js';

export interface InlineSource {
  text: string;
  style: ResolvedStyle;
  /**
   * Hyperlink target: an external URL (`https:`, `mailto:`, …) or an internal
   * destination (`#anchor`). Every run produced from this inline carries it.
   */
  link?: string;
  /**
   * Per-glyph fallback: given a code point, return the face that should render it
   * (the primary when it covers the glyph, else a registered substitute). When
   * absent the style's own fallback is used, and when *that* is absent every code
   * point uses `style.handle` (the pre-fallback behaviour, and what deterministic
   * tests rely on).
   */
  fallback?: (ch: string) => FontHandle;
}

export interface PositionedRun {
  /** Printable glyphs; soft hyphens that did not end a line are dropped here. */
  text: string;
  style: ResolvedStyle;
  /** Offset from the line's content box left edge, in points. */
  x: number;
  width: number;
  /** True when the whole run is spaces — the writer spreads these when justified. */
  space?: boolean;
  /** Hyperlink target carried from the inline source (URL or `#anchor`). */
  link?: string;
}

export interface Line {
  runs: PositionedRun[];
  /** Ink width (excludes any hanging trailing space). */
  width: number;
  /** Line box height (leading included). */
  height: number;
  ascent: number;
  descent: number;
  /** Ended by an explicit newline rather than by wrapping. */
  hard: boolean;
  /** True when the line was broken at a soft hyphen (`-` was printed). */
  hyphenated: boolean;
  /** Number of inter-word spaces, used for justification. */
  spaceCount: number;
  /** Extra width to add to each space when justified. */
  gapWidth: number;
}

export interface TypesetResult {
  lines: Line[];
  maxLineWidth: number;
  totalHeight: number;
}

interface MeasuredToken {
  token: BreakToken;
  /** Code points of this token, each tagged with the inline it belongs to. */
  chars: CharRef[];
  width: number;
}

interface CharRef {
  ch: string;
  run: number;
}

/** Apply CSS `text-transform` to a literal string. */
export function transformText(text: string, mode: ResolvedStyle['textTransform']): string {
  switch (mode) {
    case 'uppercase':
      return text.toLocaleUpperCase();
    case 'lowercase':
      return text.toLocaleLowerCase();
    case 'capitalize':
      return text.replace(/(^|\s|[^\p{L}])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase());
    default:
      return text;
  }
}

function isSpaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function ascentOf(s: ResolvedStyle): number {
  return (s.handle.ascender / s.handle.unitsPerEm) * s.fontSize;
}

function descentOf(s: ResolvedStyle): number {
  return -(s.handle.descender / s.handle.unitsPerEm) * s.fontSize;
}

/** The face a single code point should render in, honouring per-glyph fallback. */
function runHandle(src: InlineSource, ch: string): FontHandle {
  // An inline may override the stack-aware fallback its style carries.
  const fallback = src.fallback ?? src.style.fallback;
  return fallback ? fallback(ch) : src.style.handle;
}

/** Width of a slice of tagged code points, summed per owning inline *and* face. */
function measureChars(chars: CharRef[], inlines: InlineSource[]): number {
  let total = 0;
  let i = 0;
  while (i < chars.length) {
    const run = chars[i]!.run;
    const src = inlines[run]!;
    const face = runHandle(src, chars[i]!.ch);
    const style = src.style;
    let sub = '';
    let count = 0;
    let j = i;
    while (j < chars.length && chars[j]!.run === run && runHandle(src, chars[j]!.ch) === face) {
      sub += chars[j]!.ch;
      count += 1;
      j += 1;
    }
    total += face.widthOf(sub, style.fontSize, style.features) + style.letterSpacing * count;
    i = j;
  }
  return total;
}

interface Normalized {
  chars: CharRef[];
  inlines: InlineSource[];
  /** Break behaviour requested by the whitespace mode of the paragraph. */
  allowBreak: boolean;
  anywhere: boolean;
}

/**
 * Collapse whitespace and flatten every inline into one code-point stream with
 * per-character provenance. The paragraph's `whiteSpace` (taken from the first
 * inline — mixed modes within a paragraph are not meaningful) drives:
 *   normal:  runs of whitespace -> one space; newlines are soft (breakable);
 *   pre-wrap: spaces and newlines preserved, wrapping still allowed;
 *   nowrap:  whitespace collapses and the paragraph never wraps.
 */
function normalize(inlines: InlineSource[]): Normalized {
  const mode = inlines[0]?.style.whiteSpace ?? 'normal';
  const collapse = mode === 'normal' || mode === 'nowrap';
  const allowBreak = mode !== 'nowrap';

  const chars: CharRef[] = [];
  let lastWasSpace = false;
  for (let r = 0; r < inlines.length; r += 1) {
    const style = inlines[r]!.style;
    const text = transformText(inlines[r]!.text, style.textTransform);
    for (const ch of Array.from(text)) {
      if (collapse && isSpaceChar(ch)) {
        if (chars.length === 0) {
          lastWasSpace = true;
          continue;
        }
        if (lastWasSpace) continue;
        chars.push({ ch: ' ', run: r });
        lastWasSpace = true;
        continue;
      }
      chars.push({ ch, run: r });
      lastWasSpace = false;
    }
  }
  return { chars, inlines, allowBreak, anywhere: false };
}

function charAt(chars: CharRef[], index: number, codePointLen: number): CharRef[] {
  return chars.slice(index, index + codePointLen);
}

/** Measure every break token against the flattened character stream. */
function measureTokens(text: string, norm: Normalized): MeasuredToken[] {
  const tokens = findBreaks(text, { anywhere: norm.anywhere });
  const out: MeasuredToken[] = [];
  let pos = 0;
  for (const token of tokens) {
    const len = Array.from(token.text).length;
    const slice = charAt(norm.chars, pos, len);
    pos += len;
    // Soft hyphens are invisible unless the line breaks there, so they measure 0.
    const width = token.softHyphen ? 0 : measureChars(slice, norm.inlines);
    out.push({ token, chars: slice, width });
  }
  return out;
}

/** Split one over-long, unbreakable token into <=maxWidth pieces. */
function emergencySplit(mt: MeasuredToken, maxWidth: number, inlines: InlineSource[]): MeasuredToken[] {
  const pieces: MeasuredToken[] = [];
  let bucket: CharRef[] = [];
  let w = 0;
  for (const ref of mt.chars) {
    const src = inlines[ref.run]!;
    const style = src.style;
    const face = runHandle(src, ref.ch);
    const cw = face.widthOf(ref.ch, style.fontSize, style.features) + style.letterSpacing;
    if (bucket.length && w + cw > maxWidth) {
      pieces.push({ token: mt.token, chars: bucket, width: w });
      bucket = [];
      w = 0;
    }
    bucket.push(ref);
    w += cw;
  }
  if (bucket.length) pieces.push({ token: mt.token, chars: bucket, width: w });
  return pieces;
}

interface FlushInput {
  line: MeasuredToken[];
  hard: boolean;
  maxWidth: number;
  inlines: InlineSource[];
}

/** Turn committed tokens into a final `Line`, re-rendering runs and recomputing width. */
function flush(input: FlushInput): Line {
  const { line, hard, inlines } = input;
  // A soft hyphen at the tail of a *wrapped* (not hard) line becomes a printed `-`.
  let hyphenated = false;
  const last = line[line.length - 1];
  if (!hard && last && last.token.softHyphen) {
    hyphenated = true;
  }

  // Flatten committed tokens to printable (ch, run) pairs, splitting runs cleanly.
  const printable: CharRef[] = [];
  let spaceCount = 0;
  for (let i = 0; i < line.length; i += 1) {
    const mt = line[i]!;
    if (mt.token.space) {
      // Interior spaces print as a single space; a trailing space is already dropped
      // by the packer so it never reaches here.
      printable.push(...mt.chars);
      spaceCount += 1;
      continue;
    }
    if (mt.token.softHyphen) {
      if (hyphenated && i === line.length - 1) printable.push({ ch: '-', run: mt.chars[0]?.run ?? 0 });
      continue; // otherwise invisible
    }
    printable.push(...mt.chars);
  }

  // Group consecutive code points that share an inline into positioned runs,
  // splitting at spaces so the writer can inject justification gaps between
  // words (a run whose whole text is spaces is a word separator).
  const runs: PositionedRun[] = [];
  let x = 0;
  let i = 0;
  while (i < printable.length) {
    const run = printable[i]!.run;
    const src = inlines[run]!;
    const isSpace = printable[i]!.ch === ' ';
    const face = runHandle(src, printable[i]!.ch);
    let text = '';
    let count = 0;
    let j = i;
    while (
      j < printable.length &&
      printable[j]!.run === run &&
      (printable[j]!.ch === ' ') === isSpace &&
      runHandle(src, printable[j]!.ch) === face
    ) {
      text += printable[j]!.ch;
      count += 1;
      j += 1;
    }
    const style = src.style;
    const width = face.widthOf(text, style.fontSize, style.features) + style.letterSpacing * count;
    // Carry the chosen face on a cloned style so the writer measures and paints
    // this sub-run with the very font used here (measurement == rendering).
    const runStyle: ResolvedStyle = face === style.handle ? style : { ...style, handle: face };
    const posRun: PositionedRun = { text, style: runStyle, x, width, space: isSpace };
    if (src.link) posRun.link = src.link;
    runs.push(posRun);
    x += width;
    i = j;
  }

  const width = x;
  let height = 0;
  let ascent = 0;
  let descent = 0;
  for (const r of runs) {
    height = Math.max(height, r.style.lineHeight);
    ascent = Math.max(ascent, ascentOf(r.style));
    descent = Math.max(descent, descentOf(r.style));
  }
  const fallback = inlines[0]?.style;
  if (runs.length === 0 && fallback) {
    height = fallback.lineHeight;
    ascent = ascentOf(fallback);
    descent = descentOf(fallback);
  }

  return { runs, width, height, ascent, descent, hard, hyphenated, spaceCount, gapWidth: 0 };
}

export interface TypesetOptions {
  /** Override paragraph `align` (e.g. a table column's alignment). */
  align?: ResolvedStyle['align'];
}

/**
 * Wrap styled inline text into lines that fit `maxWidth`.
 *
 * Greedy fill: this is intentionally not Knuth–Plass. Reports value predictability
 * and speed over optimal raggedness; greedy keeps tabular columns aligned and
 * runs in O(tokens) per paragraph.
 */
export function typeset(inlines: InlineSource[], maxWidth: number, options: TypesetOptions = {}): TypesetResult {
  const filtered = inlines.filter((i) => i.text.length > 0);
  if (filtered.length === 0) {
    return { lines: [], maxLineWidth: 0, totalHeight: 0 };
  }

  const norm = normalize(filtered);
  const text = norm.chars.map((c) => c.ch).join('');
  const measured = measureTokens(text, norm);

  // Any single token that cannot fit even on an empty line is pre-split into
  // width-respecting pieces (break-all fallback). Doing this up front means the
  // greedy packer below never has to special-case an over-long word.
  const queue: MeasuredToken[] = [];
  for (const mt of measured) {
    if (norm.allowBreak && !mt.token.space && mt.width > maxWidth && mt.chars.length > 1) {
      queue.push(...emergencySplit(mt, maxWidth, filtered));
    } else {
      queue.push(mt);
    }
  }

  const align = options.align ?? filtered[0]!.style.align;

  const lines: Line[] = [];
  let line: MeasuredToken[] = [];
  let width = 0;
  let pendingSpace: MeasuredToken | undefined;

  const commit = (hard: boolean): void => {
    if (line.length === 0) {
      if (hard) {
        // An explicit empty line: emit a blank line box so vertical rhythm is kept.
        lines.push(flush({ line: [], hard, maxWidth, inlines: filtered }));
      }
      return;
    }
    lines.push(flush({ line, hard, maxWidth, inlines: filtered }));
    line = [];
    width = 0;
  };

  for (const mt of queue) {
    const t = mt.token;

    if (t.hard) {
      commit(true);
      pendingSpace = undefined;
      continue;
    }

    if (t.space) {
      if (line.length === 0) continue; // drop leading space on a fresh line
      pendingSpace = mt;
      continue;
    }

    const tentative = width + (pendingSpace ? pendingSpace.width : 0) + mt.width;
    if (line.length > 0 && norm.allowBreak && tentative > maxWidth + 0.01) {
      commit(false);
      pendingSpace = undefined;
      line = [mt];
      width = mt.width;
      continue;
    }

    if (pendingSpace) {
      line.push(pendingSpace);
      width += pendingSpace.width;
      pendingSpace = undefined;
    }
    line.push(mt);
    width += mt.width;
  }

  commit(false);

  applyAlignment(lines, maxWidth, align);

  const maxLineWidth = lines.reduce((m, l) => Math.max(m, l.width), 0);
  const totalHeight = lines.reduce((s, l) => s + l.height, 0);
  return { lines, maxLineWidth, totalHeight };
}

/** Position each line horizontally and pre-compute justification gaps. */
function applyAlignment(lines: Line[], maxWidth: number, align: ResolvedStyle['align']): void {
  const last = lines.length - 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let shift = 0;
    if (align === 'center') shift = (maxWidth - line.width) / 2;
    else if (align === 'right') shift = maxWidth - line.width;
    else if (align === 'justify' && i !== last && !line.hard && line.spaceCount > 0) {
      line.gapWidth = (maxWidth - line.width) / line.spaceCount;
    }
    if (shift !== 0) for (const run of line.runs) run.x += shift;
  }
}
