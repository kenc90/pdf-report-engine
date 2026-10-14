/**
 * Remote-image resolution tests. No network is used: a mock `resolveImage`
 * returns the repo's sample PNG, exercising the URL -> bytes -> layout -> embed
 * path and the offline guards.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { resolveRemoteImages } from '../src/core/remote-image.js';
import { renderToBuffer } from '../src/index.js';
import type { ReportDoc, ImageBlock } from '../src/ir/schema.js';

const LOGO = new Uint8Array(fs.readFileSync(new URL('../samples/assets/logo.png', import.meta.url)));

const docWithImage = (src: string, extra: Partial<ImageBlock> = {}): ReportDoc => ({
  body: [{ type: 'image', src, width: 200, ...extra } as ImageBlock],
});

describe('resolveRemoteImages', () => {
  it('turns an http(s) src into embedded bytes with an inferred intrinsic size', async () => {
    const out = await resolveRemoteImages(docWithImage('https://x.test/logo.png'), {
      resolveImage: async () => LOGO,
    });
    const img = out.body![0] as ImageBlock;
    expect(img.src).toBeInstanceOf(Uint8Array);
    expect(img.intrinsic).toEqual({ width: 600, height: 260 });
  });

  it('caches by URL so the same image is fetched only once', async () => {
    let calls = 0;
    const doc: ReportDoc = {
      body: [
        { type: 'image', src: 'https://x.test/a.png', width: 100 } as ImageBlock,
        { type: 'image', src: 'https://x.test/a.png', width: 150 } as ImageBlock,
      ],
    };
    const out = await resolveRemoteImages(doc, {
      resolveImage: async () => {
        calls += 1;
        return LOGO;
      },
    });
    expect(calls).toBe(1);
    expect((out.body![1] as ImageBlock).src).toBeInstanceOf(Uint8Array);
  });

  it('leaves non-remote sources (data:/path/bytes) untouched', async () => {
    const doc = docWithImage('data:image/png;base64,AAAA');
    const out = await resolveRemoteImages(doc, { resolveImage: async () => LOGO });
    expect(out.body![0]).toBe(doc.body![0]); // same node, no fetch
  });

  it('throws when a remote image is requested with fetching disabled', async () => {
    await expect(
      resolveRemoteImages(docWithImage('https://x.test/logo.png'), { fetchRemote: false }),
    ).rejects.toThrow(/remote image/i);
  });

  it('skips (zeroes) the image on load failure when onError is "skip"', async () => {
    const out = await resolveRemoteImages(docWithImage('https://x.test/logo.png'), {
      resolveImage: async () => null,
      onError: 'skip',
    });
    const img = out.body![0] as ImageBlock;
    expect(img.intrinsic).toEqual({ width: 0, height: 0 });
  });

  it('renders a remote image end-to-end into a PDF that embeds an /Image XObject', async () => {
    const buffer = await renderToBuffer(docWithImage('https://x.test/logo.png'), {
      images: { resolveImage: async () => LOGO },
    });
    const latin = buffer.toString('latin1');
    expect(latin.startsWith('%PDF-')).toBe(true);
    expect(latin).toMatch(/\/Subtype\s*\/Image|\/Image/);
  });
});
