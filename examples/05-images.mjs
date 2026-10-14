/**
 * Example 05 — images from every source: raw bytes, a local file path, and an
 * online URL resolved through a custom loader.
 *
 *   node examples/05-images.mjs
 *
 * Offline sources (bytes / path / `data:` URI) are handled synchronously. An
 * `http(s)` `src` is fetched by `renderToBuffer`'s pre-pass; here we supply a
 * `resolveImage` hook that returns local bytes so the example runs with NO
 * network. In production, drop the hook and the built-in fetch is used, or keep
 * the hook to route through a proxy/cache/auth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderToBuffer } from 'pdf-report-engine';

const logoPath = path.resolve('samples/assets/logo.png');
const logoBytes = new Uint8Array(fs.readFileSync(logoPath));

const report = {
  info: { title: 'Images: bytes, path, online' },
  page: { size: 'a4', margin: 48 },
  style: { fontFamily: 'Helvetica', fontSize: 11 },
  body: [
    { type: 'heading', level: 1, content: 'Images from a JS caller', fontSize: 16, color: '#1a3d6d', marginBottom: 8 },

    { type: 'paragraph', content: '1. Raw bytes (Uint8Array) — width only, height follows the aspect ratio:', marginBottom: 2 },
    { type: 'image', src: logoBytes, width: 240, align: 'center' },

    { type: 'paragraph', content: '2. A local filesystem path, with a border:', marginTop: 14, marginBottom: 2 },
    { type: 'image', src: logoPath, width: 200, height: 90, align: 'center', border: 1, paddingTop: 4, paddingBottom: 4 },

    { type: 'paragraph', content: '3. An online URL, resolved via the resolveImage hook (network-free here):', marginTop: 14, marginBottom: 2 },
    { type: 'image', src: 'https://cdn.example.com/chart.png', width: 180, align: 'center' },
  ],
};

const pdf = await renderToBuffer(report, {
  images: {
    // Return the image bytes for any requested URL. Swap for `fetch(url)` in real use.
    resolveImage: async (url) => {
      console.log(`  (resolveImage called for ${url})`);
      return logoBytes;
    },
    timeoutMs: 10_000,
    onError: 'throw',
  },
});

fs.mkdirSync('output/examples', { recursive: true });
fs.writeFileSync('output/examples/05-images.pdf', pdf);
console.log(`wrote output/examples/05-images.pdf (${pdf.length} bytes)`);
