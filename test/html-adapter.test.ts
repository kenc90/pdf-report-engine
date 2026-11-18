/**
 * Tests for the HTML-subset adapter: parsing, IR mapping, running-token rewrite
 * and a bound/literal table, plus one end-to-end render to real PDF bytes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseHtml, htmlToReportDoc, htmlElementToReportDoc, type HElement } from '../src/adapter/html.js';
import { resolvePage } from '../src/core/page.js';
import { MM_TO_PT } from '../src/core/units.js';
import { renderToBuffer } from '../src/index.js';
import type { TableBlock, Block, ParagraphBlock, HeadingBlock, ImageBlock, ContentSpan, ContainerBlock, FlexBlock } from '../src/ir/schema.js';

const ARIAL = 'C:/Windows/Fonts/arial.ttf';

function mockElement(
  tag: string,
  attrs: Record<string, string>,
  children: Node[],
  ownerDocument: Document,
  computed: Record<string, string>,
  computedStyles: WeakMap<Element, Record<string, string>>,
): Element {
  const element = {
    nodeType: 1,
    localName: tag,
    ownerDocument,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    childNodes: children,
  } as unknown as Element;
  computedStyles.set(element, computed);
  return element;
}

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
  it('maps the document language and chart alternative text', () => {
    const doc = htmlToReportDoc(
      '<html lang="en-US"><body><div data-chart="bar" aria-label="Monthly revenue"></div></body></html>',
    );

    expect(doc.language).toBe('en-US');
    expect(doc.body![0]).toMatchObject({ type: 'chart', alt: 'Monthly revenue' });
  });

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

  it('does not turn transparent backgrounds into opaque colors', () => {
    for (const background of ['transparent', 'rgba(0, 0, 0, 0)', 'rgb(0 0 0 / 0)']) {
      const doc = htmlToReportDoc(`<p style="background-color:${background}">x</p>`);
      expect((doc.body![0] as ParagraphBlock).backgroundColor).toBeUndefined();
    }
  });

  it('rewrites {PAGE} and {TOTAL} into $page bindings', () => {
    const doc = htmlToReportDoc('<p>Page {PAGE} of {TOTAL}</p>');
    const p = doc.body![0] as ParagraphBlock;
    const binds = (p.content as ContentSpan[]).filter((c) => typeof c === 'object').map((c) => (c as ContentSpan).bind);
    expect(binds).toContain('$page.number');
    expect(binds).toContain('$page.total');
  });
});

describe('htmlElementToReportDoc', () => {
  it('maps rounded flex-item styles onto the stretch background box', () => {
    const report = htmlToReportDoc(`
      <style>
        .kpi-row { display: flex; align-items: stretch; }
        .kpi-card { flex: 1 1 0; border: 1px solid #dce5ef; border-radius: 10px; padding: 16px; background: #f7fafc; }
      </style>
      <div class="kpi-row"><div class="kpi-card"><p>Net revenue</p></div></div>
    `);
    const flex = report.body![0] as FlexBlock;

    expect(flex.children[0]!.borderRadius).toEqual([7.5, 7.5, 7.5, 7.5]);
  });

  it('keeps styled block wrappers and edge-specific table borders', () => {
    const report = htmlToReportDoc(
      '<div style="background-color:#fff;padding:12px;border:1px solid #ccc;border-radius:8px">' +
      '<table><tr><td style="border-left:2px solid #f60">Item</td></tr></table></div>',
    );
    const wrapper = report.body![0] as ContainerBlock;
    const table = wrapper.children[0] as TableBlock;

    expect(wrapper.type).toBe('container');
    expect(wrapper.paddingTop).toBeCloseTo(9);
    expect(wrapper.borderRadius).toEqual([6, 6, 6, 6]);
    expect(table.staticRows![0]!.cells[0]!.borderLeft).toEqual([1.5, 'solid', '#f60']);
  });

  it('preserves inline children around block children in styled wrappers', () => {
    const source = '<div style="padding:12px;background-color:#f7fafc">' +
      '<strong>Quarterly notes</strong><p>Real DOM paragraph</p></div>';
    const report = htmlToReportDoc(source);
    const wrapper = report.body![0] as ContainerBlock;
    const heading = wrapper.children[0] as ParagraphBlock;

    expect(wrapper.children.map((child) => child.type)).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(heading.content)).toContain('Quarterly notes');
    expect(JSON.stringify(heading.content)).toContain('"fontWeight":700');
    expect(heading.backgroundColor).toBeUndefined();
    expect(heading.paddingTop).toBeUndefined();
    expect(JSON.stringify(heading.content)).not.toContain('border');
  });

  it('collects Google font references for Unicode glyphs outside base PDF fonts', () => {
    const url = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Symbols&display=swap';
    const report = htmlToReportDoc(
      `<html><head><link rel="stylesheet" href="${url}"></head><body><p>↑ 12.4%</p></body></html>`,
    );

    expect(report.fonts).toEqual([{ type: 'google', url }]);
    expect((report.body![0] as ParagraphBlock).content).toContain('↑');
  });

  it('keeps a single browser line unwrapped when PDF font metrics differ', () => {
    const computedStyles = new WeakMap<Element, Record<string, string>>();
    let selected: Element | undefined;
    let heading: Element;
    let cell: Element;
    const ownerDocument = {
      defaultView: {
        getComputedStyle: (element: Element) => ({
          getPropertyValue: (property: string) => computedStyles.get(element)?.[property] ?? '',
          get display() { return computedStyles.get(element)?.display ?? ''; },
          get whiteSpace() { return computedStyles.get(element)?.['white-space'] ?? ''; },
          get visibility() { return computedStyles.get(element)?.visibility ?? ''; },
        }),
      },
      head: { children: [] },
      documentElement: {},
      baseURI: 'https://example.test/page.html',
      createRange: () => ({
        selectNodeContents: (element: Element) => { selected = element; },
        getClientRects: () => selected === heading || selected === cell
          ? [{ top: 10, width: 180, height: 28 }, { top: 10, width: 24, height: 28 }]
          : [],
      }),
    };
    const text = { nodeType: 3, nodeValue: 'Northwind Studio', childNodes: [] } as unknown as Node;
    heading = mockElement(
      'h2',
      {},
      [text],
      ownerDocument as unknown as Document,
      { display: 'block', 'white-space': 'normal', 'font-size': '25px' },
      computedStyles,
    );
    const cellText = { nodeType: 3, nodeValue: 'Review and delivery', childNodes: [] } as unknown as Node;
    cell = mockElement(
      'td',
      {},
      [cellText],
      ownerDocument as unknown as Document,
      { display: 'table-cell', 'white-space': 'normal' },
      computedStyles,
    );
    const row = mockElement('tr', {}, [cell], ownerDocument as unknown as Document, { display: 'table-row' }, computedStyles);
    const tableElement = mockElement('table', {}, [row], ownerDocument as unknown as Document, { display: 'table' }, computedStyles);
    const root = mockElement(
      'div',
      {},
      [heading, tableElement],
      ownerDocument as unknown as Document,
      { display: 'block', 'white-space': 'normal' },
      computedStyles,
    );

    const report = htmlElementToReportDoc(root);

    expect((report.body![0] as HeadingBlock).whiteSpace).toBe('nowrap');
    expect((report.body![1] as TableBlock).staticRows![0]!.cells[0]!.style?.whiteSpace).toBe('nowrap');
  });

  it('captures and renders live canvas pixels as a labelled PNG image', async () => {
    const computedStyles = new WeakMap<Element, Record<string, string>>();
    const view = {
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
    } as unknown as Window;
    const ownerDocument = {
      defaultView: view,
      head: { children: [] },
      documentElement: {},
      baseURI: 'https://example.test/page.html',
    } as unknown as Document;
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
    let requestedType = '';
    const canvas = Object.assign(
      mockElement(
        'canvas',
        { width: '320', height: '180', 'aria-label': 'Monthly revenue chart' },
        [],
        ownerDocument,
        {},
        computedStyles,
      ),
      {
        width: 320,
        height: 180,
        toDataURL: (type: string) => {
          requestedType = type;
          return dataUrl;
        },
      },
    ) as unknown as HTMLCanvasElement;

    const report = htmlElementToReportDoc(canvas);
    const image = report.body![0] as ImageBlock;

    expect(requestedType).toBe('image/png');
    expect(image.src).toBe(dataUrl);
    expect(image.width).toBe('320px');
    expect(image.height).toBe('180px');
    expect(image.alt).toBe('Monthly revenue chart');
    const pdf = Buffer.from(await renderToBuffer(report));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
  });

  it('rejects canvases with zero intrinsic dimensions before encoding', () => {
    const computedStyles = new WeakMap<Element, Record<string, string>>();
    const ownerDocument = {
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
      head: { children: [] },
      documentElement: {},
      baseURI: 'https://example.test/page.html',
    } as unknown as Document;
    let encoded = false;
    const canvas = Object.assign(
      mockElement('canvas', {}, [], ownerDocument, {}, computedStyles),
      {
        width: 0,
        height: 180,
        toDataURL: () => { encoded = true; return ''; },
      },
    ) as unknown as HTMLCanvasElement;

    expect(() => htmlElementToReportDoc(canvas)).toThrow(/zero intrinsic width or height/);
    expect(encoded).toBe(false);
  });

  it('captures live content and computed styles from the page document', () => {
    const computedStyles = new WeakMap<Element, Record<string, string>>();
    const view = {
      getComputedStyle: (element: Element) => ({
        getPropertyValue: (property: string) => computedStyles.get(element)?.[property] ?? '',
      }),
    } as unknown as Window;
    const headChildren: Element[] = [];
    const ownerDocument = {
      defaultView: view,
      head: { children: headChildren },
      documentElement: { lang: 'en-US' },
      baseURI: 'https://example.test/reports/page.html',
    } as unknown as Document;
    const stylesheetText = {
      nodeType: 3,
      nodeValue: '.sample { margin: 0 auto; }',
      childNodes: [],
    } as unknown as Node;
    headChildren.push(mockElement('style', {}, [stylesheetText], ownerDocument, {}, computedStyles));
    const text = { nodeType: 3, nodeValue: 'Updated by page code', childNodes: [] } as unknown as Node;
    const paragraph = mockElement(
      'p',
      { class: 'report-text', style: 'color: blue' },
      [text],
      ownerDocument,
      {
        'font-size': '18px',
        'font-family': '"Times New Roman", Arial',
        color: 'rgb(200, 0, 0)',
        'background-color': 'rgba(0, 0, 0, 0)',
        border: '0px none rgb(200, 0, 0)',
        'border-top': '0px none rgb(200, 0, 0)',
        transform: 'matrix(0, 1, -1, 0, 0, 0)',
        'min-height': 'auto',
        'flex-basis': 'auto',
        left: 'auto',
        top: 'auto',
        'letter-spacing': 'normal',
      },
      computedStyles,
    );
    const root = mockElement(
      'div',
      {},
      [paragraph],
      ownerDocument,
      { display: 'block', 'background-color': 'rgba(0, 0, 0, 0)' },
      computedStyles,
    );

    const report = htmlElementToReportDoc(root);
    const block = report.body![0] as ParagraphBlock;

    expect(report.language).toBe('en-US');
    expect(block.content).toBe('Updated by page code');
    expect(block.fontSize).toBeCloseTo(13.5, 1);
    expect(block.fontFamily).toEqual(['Times New Roman', 'Arial']);
    expect(block.color).toBe('rgb(200, 0, 0)');
    expect(block.backgroundColor).toBeUndefined();
    expect(block.border).toBeUndefined();
    expect(block.borderTop).toBeUndefined();
    expect(block.rotate).toBeCloseTo(90, 1);
  });

  it('preserves line breaks for elements with computed block display', () => {
    const computedStyles = new WeakMap<Element, Record<string, string>>();
    const view = {
      getComputedStyle: (element: Element) => ({
        getPropertyValue: (property: string) => computedStyles.get(element)?.[property] ?? '',
        get display() { return computedStyles.get(element)?.display ?? ''; },
        get visibility() { return computedStyles.get(element)?.visibility ?? ''; },
      }),
    } as unknown as Window;
    const ownerDocument = {
      defaultView: view,
      head: { children: [] },
      documentElement: {},
      baseURI: 'https://example.test/page.html',
    } as unknown as Document;
    const before = { nodeType: 3, nodeValue: 'Bill to', childNodes: [] } as unknown as Node;
    const nameText = { nodeType: 3, nodeValue: 'Contoso Research', childNodes: [] } as unknown as Node;
    const after = { nodeType: 3, nodeValue: '88 Market Street', childNodes: [] } as unknown as Node;
    const label = mockElement('span', {}, [before], ownerDocument, { display: 'inline' }, computedStyles);
    const name = mockElement('strong', {}, [nameText], ownerDocument, { display: 'block' }, computedStyles);
    const address = mockElement('span', {}, [after], ownerDocument, { display: 'inline' }, computedStyles);
    const root = mockElement('div', {}, [label, name, address], ownerDocument, { display: 'block' }, computedStyles);

    const report = htmlElementToReportDoc(root);

    expect(JSON.stringify((report.body![0] as ParagraphBlock).content)).toContain('\u2028');
  });

  it('omits elements hidden by the page styles', () => {
    const computedStyles = new WeakMap<Element, Record<string, string>>();
    const view = {
      getComputedStyle: (element: Element) => ({
        getPropertyValue: (property: string) => computedStyles.get(element)?.[property] ?? '',
        get display() { return computedStyles.get(element)?.display ?? ''; },
        get visibility() { return computedStyles.get(element)?.visibility ?? ''; },
      }),
    } as unknown as Window;
    const ownerDocument = {
      defaultView: view,
      head: { children: [] },
      documentElement: {},
      baseURI: 'https://example.test/page.html',
    } as unknown as Document;
    const hiddenText = { nodeType: 3, nodeValue: 'Do not render', childNodes: [] } as unknown as Node;
    const visibleText = { nodeType: 3, nodeValue: 'Keep this', childNodes: [] } as unknown as Node;
    const hidden = mockElement('p', {}, [hiddenText], ownerDocument, { display: 'none' }, computedStyles);
    const visible = mockElement('p', {}, [visibleText], ownerDocument, { display: 'block' }, computedStyles);
    const root = mockElement('div', {}, [hidden, visible], ownerDocument, { display: 'block' }, computedStyles);

    const report = htmlElementToReportDoc(root);

    expect(report.body).toHaveLength(1);
    expect((report.body![0] as ParagraphBlock).content).toBe('Keep this');
  });

  it('requires an element attached to a document window', () => {
    const element = {
      nodeType: 1,
      ownerDocument: { defaultView: null },
    } as unknown as Element;
    expect(() => htmlElementToReportDoc(element)).toThrow(/document with a window/);
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

  it('maps break-inside: avoid from literal and data-bound rows', () => {
    const literal = htmlToReportDoc(
      '<table><tbody><tr style="break-inside: avoid"><td>Long note</td></tr></tbody></table>',
    ).body![0] as TableBlock;
    expect(literal.staticRows![0]!.breakInside).toBe('avoid');

    const bound = htmlToReportDoc(
      '<table data-each="row in $data.items"><tbody><tr style="break-inside: avoid"><td data-bind="name"></td></tr></tbody></table>',
    ).body![0] as TableBlock;
    expect(bound.detail).toMatchObject({ breakInside: 'avoid' });
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
