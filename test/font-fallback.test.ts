/**
 * Per-glyph font fallback tests. Uses stub `FontHandle`s (no font binary) with an
 * explicit coverage predicate and fixed advances, so fallback decisions and the
 * resulting run splits/widths are fully deterministic:
 *   - "Latin" face: 0.5em advance, covers only code points <= U+017F;
 *   - "CJK"   face: 1em advance, covers everything.
 */
import { describe, expect, it } from 'vitest';
import { FontRegistry, type FontHandle } from '../src/fonts/registry.js';
import type { ResolvedStyle } from '../src/text/style.js';
import { typeset, type InlineSource } from '../src/text/typeset.js';

function makeHandle(family: string, advance: number, cover: (cp: number) => boolean): FontHandle {
  return {
    key: family,
    family,
    weight: 400,
    style: 'normal',
    ascender: 750,
    descender: -250,
    xHeight: 450,
    capHeight: 700,
    lineGap: 0,
    unitsPerEm: 1000,
    embedded: true,
    embeddedName: family,
    widthOf: (text: string, size: number) => (advance / 1000) * size * Array.from(text).length,
    hasGlyphsFor: (text: string) => Array.from(text).every((ch) => cover(ch.codePointAt(0)!)),
    coversCodePoint: cover,
  };
}

function styleFor(handle: FontHandle): ResolvedStyle {
  return {
    handle,
    fontStack: handle.family,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0,
    align: 'left',
    verticalAlign: 'top',
    whiteSpace: 'normal',
    textTransform: 'none',
    color: [0, 0, 0],
    backgroundColor: undefined,
    features: undefined,
    decoration: [],
  };
}

function registry(): { reg: FontRegistry; latin: FontHandle; cjk: FontHandle } {
  const latin = makeHandle('Latin', 500, (cp) => cp <= 0x017f);
  const cjk = makeHandle('CJK', 1000, () => true);
  const reg = new FontRegistry();
  reg.addHandle(latin);
  reg.addHandle(cjk);
  return { reg, latin, cjk };
}

describe('FontRegistry.resolveWithFallback', () => {
  it('keeps the primary face when it already covers the glyph', () => {
    const { reg, latin } = registry();
    expect(reg.resolveWithFallback('A', ['Latin'], 400)).toBe(latin);
  });

  it('switches to a covering face for an uncovered glyph', () => {
    const { reg, cjk } = registry();
    expect(reg.resolveWithFallback('何', ['Latin'], 400)).toBe(cjk);
  });

  it('falls back to the primary when nothing covers the glyph', () => {
    const { reg, latin } = registry();
    const noCjk = new FontRegistry();
    noCjk.addHandle(latin);
    expect(noCjk.resolveWithFallback('何', ['Latin'], 400)).toBe(latin);
  });
});

describe('typeset per-glyph fallback', () => {
  it('splits a mixed run by face and measures each segment with its own font', () => {
    const { reg, latin, cjk } = registry();
    const inline: InlineSource = {
      text: 'A何B',
      style: styleFor(latin),
      fallback: (ch) => reg.resolveWithFallback(ch, ['Latin'], 400),
    };
    const { lines } = typeset([inline], 1000);
    const runs = lines[0]!.runs;
    expect(runs.map((r) => r.text)).toEqual(['A', '何', 'B']);
    expect(runs[0]!.style.handle).toBe(latin);
    expect(runs[1]!.style.handle).toBe(cjk);
    expect(runs[2]!.style.handle).toBe(latin);
    // 0.5em, 1em, 0.5em at 10pt -> 5, 10, 5.
    expect(runs[0]!.width).toBeCloseTo(5);
    expect(runs[1]!.width).toBeCloseTo(10);
    expect(runs[2]!.width).toBeCloseTo(5);
    expect(lines[0]!.width).toBeCloseTo(20);
  });

  it('leaves runs intact when no fallback is supplied (pre-fallback behaviour)', () => {
    const { latin } = registry();
    const inline: InlineSource = { text: 'A何B', style: styleFor(latin) };
    const { lines } = typeset([inline], 1000);
    const runs = lines[0]!.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe('A何B');
    expect(runs[0]!.style.handle).toBe(latin);
    expect(runs[0]!.width).toBeCloseTo(15); // 3 * 0.5em * 10pt
  });
});
