import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReport, renderToBuffer } from '../src/render.js';
import type { ReportDoc } from '../src/ir/schema.js';

const ARIAL = 'C:/Windows/Fonts/arial.ttf';
const ARIAL_BOLD = 'C:/Windows/Fonts/arialbd.ttf';
const hasArial = existsSync(ARIAL) && existsSync(ARIAL_BOLD);

const report: ReportDoc = {
  info: { title: 'Accessible report' },
  language: 'en-GB',
  body: [
    { type: 'heading', level: 1, content: 'Overview' },
    { type: 'paragraph', content: 'A short explanatory paragraph.' },
    {
      type: 'table',
      columns: [{ width: 140 }],
      headerRows: [{ cells: [{ content: 'Name' }] }],
      staticRows: [{ cells: [{ content: 'Ada Lovelace' }] }],
    },
  ],
};

async function pdfBytes(doc: ReturnType<typeof createReport>['doc']): Promise<Buffer> {
  doc.end();
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

describe('accessible PDF output', () => {
  it('emits a tagged structure tree for headings, paragraphs, and table cells', async () => {
    const output = createReport(report, { accessibility: {} });
    const bytes = await pdfBytes(output.doc);
    const pdf = bytes.toString('latin1');

    expect(pdf).toContain('/StructTreeRoot');
    expect(pdf).toContain('/MarkInfo');
    expect(pdf).toContain('/Lang (en-GB)');
    expect(pdf).toContain('/S /Document');
    expect(pdf).toContain('/S /H1');
    expect(pdf).toContain('/S /P');
    expect(pdf).toContain('/S /Table');
    expect(pdf).toContain('/S /TR');
    expect(pdf).toContain('/S /TH');
    expect(pdf).toContain('/S /TD');
  });

  it('does not alter pagination or fragment geometry when tagging is enabled', () => {
    const plain = createReport(report);
    const tagged = createReport(report, { accessibility: {} });
    const geometry = (pages: typeof plain.pages) => pages.map((page) => page.body.map(({ x, y, fragment }) => ({
      x,
      y,
      width: fragment.width,
      height: fragment.height,
    })));

    expect(geometry(tagged.pages)).toEqual(geometry(plain.pages));
  });

  it('requires a document language when tagging is enabled', () => {
    expect(() => createReport({ body: [] }, { accessibility: {} }))
      .toThrow(/requires a document language/);
  });

  it('requires alt text on images, SVGs, and charts when tagging is enabled', () => {
    expect(() => createReport({
      body: [{ type: 'image', src: new Uint8Array(), intrinsic: { width: 1, height: 1 } }],
    }, { accessibility: { language: 'en' } })).toThrow(/requires alt text/);
  });

  it('stores figure alternative text in the structure tree', async () => {
    const bytes = await renderToBuffer({
      body: [{
        type: 'svg',
        src: '<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
        alt: 'Company logo',
      }],
    }, { accessibility: { language: 'en' } });
    const pdf = bytes.toString('latin1');

    expect(pdf).toContain('/S /Figure');
    expect(pdf).toContain('/Alt (Company logo)');
  });

  it('tags a repeated table header only once in reading order', async () => {
    const words = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ');
    const output = createReport({
      page: { size: [220, 180], margin: 10 },
      body: [{
        type: 'table',
        columns: [{ width: 140 }, { width: 45 }],
        headerRows: [{ cells: [{ content: 'Narrative' }, { content: 'Ref' }] }],
        staticRows: [{ cells: [{ content: words }, { content: 'ROW-1' }] }],
      }],
    }, { accessibility: { language: 'en' } });
    const bytes = await pdfBytes(output.doc);
    const pdf = bytes.toString('latin1');

    expect(output.pages.length).toBeGreaterThan(1);
    expect(pdf.match(/\/S \/TH/g)).toHaveLength(2);
    expect(pdf.match(/\/S \/TD/g)).toHaveLength(2);
  });
});

describe('PDF/A-2b output', () => {
  it('rejects standard-font fallbacks rather than emitting nonconforming output', async () => {
    await expect(renderToBuffer({ body: [{ type: 'paragraph', content: 'Archive me' }] }, { pdfa: 'PDF/A-2b' }))
      .rejects.toThrow(/requires embedded fonts/);
  });

  it('rejects encrypted output', () => {
    expect(() => createReport({
      encrypt: { userPassword: 'secret' },
      body: [],
    }, { pdfa: 'PDF/A-2b' })).toThrow(/cannot be encrypted/);
  });

  it.skipIf(!hasArial)('writes PDF/A-2b metadata and output intent with embedded fonts', async () => {
    const bytes = await renderToBuffer(
      { ...report, style: { fontFamily: 'Arial' } },
      {
        pdfa: 'PDF/A-2b',
        fonts: [
          { family: 'Arial', buffer: readFileSync(ARIAL) },
          { family: 'Arial', weight: 700, buffer: readFileSync(ARIAL_BOLD) },
        ],
      },
    );
    const pdf = bytes.toString('latin1');

    expect(pdf.startsWith('%PDF-1.7')).toBe(true);
    expect(pdf).toContain('pdfaid:part>2');
    expect(pdf).toContain('pdfaid:conformance>B');
    expect(pdf).toContain('/OutputIntents');
  });
});
