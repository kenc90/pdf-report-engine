/**
 * Lightweight image metadata helpers. This module is deliberately pdfkit-free:
 * the layout pass must not touch the writer, so we read just enough of a file
 * header to learn the image's intrinsic pixel size and aspect ratio.
 *
 * `src` may be a filesystem path, a `data:` URI, or raw bytes. Remote `http(s)`
 * URLs are never fetched here (the layout pass is offline; see `remote-image.ts`
 * for the online pre-pass); for those, supply explicit `width`/`height`.
 *
 * A filesystem path can only be read in Node, and only through an injected reader
 * (`setImageFileReader`, wired by the CLI) or, where available, `process.getBuiltinModule`.
 * In a browser neither exists, so a path source yields `null` — pass bytes, a
 * `data:` URI, or an `http(s)` URL instead. This module deliberately avoids a
 * top-level `node:fs` import so it can be bundled for the browser.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** Pluggable synchronous file reader for path-based images (Node side). */
export type ImageFileReader = (path: string) => Uint8Array;
let imageFileReader: ImageFileReader | null = null;

/**
 * Register a reader so `probeImageSize`/`loadImageBytes` can open filesystem
 * paths. The Node CLI calls this once at startup; browser callers can ignore it.
 * Pass `null` to clear.
 */
export function setImageFileReader(reader: ImageFileReader | null): void {
  imageFileReader = reader;
}

/**
 * Resolve Node's `fs.readFileSync` synchronously *without* a static `node:fs`
 * import, so bundlers don't try to resolve it for the browser. Relies on
 * `process.getBuiltinModule` (Node ≥ 20.11 / 22.3); returns `null` elsewhere.
 */
function builtinReadFileSync(): ImageFileReader | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return null;
  try {
    const fsMod = get.call(proc, 'node:fs') as { readFileSync?: (p: string) => ArrayLike<number> } | undefined;
    const rf = fsMod?.readFileSync;
    return typeof rf === 'function' ? (p: string) => new Uint8Array(rf(p)) : null;
  } catch {
    return null;
  }
}

/** px → pt at a nominal 96 dpi (matches browser CSS pixels). */
export function pxToPt(px: number, dpi = 96): number {
  return (px * 72) / dpi;
}

function isHttp(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** Base64 → bytes, using `Buffer` (Node) or `atob` (browser), whichever exists. */
function base64ToBytes(body: string): Uint8Array {
  const g = globalThis as { Buffer?: { from: (s: string, e: string) => ArrayLike<number> }; atob?: (s: string) => string };
  if (typeof g.Buffer?.from === 'function') return new Uint8Array(g.Buffer.from(body, 'base64'));
  if (typeof g.atob === 'function') {
    const bin = g.atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error('no base64 decoder available (need Buffer or atob)');
}

function decodeDataUri(src: string): Uint8Array | null {
  const comma = src.indexOf(',');
  if (comma < 0) return null;
  const meta = src.slice(0, comma);
  const body = src.slice(comma + 1);
  if (!/;base64/i.test(meta)) return null;
  try {
    return base64ToBytes(body.replace(/\s+/g, ''));
  } catch {
    return null;
  }
}

/** Load the image bytes, or `null` for URLs / unreadable sources. */
export function loadImageBytes(src: string | Uint8Array): Uint8Array | null {
  if (typeof src !== 'string') return src;
  if (src.startsWith('data:')) return decodeDataUri(src);
  if (isHttp(src)) return null;
  try {
    const reader = imageFileReader ?? builtinReadFileSync();
    return reader ? reader(src) : null;
  } catch {
    return null;
  }
}

/**
 * Read intrinsic pixel dimensions from the file header. Supports PNG, JPEG, GIF
 * and BMP; returns `null` when the format is unknown or the bytes unavailable.
 */
export function probeImageSize(src: string | Uint8Array): ImageSize | null {
  const bytes = loadImageBytes(src);
  if (!bytes || bytes.length < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 ... IHDR width/height are big-endian uint32 at 16 / 20.
  if (dv.getUint32(0) === 0x8950_4e47 && dv.getUint16(12) === 0x4948 /* 'IH' */) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF: 'GIF8', little-endian width/height at 6 / 8.
  if (dv.getUint16(0) === 0x4749 /* 'GI' */) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  // BMP: 'BM', little-endian int32 width/height at 18 / 22.
  if (dv.getUint16(0) === 0x424d) {
    const w = Math.abs(dv.getInt32(18, true));
    const h = Math.abs(dv.getInt32(22, true));
    return { width: w, height: h };
  }
  // JPEG: starts FFD8, walk segments to a start-of-frame (SOFn) marker.
  if (dv.getUint16(0) === 0xffd8) {
    let p = 2;
    while (p < bytes.length - 9) {
      if (bytes[p] !== 0xff) {
        p += 1;
        continue;
      }
      const marker = bytes[p + 1]!;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 (skip DHT/JPEG-ext).
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { height: dv.getUint16(p + 5), width: dv.getUint16(p + 7) };
      }
      const len = dv.getUint16(p + 2);
      p += 2 + len;
    }
  }
  return null;
}
