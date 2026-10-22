/**
 * Server-hardening switches.
 *
 * Three things a host needs when it renders documents somebody *sent* it rather
 * than documents it wrote itself: bounded downloads, a way to close filesystem
 * path sources, and a way to stop pdfkit holding a second copy of the document.
 * All three are opt-in, so this file also pins the defaults — what an existing
 * caller gets today must stay exactly what it gets tomorrow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  renderToBuffer,
  resolveRemoteImages,
  setImagePathAccess,
  setImageFileReader,
  imagePathAccessEnabled,
  type ReportDoc,
} from '../src/index.js';
import { createReport } from '../src/render.js';
import { probeImageSize } from '../src/core/image.js';
import { resolveRemoteFonts } from '../src/fonts/remote.js';

const KB = 1024;
const MB = 1024 * KB;

const LOGO = new Uint8Array(fs.readFileSync(new URL('../samples/assets/logo.png', import.meta.url)));
const LOGO_PATH = fileURLToPath(new URL('../samples/assets/logo.png', import.meta.url));

const imageDoc = (src: string): ReportDoc => ({
  body: [{ type: 'image', src, width: 60 }],
});

// --- bounded downloads ------------------------------------------------------

/**
 * A fetch stub with a streamable body, recording what the reader actually touched:
 * the point of these tests is what is *not* read.
 */
function stubFetch(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { reads: 0, bytesSeen: 0, cancelled: false, arrayBufferCalls: 0 };
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch: unknown }).fetch = async () => {
    let next = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      arrayBuffer: () => {
        state.arrayBufferCalls += 1;
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        return Promise.resolve(all.buffer as ArrayBuffer);
      },
      body: {
        getReader: () => ({
          read: () => {
            if (next >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            const chunk = chunks[next++]!;
            state.reads += 1;
            state.bytesSeen += chunk.length;
            return Promise.resolve({ done: false, value: chunk });
          },
          cancel: () => {
            state.cancelled = true;
            return Promise.resolve();
          },
          releaseLock: () => {},
        }),
      },
    };
  };
  return { state, restore: () => ((globalThis as { fetch: unknown }).fetch = previous) };
}

const block = (n: number) => new Uint8Array(n);

