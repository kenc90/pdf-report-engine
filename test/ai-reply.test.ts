import { describe, expect, it } from 'vitest';
import { extractHtmlFromReply } from '../docs/ai-reply.js';

describe('AI reply report extraction', () => {
  it('does not treat a plain library answer as report HTML', () => {
    expect(extractHtmlFromReply('Use renderToBuffer(report) to create a PDF.')).toBe('');
  });

  it('extracts an explicit HTML report block', () => {
    expect(extractHtmlFromReply('Here is the report:\n```html\n<h1>Invoice</h1>\n```')).toBe('<h1>Invoice</h1>');
  });

  it('keeps supporting unfenced report HTML', () => {
    expect(extractHtmlFromReply('<table><tr><td>Item</td></tr></table>')).toBe('<table><tr><td>Item</td></tr></table>');
  });

  it('does not mistake another language fence for a report', () => {
    expect(extractHtmlFromReply('```js\nrenderToBuffer(report);\n```')).toBe('');
  });

  it('ignores a JSON-only dataset block', () => {
    expect(extractHtmlFromReply('```json\n{"rows":[]}\n```')).toBe('');
  });

  it('does not extract an HTML-looking example embedded in prose', () => {
    expect(extractHtmlFromReply('Use markup like <div>content</div> in the report.')).toBe('');
  });
});
