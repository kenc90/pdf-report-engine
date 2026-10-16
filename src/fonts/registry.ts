/**
 * Font layer.
 *
 * Three decisions worth defending:
 *
 *  1. **Measuring and drawing share one oracle.** Widths come from the *same*
 *     code path pdfkit uses when it emits the glyphs (`PDFFont.widthOfString`,
 *     i.e. `fontkit.layout().advanceWidth`), so the wrapping decided in
 *     `text/typeset.ts` cannot drift from what is painted. A second, independent
 *     shaper would eventually produce lines that overflow their box.
 *  2. **We never subset by hand.** pdfkit's `EmbeddedFont` builds the CID subset
 *     and the ToUnicode CMap; that is what makes output selectable/searchable.
 *     The engine only feeds it pre-broken lines.
 *  3. **No `fontkit` import here.** pdfkit ships both a CJS and an ESM entry, and
 *     Node resolves fontkit differently for each (`dist/main.cjs` vs
 *     `dist/module.mjs`). Two fontkit instances means two `Buffer` classes, and
 *     pdfkit's `src instanceof Uint8Array` check then silently fails with
 *     "Not a supported font format". Everything we need is reachable through
 *     pdfkit's own font object, so we use that and stay instance-safe.
 *
 * A deterministic `HeuristicFontHandle` stands in for tests, so layout and
 * pagination are verifiable without any font file on disk.
 */
/**
 * `@types/pdfkit` declares the document interface in the global `PDFKit`
 * namespace, which is available without an import as long as `pdfkit` is
 * installed. Keeping the core free of a pdfkit *value* import is deliberate:
 * the layout engine must not be able to reach the writer.
 */
type PDFDocument = PDFKit.PDFDocument;

/** fontkit's `Font`, reached through pdfkit so we never load a second copy. */
export interface RawKitFont {
  postscriptName: string;
  unitsPerEm: number;
  hasGlyphForCodePoint(cp: number): boolean;
  characterSet: number[];
  layout(
    text: string,
    features?: string[] | Record<string, boolean>,
    script?: string,
    language?: string,
    direction?: string,
  ): { glyphs: Array<{ id: number; advanceWidth: number }>; positions: Array<Record<string, number>> };
  getVariation(settings: object | string): RawKitFont;
}

/**
 * The pieces of pdfkit's resolved font object this engine relies on.
 * `@types/pdfkit` only describes the font *mixin*, not the font object, so we
 * declare the structural shape we consume and cast once, in `register`.
 */
export interface PdfFontLike {
  id: string;
  name: string;
  ascender: number;
  descender: number;
  xHeight: number;
  capHeight: number;
  lineGap: number;
  bbox: number[];
  /** The underlying fontkit font (same instance pdfkit itself uses). */
  font: RawKitFont;
  widthOfString(string: string, size: number, features?: Record<string, boolean>): number;
  encode?(text: string, features?: Record<string, boolean>): [string[], Array<Record<string, number>>];
}

export interface FontSource {
  /** Logical family name, matched against `style.fontFamily`. */
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
  /** Font program bytes: TTF or OTF. */
  buffer: Uint8Array | ArrayBuffer;
  /**
   * Face name inside a TrueType collection (`.ttc`), e.g. `MicrosoftYaHei`.
   * Required for collections; pdfkit selects by name.
   */
  postscriptName?: string;
  /**
   * Distinguishes several faces that share a family/weight/style but cover
   * different `unicode-range`s — the way Google Fonts ships one file per script
   * (latin, latin-ext, cyrillic, ...). Each subset gets its own `instance` so
   * they coexist in the registry: the first registered is `resolve()`'s target
   * and the others are reached through per-glyph fallback.
   */
  instance?: string;
}