describe('maxBytes bounds the download, not just the verdict', () => {
  it('rejects an oversized declared body without reading it at all', async () => {
    const stub = stubFetch([block(4 * KB)], { 'content-length': String(400 * KB) });
    try {
      await expect(
        resolveRemoteImages(imageDoc('https://x.test/big.png'), { maxBytes: 10 * KB }),
      ).rejects.toThrow(/image exceeds 10240 bytes/);
      expect(stub.state.reads).toBe(0);
      expect(stub.state.arrayBufferCalls).toBe(0);
    } finally {
      stub.restore();
    }
  });

  it('cancels a chunked body the moment it crosses the cap', async () => {
    // No content-length, so the size is only knowable while reading. We must stop at
    // the chunk that goes over rather than buffering the whole 24 KiB.
    const stub = stubFetch([block(6 * KB), block(6 * KB), block(6 * KB), block(6 * KB)]);
    try {
      await expect(
        resolveRemoteImages(imageDoc('https://x.test/big.png'), { maxBytes: 10 * KB }),
      ).rejects.toThrow(/image exceeds 10240 bytes/);
      expect(stub.state.reads).toBe(2);
      expect(stub.state.bytesSeen).toBeLessThanOrEqual(12 * KB);
      expect(stub.state.cancelled).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('reassembles an in-budget body from its chunks, byte for byte', async () => {
    const stub = stubFetch([LOGO.slice(0, 3 * KB), LOGO.slice(3 * KB)]);
    try {
      const out = await resolveRemoteImages(imageDoc('https://x.test/logo.png'), { maxBytes: MB });
      const src = (out.body![0] as { src: Uint8Array }).src;
      expect(Buffer.from(src)).toEqual(Buffer.from(LOGO));
      expect(stub.state.cancelled).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('applies the same bound to remote fonts (skipped by default, fatal on request)', async () => {
    const stub = stubFetch([block(64 * KB)], { 'content-length': String(64 * KB) });
    const doc: ReportDoc = {
      fonts: [{ type: 'url', url: 'https://x.test/big.ttf', family: 'Big' }],
      body: [{ type: 'paragraph', content: 'x' }],
    };
    try {
      await expect(resolveRemoteFonts(doc, { maxBytes: 10 * KB })).resolves.toEqual([]);
      await expect(resolveRemoteFonts(doc, { maxBytes: 10 * KB, onError: 'throw' })).rejects.toThrow(
        /font exceeds 10240 bytes/,
      );
      expect(stub.state.arrayBufferCalls).toBe(0);
    } finally {
      stub.restore();
    }
  });
});

// --- filesystem path sources ------------------------------------------------

describe('setImagePathAccess', () => {
  // Wire the reader the CLI would install, so "allowed" means a real disk read here
  // rather than depending on `process.getBuiltinModule` being available.
  beforeEach(() => {
    setImageFileReader((p) => new Uint8Array(fs.readFileSync(p)));
  });

  afterEach(() => {
    setImagePathAccess('allow');
    setImageFileReader(null);
  });

  it('defaults to allowing paths, exactly as before', () => {
    expect(imagePathAccessEnabled()).toBe(true);
    expect(probeImageSize(LOGO_PATH)).toEqual({ width: 600, height: 260 });
  });

  it('opens no file at all once denied', () => {
    setImagePathAccess('deny');
    expect(imagePathAccessEnabled()).toBe(false);
    expect(probeImageSize(LOGO_PATH)).toBeNull();
  });

  it('still embeds paths while allowed', async () => {
    const pdf = await renderToBuffer(imageDoc(LOGO_PATH), {});
    expect(pdf.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  });

  it('refuses to embed a path once denied', async () => {
    setImagePathAccess('deny');
    await expect(renderToBuffer(imageDoc(LOGO_PATH), {})).rejects.toThrow(/filesystem path/);
    await expect(renderToBuffer(imageDoc('/etc/passwd'), {})).rejects.toThrow(/filesystem path/);
  });

  it('leaves data: URIs and http(s) URLs usable while denied', async () => {
    setImagePathAccess('deny');
    const b64 = Buffer.from(LOGO).toString('base64');
    const pdf = await renderToBuffer(imageDoc(`data:image/png;base64,${b64}`), {});
    expect(pdf.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);

    const stub = stubFetch([LOGO]);
    try {
      const remote = await renderToBuffer(imageDoc('https://x.test/logo.png'), {});
      expect(remote.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
    } finally {
      stub.restore();
    }
  });
});

// --- page buffering ---------------------------------------------------------

/** pdfkit's internal page buffer, which is exactly what the option controls. */
function heldPages(doc: unknown): number {
  return ((doc as { _pageBuffer: unknown[] })._pageBuffer ?? []).length;
}

const longDoc = (pages: number): ReportDoc => {
  const body: ReportDoc['body'] = [];
  for (let p = 0; p < pages; p += 1) {
    if (p > 0) body.push({ type: 'pageBreak' });
    for (let i = 0; i < 30; i += 1) {
      body.push({ type: 'paragraph', content: `Page ${p + 1}, line ${i + 1}: the quick brown fox jumps over the lazy dog.` });
    }
  }
  return { body };
};

describe('bufferPages', () => {
  it('keeps every page buffered by default, and releases them when asked', () => {
    const buffered = createReport(longDoc(4)).doc;
    const streamed = createReport(longDoc(4), { bufferPages: false }).doc;
    expect((buffered as unknown as { options: { bufferPages: boolean } }).options.bufferPages).toBe(true);
    expect(heldPages(buffered)).toBe(4);
    // With buffering off, each page is flushed as the next one starts.
    expect(heldPages(streamed)).toBeLessThan(4);
  });

  it('produces an equivalent document either way', async () => {
    const report = longDoc(2);
    const latin = [(await renderToBuffer(report, {})).toString('latin1'), (await renderToBuffer(report, { bufferPages: false })).toString('latin1')];
    for (const text of latin) {
      expect(text.startsWith('%PDF-')).toBe(true);
      expect(text).toMatch(/%%EOF/);
      // The page tree counts both pages however the streams were flushed.
      expect(text).toMatch(/\/Type\s*\/Pages[\s\S]*?\/Count\s*2/);
    }
  });
});
