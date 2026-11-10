import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectDetailedReference } from '../docs/ai-reference.js';

const reference = [
  '# Library reference',
  'Compact overview.',
  '## Public API',
  'The package exports its rendering and adapter APIs.',
  '### Render entry points',
  '`renderToBuffer` returns a complete PDF buffer.',
  '## EncryptionSpec',
  'Encryption options set the PDF user and owner passwords.',
  '## Chart',
  'Chart data supports multiple series.',
].join('\n');
const fullReference = readFileSync(new URL('../llms-full.txt', import.meta.url), 'utf8');

describe('AI detailed reference retrieval', () => {
  it('selects the section relevant to a specific question', () => {
    const result = selectDetailedReference(reference, 'How do I configure encryption?');
    expect(result).toContain('EncryptionSpec');
    expect(result).not.toContain('renderToBuffer');
  });

  it('includes the full reference for broad usage questions', () => {
    expect(selectDetailedReference(reference, 'How do I use this library?')).toBe(reference);
  });

  it('does not add detailed docs for unrelated conversational messages', () => {
    expect(selectDetailedReference(reference, 'Thanks!')).toBe('');
  });

  it('falls back to the full reference when a library question has no section match', () => {
    expect(selectDetailedReference(reference, 'How does the PDF library handle an unknown feature?')).toBe(reference);
  });

  it('retrieves the actual chart details for a chart question', () => {
    const result = selectDetailedReference(fullReference, 'How do charts support multiple series?');
    expect(result).toContain('### `chart`');
    expect(result).toContain('data-series');
  });

  it('retrieves browser bundle instructions for browser usage questions', () => {
    const result = selectDetailedReference(fullReference, 'Show JS code to build a PDF using the browser library');
    expect(result).toContain('Browser ESM bundle');
    expect(result).toContain('renderToBuffer');
    expect(result).not.toContain('EncryptionSpec');
    expect(result.length).toBeLessThan(fullReference.length);
  });
});
