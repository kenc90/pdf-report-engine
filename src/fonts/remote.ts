/**
 * Remote-font resolution — the font twin of `resolveRemoteImages()`.
 *
 * The layout/render pass is synchronous and must never touch the network, so this
 * async pre-pass runs first: it expands the IR's declarative font references
 * (Google Fonts `<link>`/`@import`, inline `@font-face`, or a direct font-file
 * URL) into embeddable `FontSource[]`.
 *
 * Format reality (all verified against the live Google Fonts API):
 *   - `fonts.googleapis.com/css2` is UA-driven. A Node `fetch` (non-browser UA)
 *     is served **TTF**; a browser (UA cannot be overridden) is served **WOFF2**.
 *     Both the CSS and the `fonts.gstatic.com` files send
 *     `Access-Control-Allow-Origin: *`, so a browser can `fetch` them.
 *   - fontkit/pdfkit read TTF/OTF/TTC but NOT WOFF2 (brotli + outline
 *     transforms). We decode WOFF2 -> TTF with the optional `wawoff2` WebAssembly
 *     module. So one pipeline works everywhere: Node embeds the TTF directly, the
 *     browser decodes the WOFF2 it received.
 *
 * Google ships one file per script (`unicode-range`): latin, latin-ext, cyrillic,
 * ... Each becomes its own `FontSource`, tagged with an `instance` so they
 * coexist in the registry; the first is `resolve()`'s target and the others are
 * reached through per-glyph fallback (see `FontRegistry`).
 */
import type { ReportDoc, FontReference } from '../ir/schema.js';
import type { FontSource } from './registry.js';
import { collectCharset } from './charset.js';
import { readBoundedBytes, type LimitedFetchResponse } from '../core/fetch-body.js';

export interface FontResolveOptions {
  /** Fetch remote font CSS/files. Default `true`. Set `false` for air-gapped renders. */
  fetchRemote?: boolean;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /**
   * Refuse font files larger than this many bytes. Default 25 MiB.
   * Enforced while streaming, so an oversized body is cancelled rather than buffered.
   */
  maxBytes?: number;
  /** Custom loader for font *bytes* (proxy, auth, cache, fixtures). Overrides built-in fetch. */
  resolveFont?: (url: string) => Promise<Uint8Array | null>;
  /** Custom loader for stylesheet *text*. Overrides built-in fetch. */
  resolveText?: (url: string) => Promise<string | null>;
  /** Override the WOFF2 -> TTF decoder (defaults to a lazy `wawoff2` import). */
  decodeWoff2?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /**
   * Hard ceiling on a single WOFF2 -> TTF decode, in ms. Default 8000.
   *
   * `wawoff2`'s WebAssembly runtime can fail to initialise in unusual browser
   * sandboxes and then hang *forever* (the decode promise never settles). We race
   * it against this timeout so a stalled decoder is skipped (falling back to base-14
   * or another registered face) instead of dead-locking the whole render. Healthy
   * decoders finish a webfont subset in tens of milliseconds, far under this limit.
   */
  decodeTimeoutMs?: number;
  /** What to do when a font reference cannot be resolved. Default `'skip'`. */
  onError?: 'throw' | 'skip';
  /** Hard cap on faces produced per call, to bound network use. Default 64. */
  maxFaces?: number;
  /**
   * When `true` (default), Google Fonts CSS URLs are augmented with a `text=`
   * parameter containing the characters the report actually renders, so Google
   * returns a minimal subset (typically 30–50 KB vs a multi-MB full font). This
   * dramatically speeds up WOFF2 decoding in constrained environments and reduces
   * memory usage. Set `false` to always fetch the full font.
   */
  subsetText?: boolean;
}

/** A single parsed `@font-face` (or synthesised) face awaiting its bytes. */
interface FaceRule {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  url: string;
  postscriptName?: string;
}

interface Abortable {
  signal?: unknown;
}
interface FetchResponse extends LimitedFetchResponse {
  text(): Promise<string>;
}
type FetchLike = (url: string, init?: Abortable) => Promise<FetchResponse>;

const REMOTE = /^https?:\/\//i;

/** Minimal User-Agent that makes Google return TTF (ignored by browsers). */
const TTF_USER_AGENT = 'Mozilla/4.0 (compatible; pdf-report-engine/1.0)';