export interface FontHandle {
  readonly key: string;
  readonly family: string;
  readonly weight: number;
  readonly style: 'normal' | 'italic';
  /** Points per 1000 units-of-em, i.e. pdfkit's normalised metrics. */
  readonly ascender: number;
  readonly descender: number;
  readonly xHeight: number;
  readonly capHeight: number;
  readonly lineGap: number;
  readonly unitsPerEm: number;
  readonly embedded: boolean;
  /** Name registered with pdfkit; what the writer passes to `doc.font(...)`. */
  readonly embeddedName?: string;
  widthOf(text: string, size: number, features?: Record<string, boolean>): number;
  hasGlyphsFor(text: string): boolean;
  /** True when a single code point has a glyph in this face (drives per-glyph fallback). */
  coversCodePoint(cp: number): boolean;
  /** Layout metrics table for the writer (`W`/`DW` entries in the CIDFont). */
  readonly pdfFont?: PdfFontLike;
}

/** pdfkit-backed handle. `widthOf` delegates so measurement == rendering. */
class PdfFontHandle implements FontHandle {
  readonly embedded = true;
  readonly ascender: number;
  readonly descender: number;
  readonly xHeight: number;
  readonly capHeight: number;
  readonly lineGap: number;
  readonly unitsPerEm: number;
  readonly pdfFont: PdfFontLike;
  private readonly cache = new Map<string, number>();
  private coverage: Set<number> | undefined;

  constructor(
    readonly key: string,
    readonly family: string,
    readonly weight: number,
    readonly style: 'normal' | 'italic',
    font: PdfFontLike,
    readonly embeddedName: string,
  ) {
    this.pdfFont = font;
    // pdfkit normalises ascender/descender/xHeight/capHeight/lineGap by
    // `1000/unitsPerEm`, so they are already "per 1000 units-of-em". We therefore
    // expose unitsPerEm = 1000: `ascent = ascender / unitsPerEm * size` then matches
    // the very `dy = ascender / 1000 * size` pdfkit uses to place the baseline.
    this.ascender = font.ascender;
    this.descender = font.descender;
    this.xHeight = font.xHeight;
    this.capHeight = font.capHeight;
    this.lineGap = font.lineGap;
    this.unitsPerEm = 1000;
  }

  widthOf(text: string, size: number, features?: Record<string, boolean>): number {
    const tags = features ? Object.keys(features).sort().join(',') : '';
    const cacheKey = `${size}|${tags}|${text}`;
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const width = this.pdfFont.widthOfString(text, size, features);
    this.cache.set(cacheKey, width);
    return width;
  }

  coversCodePoint(cp: number): boolean {
    if (cp === 0x20 || cp === 0x0a) return true;
    const raw = this.pdfFont.font;
    if (!raw?.hasGlyphForCodePoint) return true;
    // `characterSet` is a plain sorted array on fontkit's TTF; building a Set once
    // is much cheaper than 30k linear scans for a CJK face.
    if (!this.coverage && Array.isArray(raw.characterSet)) this.coverage = new Set(raw.characterSet);
    return this.coverage ? this.coverage.has(cp) : raw.hasGlyphForCodePoint(cp);
  }

  hasGlyphsFor(text: string): boolean {
    for (const ch of text) {
      if (!this.coversCodePoint(ch.codePointAt(0)!)) return false;
    }
    return true;
  }
}

/**
 * Fixed-advance stand-in used by tests. Latin ~0.5em, CJK 1em, space 0.28em —
 * enough to make pagination assertions deterministic without a font binary.
 */
export class HeuristicFontHandle implements FontHandle {
  readonly embedded = false;
  readonly ascender = 750;
  readonly descender = -250;
  readonly xHeight = 450;
  readonly capHeight = 700;
  readonly lineGap = 0;
  readonly unitsPerEm = 1000;

  constructor(
    readonly family = 'estimate',
    readonly weight = 400,
    readonly style: 'normal' | 'italic' = 'normal',
  ) {}

  get key(): string {
    return `estimate:${this.family}:${this.weight}:${this.style}`;
  }

  widthOf(text: string, size: number): number {
    let units = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x20) units += 280;
      else if (isWide(cp)) units += 1000;
      else units += 500;
    }
    return (units / 1000) * size;
  }

  hasGlyphsFor(): boolean {
    return true;
  }
  coversCodePoint(): boolean {
    return true;
  }
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function faceKey(family: string, weight: number, style: string): string {
  return `${family.toLowerCase()}|${weight}|${style}`;
}

