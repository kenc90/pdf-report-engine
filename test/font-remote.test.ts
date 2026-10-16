/**
 * Remote-font resolution tests. Fully offline and deterministic: every network
 * touch is stubbed via `resolveText`/`resolveFont`, and WOFF2 decoding is injected
 * via `decodeWoff2`, so no binary fonts or live requests are needed. We assert on
 * the CSS parsing, format sniffing, subset `instance` tagging, `data:` handling
 * and error policy — the parts that decide what gets embedded.
 */
import { describe, expect, it } from 'vitest';
import { parseFontFace, resolveRemoteFonts } from '../src/fonts/remote.js';
import { htmlToReportDoc } from '../src/adapter/html.js';
import type { ReportDoc } from '../src/ir/schema.js';

const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x80]); // sfnt TrueType magic
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]); // "wOF2"

const doc = (fonts: ReportDoc['fonts']): ReportDoc => ({ body: [], fonts });

describe('parseFontFace', () => {
  it('extracts family, weight, style and url from @font-face blocks', () => {
    const css = `
      @font-face {
        font-family: 'Roboto';
        font-style: normal;
        font-weight: 400;
        src: url(https://fonts.gstatic.com/s/roboto/a.woff2) format('woff2');
        unicode-range: U+0000-00FF;
      }
      @font-face {
        font-family: "Roboto";
        font-style: italic;
        font-weight: 700;
        src: url("https://fonts.gstatic.com/s/roboto/b.woff2") format("woff2");
      }`;
    const rules = parseFontFace(css);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ family: 'Roboto', weight: 400, style: 'normal' });
    expect(rules[0]!.url).toBe('https://fonts.gstatic.com/s/roboto/a.woff2');
    expect(rules[1]).toMatchObject({ family: 'Roboto', weight: 700, style: 'italic' });
  });

  it('uses the leading number of a variable weight range and defaults weight/style', () => {
    const rules = parseFontFace(`@font-face { font-family: X; font-weight: 100 900; src: url(u.woff2); }`);
    expect(rules[0]).toMatchObject({ family: 'X', weight: 100, style: 'normal' });
  });

  it('ignores blocks without a family or url', () => {
    expect(parseFontFace(`@font-face { font-family: NoSrc; } @font-face { src: url(u.woff2); }`)).toEqual([]);
  });
});

describe('resolveRemoteFonts', () => {
  it('resolves a Google reference through the CSS into one face per URL', async () => {
    let decoded = false;
    const sources = await resolveRemoteFonts(
      doc([{ type: 'google', url: 'https://fonts.googleapis.com/css2?family=Roboto' }]),
      {
        resolveText: async () =>
          `@font-face{font-family:'Roboto';font-weight:400;src:url(https://fonts.gstatic.com/x.woff2)}`,
        resolveFont: async () => WOFF2,
        decodeWoff2: async () => {
          decoded = true;
          return TTF;
        },
        onError: 'throw',
      },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ family: 'Roboto', weight: 400, style: 'normal' });
    expect(decoded).toBe(true); // WOFF2 branch taken
  });

  it('tags same family/weight/style subsets with distinct instances, first is the primary', async () => {
    const sources = await resolveRemoteFonts(
      doc([{ type: 'font-face', css: `
        @font-face{font-family:'Roboto';font-weight:400;src:url(https://f/a.ttf)}
        @font-face{font-family:'Roboto';font-weight:400;src:url(https://f/b.ttf)}` }]),
      { resolveFont: async () => TTF, onError: 'throw' },
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]!.instance).toBeUndefined();
    expect(sources[1]!.instance).toBe('1');
    expect(sources.every((s) => s.family === 'Roboto' && s.weight === 400)).toBe(true);
  });

  it('reads a data: URI font without the network', async () => {
    const b64 = Buffer.from(TTF).toString('base64');
    const sources = await resolveRemoteFonts(
      doc([{ type: 'font-face', css: `@font-face{font-family:'Inline';src:url(data:font/ttf;base64,${b64})}` }]),
      { fetchRemote: false, onError: 'throw' },
    );
    expect(sources[0]).toMatchObject({ family: 'Inline' });
  });

  it('skips an unreachable reference by default but throws when onError:"throw"', async () => {
    const ref = [{ type: 'google' as const, url: 'https://fonts.googleapis.com/css2?family=Missing' }];
    await expect(
      resolveRemoteFonts(doc(ref), { resolveText: async () => { throw new Error('offline'); } }),
    ).resolves.toEqual([]);
    await expect(
      resolveRemoteFonts(doc(ref), { resolveText: async () => { throw new Error('offline'); }, onError: 'throw' }),
    ).rejects.toThrow(/offline/);
  });

  it('honours fetchRemote:false (air-gapped) by skipping network faces', async () => {
    const sources = await resolveRemoteFonts(
      doc([{ type: 'url', url: 'https://fonts.gstatic.com/x.ttf', family: 'Roboto' }]),
      { fetchRemote: false },
    );
    expect(sources).toEqual([]);
  });

  it('time-boxes a stalled WOFF2 decoder, skips faces, and never hangs', async () => {
    // Regression: wawoff2's WASM runtime can hang forever in some browser sandboxes.
    // A non-settling decoder must be abandoned via the timeout (onError defaults to
    // skip), and the circuit breaker must stop attempting the remaining WOFF2 faces.
    let decodeCalls = 0;
    const css = `
      @font-face{font-family:'F';font-weight:400;src:url(https://f/a.woff2)}
      @font-face{font-family:'F';font-weight:700;src:url(https://f/b.woff2)}`;
    const sources = await resolveRemoteFonts(doc([{ type: 'font-face', css }]), {
      resolveFont: async () => WOFF2,
      decodeWoff2: () => {
        decodeCalls += 1;
        return new Promise<Uint8Array>(() => {}); // never settles
      },
      decodeTimeoutMs: 25,
    });
    expect(sources).toEqual([]); // both faces skipped (not embedded), render proceeds
    expect(decodeCalls).toBe(1); // breaker: only the first face is attempted
  });

  it('returns [] when the report declares no fonts', async () => {
    await expect(resolveRemoteFonts({ body: [] })).resolves.toEqual([]);
  });
});

describe('htmlToReportDoc font capture', () => {
  it('collects Google <link>, @import and inline @font-face into report.fonts', () => {
    const report = htmlToReportDoc(`<html><head>
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap" rel="stylesheet">
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap');
        @font-face { font-family: 'LocalSerif'; src: url(https://cdn.example/serif.woff2); }
      </style>
    </head><body><p style="font-family:Roboto">Hi</p></body></html>`);
    const kinds = (report.fonts ?? []).map((f) => f.type);
    expect(kinds).toContain('google'); // from <link> AND @import (deduped to two google urls)
    expect(kinds).toContain('font-face'); // the inline @font-face style block
    const googleUrls = (report.fonts ?? []).filter((f) => f.type === 'google').map((f) => (f as { url: string }).url);
    expect(googleUrls.some((u) => /family=Roboto/.test(u))).toBe(true);
    expect(googleUrls.some((u) => /family=Playfair/.test(u))).toBe(true);
  });

  it('leaves report.fonts undefined for ordinary documents', () => {
    expect(htmlToReportDoc('<body><p>plain</p></body>').fonts).toBeUndefined();
  });
});