function isBrowser(): boolean {
  return typeof (globalThis as { window?: unknown }).window !== 'undefined';
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race a promise against a timeout. Unlike `withTimeout` this works for
 * non-abortable promises (e.g. `wawoff2.decompress`, which ignores signals): if
 * the promise never settles we reject and move on, abandoning the dangling one.
 */
function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function defaultFetchBytes(url: string, opts: FontResolveOptions): Promise<Uint8Array | null> {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  if (!fetchImpl) throw new Error('global fetch is unavailable (Node 18+ / a browser required) for remote fonts');
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const res = await withTimeout((signal) => fetchImpl(url, { signal }), opts.timeoutMs ?? 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readBoundedBytes(res, maxBytes, 'font');
}

async function defaultFetchText(url: string, opts: FontResolveOptions): Promise<string | null> {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  if (!fetchImpl) throw new Error('global fetch is unavailable (Node 18+ / a browser required) for remote fonts');
  // In Node we can ask for TTF by sending a legacy UA; browsers forbid overriding
  // User-Agent (and adding a custom header would trigger a CORS preflight), so
  // there we fetch plainly and decode the WOFF2 we receive instead.
  const headers = isBrowser() ? undefined : { 'User-Agent': TTF_USER_AGENT };
  const res = await withTimeout(
    (signal) => (fetchImpl as (u: string, i?: unknown) => Promise<FetchResponse>)(url, { signal, headers }),
    opts.timeoutMs ?? 15000,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function base64ToBytes(body: string): Uint8Array {
  const g = globalThis as { Buffer?: { from: (s: string, e: string) => ArrayLike<number> }; atob?: (s: string) => string };
  if (typeof g.Buffer?.from === 'function') return new Uint8Array(g.Buffer.from(body, 'base64'));
  if (typeof g.atob === 'function') {
    const bin = g.atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error('no base64 decoder available (need Buffer or atob)');
}

function decodeDataFont(url: string): Uint8Array | null {
  const m = /^data:[^;]*(?:;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const payload = m[1] ?? '';
  return /;base64/i.test(url.slice(0, url.indexOf(','))) || !payload.includes('%')
    ? base64ToBytes(payload)
    : new Uint8Array(Array.from(decodeURIComponent(payload), (c) => c.charCodeAt(0)));
}

/** Detect the font container from its magic bytes (more reliable than the CSS `format()`). */
function sniffFont(bytes: Uint8Array): 'ttf' | 'otto' | 'ttcf' | 'woff' | 'woff2' | 'unknown' {
  if (bytes.length < 4) return 'unknown';
  const [a, b, c, d] = [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0];
  if (a === 0x00 && b === 0x01 && c === 0x00 && d === 0x00) return 'ttf';
  if (a === 0x74 && b === 0x72 && c === 0x75 && d === 0x65) return 'ttf'; // "true"
  if (a === 0x4f && b === 0x54 && c === 0x54 && d === 0x4f) return 'otto'; // "OTTO"
  if (a === 0x74 && b === 0x74 && c === 0x63 && d === 0x66) return 'ttcf'; // "ttcf"
  if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x32) return 'woff2'; // "wOF2"
  if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x46) return 'woff'; // "wOFF"
  return 'unknown';
}

/**
 * WOFF2 decoder wiring.
 *
 * wawoff2 is an Emscripten-compiled WASM module. Its binding file assigns the
 * module to `module.exports` ONLY inside the ENVIRONMENT_IS_NODE branch of the
 * runtime detection. When bundled for browser (via esbuild/rollup/webpack),
 * `module` is either undefined or refers to the bundler's CJS wrapper — the
 * Emscripten code takes the browser branch and never exports anything. Consumers
 * receive `{}` from `require('wawoff2/build/decompress_binding.js')`, and setting
 * `onRuntimeInitialized` on that empty object disconnects from the real Module
 * (which lives inside the factory scope). Result: the WASM finishes loading but
 * the promise awaiting `onRuntimeInitialized` never resolves → decode hangs.
 *
 * The reliable fix in browser contexts is to load the binding file as a plain
 * `<script>` (not through the bundler). Its top-level `var Module = ...` then
 * lands on `window.Module`, and its `run()` call fires `Module.onRuntimeInitialized`
 * which we can hook directly.
 *
 * In Node we keep the original `await import('wawoff2')` path — its CJS handling
 * correctly exports the Module (via `module["exports"] = Module` inside the Node
 * branch), so the standard promise-based API works.
 */
let _decompressFn: ((b: Uint8Array) => Promise<Uint8Array>) | undefined;
let _initPromise: Promise<void> | undefined;
let _initFailed = false;

async function ensureBrowserWawoff2Ready(): Promise<(b: Uint8Array) => Promise<Uint8Array>> {
  const w = globalThis as unknown as { window: Window & { Module?: any; __wawoff2Loader?: Promise<void> } };
  const wrapDecompress = (Module: any) => async (bytes: Uint8Array): Promise<Uint8Array> => {
    const r = Module.decompress(bytes);
    if (r === false) throw new Error('ConvertWOFF2ToTTF failed');
    if (!r || typeof r.length !== 'number') {
      throw new Error(`wawoff2 returned unexpected value: ${Object.prototype.toString.call(r)}`);
    }
    // Emscripten's embind may return a Uint8Array *view* into the WASM linear
    // memory (HEAPU8). That view becomes detached after the next WASM call or
    // memory grow, so we must copy it out into a stable, standalone buffer
    // before returning. pdfkit/fontkit then see valid, self-owned bytes.
    const out = new Uint8Array(r.length);
    out.set(r);
    return out;
  };
  // Already loaded?
  if (w.window.Module && typeof w.window.Module.decompress === 'function' && w.window.Module.calledRun) {
    return wrapDecompress(w.window.Module);
  }
  // Loader in flight?
  if (!w.window.__wawoff2Loader) {
    w.window.__wawoff2Loader = new Promise<void>((resolve, reject) => {
      const attach = (Module: any) => {
        if (!Module) { reject(new Error('wawoff2 loaded but window.Module missing')); return; }
        if (Module.calledRun) { resolve(); return; }
        const prev = Module.onRuntimeInitialized;
        Module.onRuntimeInitialized = () => {
          if (typeof prev === 'function') { try { prev(); } catch { /* ignore */ } }
          resolve();
        };
      };
      if (w.window.Module) { attach(w.window.Module); return; }
      // Resolve sibling URL relative to the running bundle. `import.meta.url` is
      // available in ESM output; fall back to a well-known path.
      let src = './wawoff2-decoder.js';
      try {
        // @ts-ignore — import.meta is only present in ESM output.
        if (typeof import.meta !== 'undefined' && import.meta.url) src = new URL('./wawoff2-decoder.js', import.meta.url).href;
      } catch { /* keep default */ }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      s.onload = () => attach(w.window.Module);
      document.head.appendChild(s);
    });
  }
  await w.window.__wawoff2Loader;
  if (!w.window.Module || typeof w.window.Module.decompress !== 'function') {
    throw new Error('wawoff2 loaded but Module.decompress unavailable');
  }
  return wrapDecompress(w.window.Module);
}

async function ensureNodeWawoff2Ready(): Promise<(b: Uint8Array) => Promise<Uint8Array>> {
  const mod = await import('wawoff2');
  const fn = mod.decompress;
  if (typeof fn !== 'function') throw new Error('wawoff2.decompress is not available');
  // Force the WASM runtime to initialise by calling decompress with a minimal
  // invalid buffer. The throw confirms the runtime is warm (the error is from
  // invalid data, not from a stuck initialisation). Subsequent real decodes
  // are then fast (<100ms) and can safely live inside a tight per-face timeout.
  try {
    await fn(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]));
  } catch {
    // Expected: 'ConvertWOFF2ToTTF failed' — runtime is now warm.
  }
  return fn;
}

async function ensureWawoff2Ready(): Promise<void> {
  if (_decompressFn) return;
  if (_initFailed) throw new Error('WOFF2 decoder previously failed to initialise — skipping');
  if (!_initPromise) {
    _initPromise = (async () => {
      try {
        _decompressFn = isBrowser() ? await ensureBrowserWawoff2Ready() : await ensureNodeWawoff2Ready();
      } catch (err) {
        _initFailed = true;
        if (typeof console !== 'undefined') console.warn('[wawoff2-init] FAILED:', (err as Error)?.message ?? err);
        throw new Error('WOFF2 fonts need the optional "wawoff2" dependency (npm install wawoff2) — or supply a TTF/OTF');
      }
    })();
  }
  await _initPromise;
}

async function defaultDecodeWoff2(bytes: Uint8Array): Promise<Uint8Array> {
  await ensureWawoff2Ready();
  if (!_decompressFn) throw new Error('wawoff2.decompress is not available');
  const out = await _decompressFn(bytes);
  return out instanceof Uint8Array ? out : new Uint8Array(out as unknown as ArrayBuffer);
}

async function normalizeFont(bytes: Uint8Array, url: string, opts: FontResolveOptions): Promise<Uint8Array> {
  const kind = sniffFont(bytes);
  if (kind === 'ttf' || kind === 'otto' || kind === 'ttcf') return bytes;
  if (kind === 'woff2') return (opts.decodeWoff2 ?? defaultDecodeWoff2)(bytes);
  if (kind === 'woff') throw new Error(`WOFF (v1) is not supported for "${url}" — use TTF/OTF/WOFF2`);
  throw new Error(`unrecognised font format for "${url}"`);
}

function firstMatch(re: RegExp, text: string): string | undefined {
  const m = re.exec(text);
  return m?.[1]?.trim();
}

function parseWeight(raw: string | undefined): number {
  if (!raw) return 400;
  const kw = raw.toLowerCase();
  if (kw.includes('bold')) return 700;
  if (kw.includes('black')) return 900;
  if (kw.includes('medium')) return 500;
  if (kw.includes('normal') || kw.includes('regular') || kw.includes('book')) return 400;
  const num = Number.parseInt(kw, 10);
  return Number.isFinite(num) && num >= 1 && num <= 1000 ? num : 400;
}

/** Parse `@font-face` blocks out of CSS text (single `url()` per block; the
 *  leading `font-weight` of a variable range is used as the face weight). */
export function parseFontFace(css: string): FaceRule[] {
  const out: FaceRule[] = [];
  const blockRe = /@font-face\s*\{([^}]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(css))) {
    const body = m[1] ?? '';
    const family = firstMatch(/font-family\s*:\s*['"]?([^'";]+?)['"]?\s*(?:;|$)/i, body);
    const url = firstMatch(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i, body);
    if (!family || !url) continue;
    const weight = parseWeight(firstMatch(/font-weight\s*:\s*([^;]+)/i, body));
    const styleRaw = firstMatch(/font-style\s*:\s*([^;]+)/i, body) ?? 'normal';
    const style: 'normal' | 'italic' = /italic|oblique/i.test(styleRaw) ? 'italic' : 'normal';
    out.push({ family, weight, style, url });
  }
  return out;
}

/**
 * Resolve every `report.fonts` reference into embeddable `FontSource[]`. Input is
 * not mutated. Returns `[]` when there are no references. Faces that share a
 * family/weight/style (Google's per-script subsets) get distinct `instance` tags.
 */
export async function resolveRemoteFonts(report: ReportDoc, opts: FontResolveOptions = {}): Promise<FontSource[]> {
  const refs = report.fonts;
  if (!refs || refs.length === 0) return [];

  // Collect the report's rendered charset for on-the-fly subsetting (text= param).
  // When subsetText is enabled (default) and the charset fits, Google returns only
  // the needed glyphs — dramatically smaller/faster than fetching the full font.
  const subsetText = opts.subsetText ?? true;
  const charset = subsetText ? collectCharset(report) : '';

  const textCache = new Map<string, Promise<string | null>>();
  const byteCache = new Map<string, Promise<Uint8Array | null>>();
  const fetchRemote = opts.fetchRemote ?? true;

  const loadText = (url: string): Promise<string | null> => {
    const hit = textCache.get(url);
    if (hit) return hit;
    const p = (async () => {
      if (opts.resolveText) return opts.resolveText(url);
      if (!REMOTE.test(url)) throw new Error(`cannot fetch stylesheet "${url}" (not http/https)`);
      if (!fetchRemote) throw new Error(`remote fonts disabled (fetchRemote:false) — skipped "${url}"`);
      return defaultFetchText(url, opts);
    })();
    textCache.set(url, p);
    return p;
  };

  const loadBytes = (url: string): Promise<Uint8Array | null> => {
    const hit = byteCache.get(url);
    if (hit) return hit;
    const p = (async () => {
      if (/^data:/i.test(url)) return decodeDataFont(url);
      if (opts.resolveFont) return opts.resolveFont(url);
      if (!REMOTE.test(url)) throw new Error(`cannot fetch font "${url}" (not http/https/data)`);
      if (!fetchRemote) throw new Error(`remote fonts disabled (fetchRemote:false) — skipped "${url}"`);
      return defaultFetchBytes(url, opts);
    })();
    byteCache.set(url, p);
    return p;
  };

  // 1. Expand references into concrete face rules.
  const rules: FaceRule[] = [];
  for (const ref of refs) {
    try {
      if (ref.type === 'google') {
        const url = charset ? `${ref.url}${ref.url.includes('?') ? '&' : '?'}text=${encodeURIComponent(charset)}` : ref.url;
        const css = await loadText(url);
        if (css) rules.push(...parseFontFace(css));
      } else if (ref.type === 'font-face') {
        rules.push(...parseFontFace(ref.css));
      } else if (ref.type === 'url') {
        rules.push({ family: ref.family, weight: ref.weight ?? 400, style: ref.style ?? 'normal', url: ref.url, postscriptName: ref.postscriptName });
      }
    } catch (err) {
      if (opts.onError === 'throw') throw err;
    }
  }

  // 2. Fetch + normalise each unique face URL, assigning subset instances.
  const seenUrl = new Set<string>();
  const counts = new Map<string, number>();
  const maxFaces = opts.maxFaces ?? 64;
  const sources: FontSource[] = [];

  // WOFF2 decode guard. Strategy:
  // 1. Pre-initialise wawoff2 (WASM compile) OUTSIDE the per-face timeout so a
  //    slow first-call doesn't cascade-skip all faces.
  // 2. Apply the tight decode timeout per face. Since WASM is already warm,
  //    any timeout here means the decoder itself is hung → skip remaining faces.
  const decodeTimeoutMs = opts.decodeTimeoutMs ?? 8000;
  const baseDecode = opts.decodeWoff2 ?? defaultDecodeWoff2;
  let decoderBroken = false;

  // Attempt one-time WASM init before entering the face loop. This is NOT subject
  // to decodeTimeoutMs — WASM compilation can legitimately take several seconds.
  if (opts.decodeWoff2 === undefined) {
    try {
      await withHardTimeout(ensureWawoff2Ready(), 30_000, 'WOFF2 WASM initialisation exceeded 30s');
    } catch {
      decoderBroken = true;
    }
  }

  const guardedDecode = async (bytes: Uint8Array): Promise<Uint8Array> => {
    if (decoderBroken) throw new Error('WOFF2 decode skipped (decoder unavailable)');
    try {
      return await withHardTimeout(baseDecode(bytes), decodeTimeoutMs, `WOFF2 decode exceeded ${decodeTimeoutMs}ms`);
    } catch (err) {
      if (/exceeded \d+ms/.test(String((err as Error)?.message ?? err))) decoderBroken = true;
      throw err;
    }
  };
  const effOpts: FontResolveOptions = { ...opts, decodeWoff2: guardedDecode };

  for (const rule of rules) {
    if (sources.length >= maxFaces) break;
    if (seenUrl.has(rule.url)) continue;
    seenUrl.add(rule.url);
    try {
      const raw = await loadBytes(rule.url);
      if (!raw) {
        if (opts.onError === 'throw') throw new Error(`font "${rule.url}" could not be resolved`);
        continue;
      }
      const bytes = await normalizeFont(raw, rule.url, effOpts);
      const key = `${rule.family.toLowerCase()}|${rule.weight}|${rule.style}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      // The first face for a key is the registry primary (no instance tag); the
      // remaining same-family faces carry an instance so they coexist for fallback.
      const src: FontSource = { family: rule.family, weight: rule.weight, style: rule.style, buffer: bytes };
      if (rule.postscriptName) src.postscriptName = rule.postscriptName;
      if (n > 0) src.instance = String(n);
      sources.push(src);
    } catch (err) {
      if (opts.onError === 'throw') throw err;
    }
  }

  return sources;
}

export type { FontReference };
