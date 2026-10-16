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

export interface FontResolveOptions {
  /** Fetch remote font CSS/files. Default `true`. Set `false` for air-gapped renders. */
  fetchRemote?: boolean;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Refuse font files larger than this many bytes. Default 25 MiB. */
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
interface FetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
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
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`font exceeds ${maxBytes} bytes`);
  return bytes;
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

async function defaultDecodeWoff2(bytes: Uint8Array): Promise<Uint8Array> {
  let decompress: ((b: Uint8Array) => Promise<Uint8Array>) | undefined;
  try {
    decompress = (await import('wawoff2')).decompress;
  } catch {
    throw new Error('WOFF2 fonts need the optional "wawoff2" dependency (npm install wawoff2) — or supply a TTF/OTF');
  }
  if (!decompress) throw new Error('wawoff2.decompress is not available');
  const out = await decompress(bytes);
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
        const css = await loadText(ref.url);
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

  // Guard the WOFF2 decoder so a stalled WebAssembly runtime (see decodeTimeoutMs)
  // cannot dead-lock the render: time-box each decode, and once one times out treat
  // the decoder as unavailable and skip the remaining WOFF2 faces immediately.
  const decodeState = { broken: false };
  const decodeTimeoutMs = opts.decodeTimeoutMs ?? 8000;
  const baseDecode = opts.decodeWoff2 ?? defaultDecodeWoff2;
  const guardedDecode = async (bytes: Uint8Array): Promise<Uint8Array> => {
    if (decodeState.broken) throw new Error('WOFF2 decode skipped (decoder timed out earlier)');
    try {
      return await withHardTimeout(baseDecode(bytes), decodeTimeoutMs, `WOFF2 decode exceeded ${decodeTimeoutMs}ms`);
    } catch (err) {
      if (/exceeded \d+ms/.test(String((err as Error)?.message ?? err))) decodeState.broken = true;
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