/**
 * Copy into a fresh `Uint8Array`. pdfkit's factory checks `instanceof`, and when
 * a bundler gives the ESM and CJS entries different realm views, a `Buffer` can
 * fail that test while a plain `Uint8Array` created here does not.
 */
export function asBytes(buffer: Uint8Array | ArrayBuffer): Uint8Array {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer.slice(0));
  return new Uint8Array(buffer.slice(0));
}

export interface FontRegistryOptions {
  /** Family used when nothing in the stack matches; resolved as a standard PDF font. */
  fallbackFamily?: string;
}

export class FontRegistry {
  private readonly faces: FontHandle[] = [];
  private readonly byKey = new Map<string, FontHandle>();
  /** Per-codepoint fallback decisions, keyed by `primary.key|cp`. */
  private readonly glyphCache = new Map<string, FontHandle>();
  /** Family stacks referenced by a template but never registered. */
  readonly unmatched = new Set<string>();
  private readonly fallbackFamily: string;

  constructor(options: FontRegistryOptions = {}) {
    this.fallbackFamily = options.fallbackFamily ?? 'Helvetica';
  }

  registerAll(doc: PDFDocument, sources: FontSource[]): this {
    for (const source of sources) this.register(doc, source);
    return this;
  }

  register(doc: PDFDocument, source: FontSource): FontHandle {
    const weight = source.weight ?? 400;
    const style = source.style ?? 'normal';
    const key = faceKey(source.family, weight, style);
    const existing = this.byKey.get(key);
    // A plain source dedupes by family|weight|style. Subsetted sources (an
    // `instance` tag, e.g. Google Fonts' per-script files) each need their own
    // face, so they are always registered; the first for a given key is what
    // `resolve()` returns and the rest are found via per-glyph fallback.
    if (existing && !source.instance) return existing;

    const registeredName = source.instance
      ? `${source.family}|${weight}|${style}|${source.instance}`
      : `${source.family}|${weight}|${style}`;
    const bytes = asBytes(source.buffer);
    if (source.postscriptName) doc.registerFont(registeredName, bytes as unknown as Buffer, source.postscriptName);
    else doc.registerFont(registeredName, bytes as unknown as Buffer);
    doc.font(registeredName);
    // pdfkit has no zero-arg `font()` getter — calling it throws "Not a supported
    // font format". The resolved font object lives on `_font`, which is also what
    // every subsequent `text()` call uses, so measuring through it is exact.
    const pdfFont = (doc as unknown as { _font: PdfFontLike })._font;

    const handle = new PdfFontHandle(key, source.family, weight, style, pdfFont, registeredName);
    this.faces.push(handle);
    if (!existing) this.byKey.set(key, handle);
    return handle;
  }

  /** Inject a handle directly (tests, or a custom writer with its own font object). */
  addHandle(handle: FontHandle): this {
    const key = faceKey(handle.family, handle.weight, handle.style);
    if (!this.byKey.has(key)) this.faces.push(handle);
    this.byKey.set(key, handle);
    return this;
  }

  has(family: string): boolean {
    const wanted = family.trim().toLowerCase();
    return this.faces.some((f) => f.family.toLowerCase() === wanted);
  }

