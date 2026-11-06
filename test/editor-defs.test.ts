import { describe, it, expect } from 'vitest';
import { parseHtml, serializeWithOffsets } from '../docs/editor-defs.js';

// The editor keeps its own parse/serialize model for the source round-trip
// (reformat on blur, Apply from the assistant). Historically its tag regex
// stopped at the *first* `>`, so a comparison operator inside a quoted
// attribute value truncated `data-if="… > 0"` to an empty expression, which
// then failed at render with `Cannot compile expression ""`. These tests lock
// the quote-aware tag scan in place.
function roundTrip(src: string): string {
  return serializeWithOffsets(parseHtml(src)).src;
}

describe('editor parser: > and < inside quoted attribute values', () => {
  it('preserves a > in a data-if expression', () => {
    const out = roundTrip('<div data-if="$data.totals.discount > 0">hi</div>');
    expect(out).toContain('data-if="$data.totals.discount > 0"');
    expect(out).not.toContain('data-if=""');
  });

  it('round-trips data-each + data-if + data-bind on a table', () => {
    const src =
      '<table><tbody><tr data-each="$data.rows">' +
      '<td data-if="$row.qty > 0" data-bind="$row.name">x</td></tr></tbody></table>';
    const out = roundTrip(src);
    expect(out).toContain('data-each="$data.rows"');
    expect(out).toContain('data-if="$row.qty > 0"');
    expect(out).toContain('data-bind="$row.name"');
    // the tag must not have been truncated into stray "0">" text
    expect(out).not.toContain('0">');
  });

  it('handles single-quoted values and the < operator', () => {
    const out = roundTrip("<div data-when='$a < $b'>x</div>");
    // attrs are re-emitted double-quoted with `<` escaped; the value survives
    expect(out).toContain('data-when="$a &lt; $b"');
    expect(out).not.toContain('data-when=""');
  });

  it('keeps self-closing blocks whose attributes contain a value', () => {
    const out = roundTrip('<hr data-style="padding:4px"/>');
    expect(out).toContain('data-style="padding:4px"');
  });

  it('decodes &gt; to a literal > that survives a second round-trip', () => {
    const first = roundTrip('<div data-if="$a &gt; 0">x</div>');
    expect(first).toContain('data-if="$a > 0"');
    const second = roundTrip(first);
    expect(second).toContain('data-if="$a > 0"');
    expect(second).not.toContain('data-if=""');
  });

  it('does not misread a > inside an entity value as the tag end', () => {
    const root = parseHtml('<div data-bind="$a > $b">text</div>');
    const div = root.children[0];
    expect(div.attrs['data-bind']).toBe('$a > $b');
    // its only child should be the text node, not truncated markup
    expect(div.children).toHaveLength(1);
    expect(div.children[0].text).toBe('text');
  });
});
