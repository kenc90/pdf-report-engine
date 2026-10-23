/**
 * PDF encryption + CSS visual-polish (border-radius / box-shadow / linear-gradient).
 *
 * Covers the resolve helpers, the layout command emission, the HTML-adapter CSS
 * parsing and end-to-end renders (including that the security handler actually
 * lands in the byte stream).
 */
import { describe, it, expect } from 'vitest';
import { createReport, renderToBuffer, htmlToReportDoc } from '../src/index.js';
import { resolveRadius, resolveShadow, resolveGradient } from '../src/layout/box.js';
import type { ReportDoc, ParagraphBlock, BoxProps } from '../src/ir/schema.js';

const para = (over: Partial<BoxProps>): ReportDoc => ({
  body: [{ type: 'paragraph', content: 'Hello polished world', ...over } as ParagraphBlock],
});

describe('resolve helpers', () => {
  it('resolveRadius maps CSS shorthand order to [tl,tr,br,bl] in pt', () => {
    expect(resolveRadius({ borderRadius: 8 })).toEqual([8, 8, 8, 8]);
    expect(resolveRadius({ borderRadius: [4, 8] })).toEqual([4, 8, 4, 8]);
    expect(resolveRadius({ borderRadius: [4, 8, 12, 16] })).toEqual([4, 8, 12, 16]);
    // 12px -> 9pt (PX_TO_PT = 0.75).
    expect(resolveRadius({ borderRadius: '12px' })).toEqual([9, 9, 9, 9]);
    expect(resolveRadius({})).toBeUndefined();
  });

  it('resolveShadow reads offsets/blur/colour and drops inset', () => {
    const s = resolveShadow({ boxShadow: { offsetX: 2, offsetY: 3, blur: 6, color: '#000' } });
    expect(s).toEqual({ dx: 2, dy: 3, blur: 6, color: [0, 0, 0], opacity: 0.28 });
    expect(resolveShadow({ boxShadow: { offsetX: 1, offsetY: 1, inset: true } })).toBeUndefined();
    expect(resolveShadow({})).toBeUndefined();
  });

  it('resolveGradient snaps directions and colours', () => {
    const g = resolveGradient({ backgroundImage: { from: '#fff', to: '#000', direction: '90deg' } });
    expect(g).toEqual({ from: [1, 1, 1], to: [0, 0, 0], dir: 'right' });
    expect(resolveGradient({ backgroundImage: { from: 'red', to: 'blue' } })?.dir).toBe('bottom');
    expect(resolveGradient({ backgroundImage: { from: 'red', to: 'blue', direction: 'to top' } })?.dir).toBe('top');
        // Corner syntax snaps to the vertical axis instead of erroring (regression).
        expect(resolveGradient({ backgroundImage: { from: 'red', to: 'blue', direction: 'to bottom right' } })?.dir).toBe('bottom');
        expect(resolveGradient({ backgroundImage: { from: 'red', to: 'blue', direction: 'to top left' } })?.dir).toBe('top');
    expect(resolveGradient({})).toBeUndefined();
  });
});

