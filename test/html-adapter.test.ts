/**
 * Tests for the HTML-subset adapter: parsing, IR mapping, running-token rewrite
 * and a bound/literal table, plus one end-to-end render to real PDF bytes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseHtml, htmlToReportDoc, type HElement } from '../src/adapter/html.js';
import { renderToBuffer } from '../src/index.js';
import type { TableBlock, Block, ParagraphBlock, HeadingBlock, ContentSpan } from '../src/ir/schema.js';

const ARIAL = 'C:/Windows/Fonts/arial.ttf';

describe('parseHtml', () => {
  it('builds a nested tree with attributes and text', () => {
    const root = parseHtml('<div class="a"><p id="x">Hello <b>world</b></p></div>');
    const div = root.children[0] as HElement;
    expect(div.type).toBe('element');
    expect(div.attrs['class']).toBe('a');
    const p = div.children[0] as HElement;
    expect(p.tag).toBe('p');
    expect(p.children.some((c) => c.type === 'element' && (c as HElement).tag === 'b')).toBe(true);
  });

  it('decodes entities and skips comments', () => {
    const root = parseHtml('<p>A &amp; B &#65; <!--note-->C</p>');
    const p = root.children[0] as HElement;
    const joined = p.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(joined).toBe('A & B A C');
  });

  it('throws on an unclosed element', () => {
    expect(() => parseHtml('<div><p>x')).toThrow();
  });
});

describe('htmlToReportDoc: blocks', () => {
  it('maps headings and paragraphs with inline spans', () => {
    const doc = htmlToReportDoc('<h2>Title</h2><p>Plain <strong>bold</strong> text</p>');
    expect(doc.body).toHaveLength(2);
    const h = doc.body![0] as HeadingBlock;
    expect(h.type).toBe('heading');
    expect(h.level).toBe(2);
    expect(h.content).toBe('Title');
    const p = doc.body![1] as ParagraphBlock;
    expect(p.type).toBe('paragraph');
    expect(Array.isArray(p.content)).toBe(true);
    // the <strong> becomes a styled span
    const span = (p.content as ContentSpan[]).find((c) => typeof c === 'object') as ContentSpan;
    expect(span?.style?.fontWeight).toBe(700);
  });

  it('converts font-size in px to points and maps text-align', () => {
    const doc = htmlToReportDoc('<p style="font-size:16px; text-align:right">x</p>');
    const p = doc.body![0] as ParagraphBlock;
    expect(p.fontSize).toBeCloseTo(16 * 0.75, 2); // 16px -> 12pt
    expect(p.align).toBe('right');
  });

  it('rewrites {PAGE} and {TOTAL} into $page bindings', () => {
    const doc = htmlToReportDoc('<p>Page {PAGE} of {TOTAL}</p>');
    const p = doc.body![0] as ParagraphBlock;
    const binds = (p.content as ContentSpan[]).filter((c) => typeof c === 'object').map((c) => (c as ContentSpan).bind);
    expect(binds).toContain('$page.number');
    expect(binds).toContain('$page.total');
  });
});

describe('htmlToReportDoc: tables', () => {
  it('maps a literal table with a header row', () => {
    const doc = htmlToReportDoc(
      '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr><tr><td>Pear</td><td>5</td></tr></table>',
    );
    const t = doc.body![0] as TableBlock;
    expect(t.type).toBe('table');
    expect(t.headerRows).toHaveLength(1);
    // Literal body rows are preserved as authored static rows (not collapsed data).
    expect(t.staticRows).toHaveLength(2);
    expect(t.repeatHeader).toBe(true);
    expect(t.staticRows![0]!.cells[0]!.content).toBe('Apple');
    expect(t.staticRows![1]!.cells[1]!.content).toBe('5');
  });

  it('maps cell background, border and padding onto CellNode fields', () => {
    const doc = htmlToReportDoc(
      '<table data-grid="1px solid #ccc" data-striped><tr><th>St</th></tr><tr><td style="background-color:#1b7f4b; padding:6pt">Paid</td></tr></table>',
    );
    const t = doc.body![0] as TableBlock;
    expect(t.showGrid).toBeTruthy();
    expect(t.striped).toBe(true);
    const cell = t.staticRows![0]!.cells[0]!;
    expect(cell.backgroundColor).toBe('#1b7f4b');
    expect(cell.paddingTop).toBeCloseTo(6, 1);
    expect(cell.content).toBe('Paid');
  });

  it('maps a bound table with data-each and per-cell binds', () => {
    const doc = htmlToReportDoc(
      '<table data-each="row in $data.items"><thead><tr><th>Name</th></tr></thead><tbody><tr><td data-bind="name"></td></tr></tbody></table>',
    );
    const t = doc.body![0] as TableBlock;
    expect(t.dataSource).toEqual({ each: 'row', of: '$data.items' });
    expect(t.headerRows).toHaveLength(1);
    expect(t.columns![0]!.key).toBe('name');
    // A `data-bind` cell stores its bind inside the cell's content spans.
    const detail = t.detail as { cells: Array<{ content: ContentSpan[] }> };
    expect(detail.cells[0]!.content[0]!.bind).toBe('name');
  });
});

describe('htmlToReportDoc: bands', () => {
  it('routes data-band elements into report bands, not body', () => {
    const doc = htmlToReportDoc(
      '<header data-band="pageHeader">Top</header><p>Body</p><footer data-band="pageFooter">Page {PAGE} of {TOTAL}</footer>',
    );
    expect(doc.bands?.pageHeader).toBeDefined();
    expect(doc.bands?.pageFooter).toBeDefined();
    // Only the paragraph stays in the flowing body.
    expect(doc.body).toHaveLength(1);
    // The footer band's running tokens became $page bindings.
    const footerJson = JSON.stringify(doc.bands?.pageFooter);
    expect(footerJson).toContain('$page.number');
    expect(footerJson).toContain('$page.total');
  });
});

describe('htmlToReportDoc: end to end', { timeout: 20000 }, () => {
  it('renders an HTML report to real, selectable PDF bytes', async () => {
    const html = `
      <body style="font-family: Arial; font-size: 11pt">
        <h1>Invoice</h1>
        <p>Client: <strong>Acme Co</strong></p>
        <table>
          <tr><th>Item</th><th>Amount</th></tr>
          <tr><td>Widget</td><td>1,200.00</td></tr>
          <tr><td>Service</td><td>450.50</td></tr>
        </table>
        <p style="text-align:right">Page {PAGE} of {TOTAL}</p>
      </body>`;
    const doc = htmlToReportDoc(html);
    const fonts = fs.existsSync(ARIAL) ? [{ family: 'Arial', path: ARIAL, weight: 400 }] : [];
    const { readFontFiles } = await import('../src/index.js');
    const buffer = await renderToBuffer(doc, { fonts: fonts.length ? await readFontFiles(fonts) : [] });
    const latin = buffer.toString('latin1');
    expect(latin.startsWith('%PDF-')).toBe(true);
    expect(latin).toContain('%%EOF');
    if (fonts.length) expect(latin).toContain('/ToUnicode');
    void (doc.body![0] as Block);
  });
});
