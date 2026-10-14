/**
 * Wrapping engine tests. Uses `HeuristicFontHandle` (Latin 0.5em, CJK 1em,
 * space 0.28em) so every expected width is hand-computable and the assertions
 * are deterministic without any font binary on disk.
 */
import { describe, expect, it } from 'vitest';
import { HeuristicFontHandle, type FontHandle } from '../src/fonts/registry.js';
import type { ResolvedStyle } from '../src/text/style.js';
import { typeset, type InlineSource, type Line } from '../src/text/typeset.js';

function style(partial: Partial<ResolvedStyle> = {}): ResolvedStyle {
  const handle: FontHandle = new HeuristicFontHandle();
  const fontSize = partial.fontSize ?? 10;
  return {
    handle,
    fontSize,
    lineHeight: partial.lineHeight ?? 12,
    letterSpacing: 0,
    align: 'left',
    verticalAlign: 'top',
    whiteSpace: 'normal',
    textTransform: 'none',
    color: [0, 0, 0],
    backgroundColor: undefined,
    features: undefined,
    decoration: [],
    ...partial,
  };
}

const inline = (text: string, partial: Partial<ResolvedStyle> = {}): InlineSource => ({
  text,
  style: style(partial),
});

const textOf = (l: Line): string => l.runs.map((r) => r.text).join('');

describe('typeset', () => {
  it('wraps at spaces and drops the hanging space', () => {
    // "aaa"=15, " "=2.8, "bbb"=15 -> 32.8 total; budget 20 fits one word.
    const r = typeset([inline('aaa bbb')], 20);
    expect(r.lines.map(textOf)).toEqual(['aaa', 'bbb']);
    expect(r.lines[0]!.width).toBeCloseTo(15, 3);
  });

  it('keeps a single unbreakable word on its own line when it fits', () => {
    const r = typeset([inline('aaaa')], 20); // 4*5 = 20
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.width).toBeCloseTo(20, 3);
  });

  it('splits an over-long word as a last resort', () => {
    const r = typeset([inline('aaaaaaaa')], 25); // 8 chars * 5 = 40 > 25
    expect(r.lines.length).toBeGreaterThanOrEqual(2);
    for (const l of r.lines) expect(l.width).toBeLessThanOrEqual(25.001);
  });

  it('honours explicit newlines as hard breaks and keeps blank lines', () => {
    // Newlines are only "hard" when whitespace is preserved (pre-wrap); in
    // normal mode a source newline is just collapsible space.
    const r = typeset([inline('a\n\nb', { whiteSpace: 'pre-wrap' })], 100);
    expect(r.lines.map(textOf)).toEqual(['a', '', 'b']);
    expect(r.lines.map((l) => l.hard)).toEqual([true, true, false]);
  });

  it('breaks between ideographic characters', () => {
    // Each CJK glyph is 1em = 10pt; budget 25 => at most 2 glyphs/line.
    const r = typeset([inline('一二三四五')], 25);
    expect(r.lines.map(textOf)).toEqual(['一二', '三四', '五']);
  });

  it('collapses whitespace runs in normal mode but preserves them in pre-wrap', () => {
    const collapsed = typeset([inline('a   b')], 100);
    expect(textOf(collapsed.lines[0]!)).toBe('a b');
    const preserved = typeset([inline('a   b', { whiteSpace: 'pre-wrap' })], 100);
    expect(textOf(preserved.lines[0]!)).toBe('a   b');
  });

  it('never wraps in nowrap even past the budget', () => {
    const r = typeset([inline('aaa bbb ccc', { whiteSpace: 'nowrap' })], 10);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.width).toBeGreaterThan(10);
  });

  it('prints a soft hyphen only where the line actually breaks', () => {
    // "long" fits, break lands on the soft hyphen between the two halves.
    const r = typeset([inline('po\u00ADwer')], 20); // "po"=10, "wer"=15
    expect(r.lines.map(textOf)).toEqual(['po-', 'wer']);
    expect(r.lines[0]!.hyphenated).toBe(true);
  });

  it('applies per-line x offsets for alignment', () => {
    const center = typeset([inline('aaa', { align: 'center' })], 40);
    expect(center.lines[0]!.runs[0]!.x).toBeCloseTo((40 - 15) / 2, 3);
    const right = typeset([inline('aaa', { align: 'right' })], 40);
    expect(right.lines[0]!.runs[0]!.x).toBeCloseTo(40 - 15, 3);
  });

  it('distributes justify gaps across interior spaces only', () => {
    const r = typeset([inline('aaa bbb ccc')], 60, { align: 'justify' });
    // last line is never justified; single line here is the last => gap 0.
    expect(r.lines[0]!.gapWidth).toBe(0);

    const two = typeset([inline('aaa bbb')], 30, { align: 'justify' });
    // Two lines: first is justified. "aaa bbb" width 32.8 > 30 so it wrapped,
    // meaning the justified first line holds one word and has no spaces.
    expect(two.lines[0]!.spaceCount).toBe(0);
  });

  it('mixes styled runs while keeping break opportunities correct', () => {
    const parts: InlineSource[] = [
      { text: 'big ', style: style({ fontSize: 10 }) }, // 'big'=15, ' '=2.8
      { text: 'small', style: style({ fontSize: 10 }) }, // 'small'=25
    ];
    // 'big small' = 42.8 > 30, so it wraps; 'small' (25) fits an empty line.
    const r = typeset(parts, 30);
    expect(r.lines.map(textOf)).toEqual(['big', 'small']);
    expect(r.totalHeight).toBeCloseTo(24, 3);
  });
});