describe('layout emits polish commands', () => {
  it('a gradient + radius + shadow paragraph paints a decorated background', () => {
    const { pages } = createReport(
      para({
        backgroundColor: '#eee',
        backgroundImage: { from: '#fff', to: '#00f' },
        borderRadius: 6,
        boxShadow: { offsetX: 1, offsetY: 2, blur: 4, color: '#000' },
      }),
    );
    const fills = pages
      .flatMap((p) => [...p.header, ...p.body, ...p.footer])
      .flatMap((pf) => pf.fragment.commands)
      .filter((c) => c.op === 'fillRect');
    expect(fills.length).toBeGreaterThan(0);
    const first = fills[0];
    expect(first?.op).toBe('fillRect');
    if (first?.op === 'fillRect') {
      expect(first.gradient).toBeDefined();
      expect(first.shadow).toBeDefined();
      expect(first.radius).toBeDefined();
      // Gradient carries box-relative sampling info.
      expect(first.gradient!.boxHeight).toBeGreaterThan(0);
    }
  });

  it('a single-line box rounds all four corners; multi-line rounds only outer edges', () => {
    // One short line -> the single fragment is both first and last, so all four
    // corners round.
    const one = createReport(para({ backgroundColor: '#eee', borderRadius: 8 })).pages
      .flatMap((p) => p.body)
      .flatMap((pf) => pf.fragment.commands)
      .find((c) => c.op === 'fillRect');
    expect(one && one.op === 'fillRect' && one.radius).toEqual([8, 8, 8, 8]);

    const two = createReport(
      {
        page: { size: [60, 200], margin: 8 },
        body: [{ type: 'paragraph', content: 'a'.repeat(400), backgroundColor: '#eee', borderRadius: 8 } as ParagraphBlock],
      },
    ).pages
      .flatMap((p) => p.body)
      .flatMap((pf) => pf.fragment.commands)
      .filter((c): c is Extract<typeof c, { op: 'fillRect' }> => c.op === 'fillRect' && !!c.radius);
    const withTop = two.filter((c) => c.radius![0] > 0 || c.radius![1] > 0);
    const withBottom = two.filter((c) => c.radius![2] > 0 || c.radius![3] > 0);
    expect(withTop.length).toBeGreaterThan(0);
    expect(withBottom.length).toBeGreaterThan(0);
    // No interior fragment rounds both a top and a bottom corner.
    expect(two.every((c) => !(c.radius![0] > 0 && c.radius![2] > 0))).toBe(true);
  });
});

describe('html adapter CSS parsing', () => {
  it('parses border-radius / box-shadow / linear-gradient', () => {
    const doc = htmlToReportDoc(
      '<p style="border-radius: 6px; box-shadow: 2px 3px 6px rgba(0,0,0,0.4); background: linear-gradient(to right, #fff, #336)"></p>',
    );
    const block = doc.body![0] as ParagraphBlock;
    expect(block.borderRadius).toEqual([4.5, 4.5, 4.5, 4.5]); // 6px -> 4.5pt
    expect(block.boxShadow).toMatchObject({ offsetX: 1.5, offsetY: 2.25, blur: 4.5, color: 'rgba(0,0,0,0.4)' });
    expect(block.backgroundImage).toMatchObject({ direction: 'to right', from: '#fff', to: '#336' });
  });

  it('keeps a plain background colour as backgroundColor', () => {
    const doc = htmlToReportDoc('<p style="background: #ff0000"></p>');
    const block = doc.body![0] as ParagraphBlock;
    expect(block.backgroundColor).toBe('#ff0000');
    expect(block.backgroundImage).toBeUndefined();
  });
});

describe('renders stay valid', () => {
  it('writes a PDF that carries an /Encrypt dictionary when a password is set', async () => {
    const plain = await renderToBuffer(para({ backgroundColor: '#eee' }));
    expect(plain.toString('latin1')).not.toContain('/Encrypt');

    const locked = await renderToBuffer({
      ...para({}),
      encrypt: { userPassword: 's3cret', ownerPassword: 'owner', permissions: { printing: false, copying: false } },
    });
    const text = locked.toString('latin1');
    expect(text).toContain('/Encrypt');
    expect(text).toContain('/Filter');
  });

  it('renders a gradient + rounded + shadowed image block end-to-end', async () => {
    const buf = await renderToBuffer({
      body: [
        {
          type: 'paragraph',
          content: 'Card',
          backgroundColor: '#f0f0f0',
          backgroundImage: { from: '#ffffff', to: '#335599', direction: 'to bottom' },
          borderRadius: [0, 8, 0, 8],
          boxShadow: { offsetX: 2, offsetY: 2, blur: 3, color: '#222222' },
          padding: 10,
        } as ParagraphBlock,
      ],
    });
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