  /** CSS-ish matching: honour the stack order, then fall back to the nearest weight. */
  resolve(
    stack: string | string[] | undefined,
    weight = 400,
    style: 'normal' | 'italic' = 'normal',
  ): FontHandle {
    const families = (Array.isArray(stack) ? stack : stack ? [stack] : [])
      .map((f) => f.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

    for (const family of families) {
      let best: { handle: FontHandle; score: number } | undefined;
      for (const face of this.faces) {
        if (face.family.toLowerCase() !== family.toLowerCase()) continue;
        const stylePenalty = face.style === style ? 0 : 300;
        // CSS font matching: below 500 prefer lighter neighbours, above prefer heavier.
        const delta = face.weight - weight;
        const bias = weight < 500 ? (delta < 0 ? 1 : 2) : delta > 0 ? 1 : 2;
        const score = stylePenalty + Math.abs(delta) * 10 * bias;
        if (!best || score < best.score) best = { handle: face, score };
      }
      if (best) return best.handle;
    }

    let nearest: { handle: FontHandle; score: number } | undefined;
    for (const face of this.faces) {
      const score = Math.abs(face.weight - weight) * 10 + (face.style === style ? 0 : 300);
      if (!nearest || score < nearest.score) nearest = { handle: face, score };
    }
    if (nearest) return nearest.handle;

    const wanted = families.join(', ');
    if (wanted) this.unmatched.add(wanted);
    return this.fallback(wanted || this.fallbackFamily, weight, style);
  }

  /**
   * Per-glyph fallback: resolve `ch` against the stack, but if the resolved face
   * has no glyph for it, pick the nearest registered face (by weight/style) that
   * does. Returns the primary face when nothing covers the code point, so truly
   * missing glyphs render as `.notdef` rather than vanishing silently. Idempotent
   * and identity-stable (same input → same handle object) so typeset can group
   * consecutive code points that share a face into one run.
   */
  resolveWithFallback(
    ch: string,
    stack: string | string[] | undefined,
    weight = 400,
    style: 'normal' | 'italic' = 'normal',
  ): FontHandle {
    const primary = this.resolve(stack, weight, style);
    const cp = ch.codePointAt(0);
    if (cp === undefined || primary.coversCodePoint(cp)) return primary;
    const cacheKey = `${primary.key}|${cp}`;
    const hit = this.glyphCache.get(cacheKey);
    if (hit) return hit;
    let best: { handle: FontHandle; score: number } | undefined;
    for (const face of this.faces) {
      if (face === primary || !face.coversCodePoint(cp)) continue;
      // Prefer a face of the same family (Google Fonts ships each script as a
      // separate subset of the same family) over any other family that merely
      // also covers the code point — matching how a browser resolves
      // `unicode-range`. Then nearest weight, then style.
      const sameFamily = face.family.toLowerCase() === primary.family.toLowerCase() ? 0 : 2000;
      const score = sameFamily + Math.abs(face.weight - weight) * 10 + (face.style === style ? 0 : 300);
      if (!best || score < best.score) best = { handle: face, score };
    }
    const chosen = best ? best.handle : primary;
    this.glyphCache.set(cacheKey, chosen);
    return chosen;
  }

  private fallback(family: string, weight: number, style: 'normal' | 'italic'): FontHandle {
    const key = faceKey(`@${family}`, weight, style);
    const hit = this.byKey.get(key);
    if (hit) return hit;
    const handle = new HeuristicFontHandle(family, weight, style);
    this.byKey.set(key, handle);
    return handle;
  }

  list(): readonly FontHandle[] {
    return this.faces;
  }
}

export type FontFileEntry = {
  family: string;
  path?: string;
  buffer?: Uint8Array | ArrayBuffer;
  weight?: number;
  style?: 'normal' | 'italic';
  postscriptName?: string;
};

/** Read font programs from disk or memory. Async so browsers can pass `fetch()` bytes. */
export async function readFontFiles(entries: FontFileEntry[]): Promise<FontSource[]> {
  const out: FontSource[] = [];
  // Only load `node:fs/promises` when a path actually needs reading, so a browser
  // build that supplies `buffer` bytes never touches the Node module.
  let fs: typeof import('node:fs/promises') | undefined;
  for (const entry of entries) {
    if (entry.buffer) {
      out.push({ ...entry, buffer: entry.buffer });
      continue;
    }
    if (!entry.path) throw new Error(`Font "${entry.family}": provide either path or buffer`);
    fs ??= await import('node:fs/promises');
    out.push({ ...entry, buffer: new Uint8Array(await fs.readFile(entry.path)) });
  }
  return out;
}
