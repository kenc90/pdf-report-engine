/**
 * Tests for the HTML-subset adapter: parsing, IR mapping, running-token rewrite
 * and a bound/literal table, plus one end-to-end render to real PDF bytes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseHtml, htmlToReportDoc, type HElement } from '../src/adapter/html.js';
import { resolvePage } from '../src/core/page.js';
import { MM_TO_PT } from '../src/core/units.js';
import { renderToBuffer } from '../src/index.js';
import type { TableBlock, Block, ParagraphBlock, HeadingBlock, ImageBlock, ContentSpan } from '../src/ir/schema.js';

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

  it('maps a diagonal corner header cell from data-diagonal attributes', () => {
    const doc = htmlToReportDoc(
      '<table><thead><tr><th data-diagonal data-diagonal-bottom="Gender">Preferred Pet</th><th>Dog</th></tr></thead><tbody><tr><td>Girl</td><td>2</td></tr></tbody></table>',
    );
    const t = doc.body![0] as TableBlock;
    const corner = t.headerRows![0]!.cells[0]!;
    // The cell's own text becomes the upper label; the attribute is the lower one.
    expect(corner.diagonal?.top).toBe('Preferred Pet');
    expect(corner.diagonal?.bottom).toBe('Gender');
    expect(corner.diagonal?.dir).toBe('tl');
    // The inline content is moved into the diagonal, so it is no longer a plain cell.
    expect(corner.content).toBeUndefined();
  });

  it('flips the diagonal direction and honours explicit top/bottom labels', () => {
    const doc = htmlToReportDoc(
      '<table><tr><th data-diagonal="tr" data-diagonal-top="Region" data-diagonal-bottom="Quarter">Sales</th></tr></table>',
    );
    const t = doc.body![0] as TableBlock;
    const corner = t.headerRows![0]!.cells[0]!;
    expect(corner.diagonal?.dir).toBe('tr');
    expect(corner.diagonal?.top).toBe('Region');
    expect(corner.diagonal?.bottom).toBe('Quarter');
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

describe('html adapter -> image block', () => {
  it('maps a block-level <img> to an ImageBlock with width/height/align', () => {
    const doc = htmlToReportDoc('<img src="logo.png" width="120" height="80" style="text-align: center" alt="Brand" />');
    const img = doc.body![0] as ImageBlock;
    expect(img.type).toBe('image');
    expect(img.src).toBe('logo.png');
    expect(img.alt).toBe('Brand');
    expect(String(img.width)).toBe('120px');
    expect(String(img.height)).toBe('80px');
    expect(img.align).toBe('center');
  });

  it('resolves a relative src against baseDir', () => {
    const doc = htmlToReportDoc('<img src="assets/logo.png" width="60" />', { baseDir: '/reports' });
    const img = doc.body![0] as ImageBlock;
    expect(img.src).toMatch(/assets[\\/]logo\.png$/);
    expect(img.src).not.toBe('assets/logo.png'); // made absolute
  });

  it('leaves data URIs and absolute URLs untouched', () => {
    const doc = htmlToReportDoc('<img src="https://x.test/a.png" width="40" />', { baseDir: '/reports' });
    expect((doc.body![0] as ImageBlock).src).toBe('https://x.test/a.png');
  });
});

describe('html adapter -> page geometry (@page / meta)', () => {
  it('parses size + orientation from an @page rule', () => {
    const doc = htmlToReportDoc('<style>@page { size: A4 landscape; margin: 10mm; }</style><p>x</p>');
    expect(doc.page?.size).toBe('a4');
    expect(doc.page?.orientation).toBe('landscape');
    const resolved = resolvePage(doc.page);
    expect(resolved.width).toBeCloseTo(297 * MM_TO_PT, 1); // landscape swaps w/h
    expect(resolved.height).toBeCloseTo(210 * MM_TO_PT, 1);
    expect(resolved.margin.top).toBeCloseTo(10 * MM_TO_PT, 1);
  });

  it('normalizes a CSS margin shorthand to [top,right,bottom,left]', () => {
    const doc = htmlToReportDoc('<style>@page { margin: 1cm 2cm 3cm 4cm; }</style>');
    const m = resolvePage(doc.page).margin;
    expect(m.top).toBeCloseTo(1 * 28.3465, 1);
    expect(m.right).toBeCloseTo(2 * 28.3465, 1);
    expect(m.bottom).toBeCloseTo(3 * 28.3465, 1);
    expect(m.left).toBeCloseTo(4 * 28.3465, 1);
  });

  it('supports explicit [w h] dimensions in units', () => {
    const doc = htmlToReportDoc('<style>@page { size: 100mm 150mm; }</style>');
    expect(doc.page?.size).toEqual(['100mm', '150mm']);
    const resolved = resolvePage(doc.page);
    expect(resolved.width).toBeCloseTo(100 * MM_TO_PT, 1);
    expect(resolved.height).toBeCloseTo(150 * MM_TO_PT, 1);
  });

  it('reads a <meta name="pdf-page"> and lets @page override it', () => {
    const doc = htmlToReportDoc(
      '<meta name="pdf-page" content="size=letter; margin=0.5in" /><style>@page { margin: 20mm; }</style>',
    );
    expect(doc.page?.size).toBe('letter'); // from meta
    expect(doc.page?.margin).toEqual(['20mm', '20mm', '20mm', '20mm']); // @page wins
  });

  it('omits page entirely when the document declares none', () => {
    const doc = htmlToReportDoc('<p>plain</p>');
    expect(doc.page).toBeUndefined();
  });

  it('gives a JS-provided page option precedence over @page', () => {
    const doc = htmlToReportDoc('<style>@page { size: a4; }</style>', { page: { size: 'legal', margin: 30 } });
    expect(doc.page?.size).toBe('legal');
    expect(doc.page?.margin).toBe(30);
  });
});
