/**
 * Line-break opportunity finder — a pragmatic subset of UAX #14.
 *
 * Full Unicode line breaking is a 40-rule state machine over the Line_Break
 * property. For reports, four behaviours have to be right plus one escape hatch;
 * everything else can degrade safely:
 *
 *  1. Latin words never break internally; breaks happen at spaces.
 *  2. CJK/Thai/Lao/Khmer break *between any two* ideographic characters, but a
 *     closing mark (。、）』) must never lead a line and an opening mark must
 *     never trail one — the kinsoku rules, and the most visible bug in naive
 *     engines.
 *  3. Numbers, currency and units stay atomic (`1,234.56`, `€5.00`, `10%`).
 *  4. Hyphens and slashes are *optional* break points, never forced.
 *
 * Escape hatch: U+00A0 / U+2011 / U+2060 are glue (never break there), and
 * U+00AD is a soft hyphen that prints a hyphen only when the line breaks there.
 *
 * The classifier is a sorted, non-overlapping range table with binary-search
 * lookup: ~40x faster than a regex-per-character scan on a 5k-row report, and
 * `test/linebreak-table.test.ts` asserts the table's invariants so a hand-edit
 * cannot silently corrupt it.
 */

/** Simplified UAX #14 line-break classes. */
export enum LB {
  AI = 'AI', // ambiguous alphabetical
  AL = 'AL', // alphabetic
  BA = 'BA', // break after (hyphen-like)
  BB = 'BB', // break before (hypo-)
  BK = 'BK', // mandatory break
  CL = 'CL', // close punctuation
  CM = 'CM', // combining mark
  CR = 'CR', // carriage return
  EM = 'EM', // em dash
  EX = 'EX', // exclamation / ideographic full stop
  GL = 'GL', // non-glue (NBSP, NBHY, WJ, ZWJ)
  HL = 'HL', // Hebrew letter
  HY = 'HY', // hyphen
  ID = 'ID', // ideographic
  IN = 'IN', // infix numeric ( . : )
  IS = 'IS', // infix separator ( , ; ! ? )
  LF = 'LF', // line feed
  MAND = 'MAND', // synthesised mandatory break token class
  NS = 'NS', // non-starter (cannot lead a line)
  NU = 'NU', // numeric
  OP = 'OP', // opening punctuation
  ORD = 'ORD', // ordinal suffix
  PO = 'PO', // closing punctuation, other
  PR = 'PR', // prefix currency ($ € ¥ % °)
  PU = 'PU', // punctuation not covered above
  QU = 'QU', // quotation
  SA = 'SA', // complex context (Thai/Lao/Khmer: break per character)
  SP = 'SP', // space
  SY = 'SY', // symbol ( / )
}

/** A maximal run of characters with a uniform break behaviour. */
export interface BreakToken {
  text: string;
  /** A line may end immediately before this token. */
  breakBefore: boolean;
  /** A line may end immediately after this token. */
  breakAfter: boolean;
  /** Whitespace: collapses at a line end, does not print there. */
  space: boolean;
  /** Mandatory break (newline). */
  hard: boolean;
  /** Soft hyphen: prints a hyphen only if it ends a line. */
  softHyphen: boolean;
  class: LB;
  /** Prohibited as the first thing on a line (kinsoku class A). */
  noStart: boolean;
  /** Prohibited as the last thing on a line (kinsoku class B). */
  noEnd: boolean;
}

interface Range {
  from: number;
  to: number;
  cls: LB;
}

/**
 * Sorted, non-overlapping. Anything not listed is `LB.AL`, which is the safe
 * default (no break inside, break allowed on both sides).
 */
const RANGES: Range[] = [
  { from: 0x0000, to: 0x0008, cls: LB.BA },
  { from: 0x0009, to: 0x0009, cls: LB.BA }, // TAB is a break opportunity
  { from: 0x000a, to: 0x000a, cls: LB.LF },
  { from: 0x000b, to: 0x000c, cls: LB.BK },
  { from: 0x000d, to: 0x000d, cls: LB.CR },
  { from: 0x000e, to: 0x001f, cls: LB.BA },
  { from: 0x0020, to: 0x0020, cls: LB.SP },
  { from: 0x0021, to: 0x0022, cls: LB.EX },
  { from: 0x0023, to: 0x0025, cls: LB.PR },
  { from: 0x0026, to: 0x0027, cls: LB.AL },
  { from: 0x0028, to: 0x0028, cls: LB.OP },
  { from: 0x0029, to: 0x002a, cls: LB.CL },
  { from: 0x002b, to: 0x002b, cls: LB.PR },
  { from: 0x002c, to: 0x002d, cls: LB.IS },
  { from: 0x002e, to: 0x002e, cls: LB.IN },
  { from: 0x002f, to: 0x002f, cls: LB.SY },
  { from: 0x0030, to: 0x0039, cls: LB.NU },
  { from: 0x003a, to: 0x003b, cls: LB.IN },
  { from: 0x003c, to: 0x003f, cls: LB.AL },
  { from: 0x0040, to: 0x0040, cls: LB.PR },
  { from: 0x0041, to: 0x005a, cls: LB.AL },
  { from: 0x005b, to: 0x005b, cls: LB.OP },
  { from: 0x005c, to: 0x005d, cls: LB.CL },
  { from: 0x005e, to: 0x0060, cls: LB.AL },
  { from: 0x0061, to: 0x007a, cls: LB.AL },
  { from: 0x007b, to: 0x007b, cls: LB.OP },
  { from: 0x007c, to: 0x007e, cls: LB.SY },
  { from: 0x007f, to: 0x009f, cls: LB.BA },
  { from: 0x00a0, to: 0x00a0, cls: LB.GL }, // NBSP
  { from: 0x00a1, to: 0x00a8, cls: LB.PR },
  { from: 0x00a9, to: 0x00aa, cls: LB.ORD },
  { from: 0x00ab, to: 0x00ab, cls: LB.OP },
  { from: 0x00ac, to: 0x00ae, cls: LB.PR },
  { from: 0x00af, to: 0x00af, cls: LB.ORD },
  { from: 0x00b0, to: 0x00b4, cls: LB.PR },
  { from: 0x00b5, to: 0x00ba, cls: LB.AL },
  { from: 0x00bb, to: 0x00bb, cls: LB.CL },
  { from: 0x00bc, to: 0x00be, cls: LB.ORD },
  { from: 0x00bf, to: 0x00bf, cls: LB.PR },
  { from: 0x00c0, to: 0x00d6, cls: LB.AL },
  { from: 0x00d7, to: 0x00d7, cls: LB.PR },
  { from: 0x00d8, to: 0x00f6, cls: LB.AL },
  { from: 0x00f7, to: 0x00f7, cls: LB.PR },
  { from: 0x00f8, to: 0x02ff, cls: LB.AL },
  { from: 0x0300, to: 0x036f, cls: LB.CM },
  { from: 0x0370, to: 0x058f, cls: LB.AL },
  { from: 0x0590, to: 0x05ff, cls: LB.HL },
  { from: 0x0600, to: 0x0605, cls: LB.PR },
  { from: 0x0606, to: 0x06ff, cls: LB.AL },
  { from: 0x0700, to: 0x074f, cls: LB.AL },
  { from: 0x0750, to: 0x077f, cls: LB.AL },
  { from: 0x0780, to: 0x07bf, cls: LB.AL },
  { from: 0x07c0, to: 0x07ff, cls: LB.AL },
  { from: 0x0900, to: 0x097f, cls: LB.AL },
  { from: 0x0980, to: 0x0dff, cls: LB.AL },
  { from: 0x0e01, to: 0x0e5b, cls: LB.SA }, // Thai
  { from: 0x0e81, to: 0x0ebc, cls: LB.SA }, // Lao
  { from: 0x0ec0, to: 0x0ece, cls: LB.SA }, // Lao
  { from: 0x0f00, to: 0x0fff, cls: LB.AL },
  { from: 0x1000, to: 0x109f, cls: LB.AL },
  { from: 0x10a0, to: 0x177f, cls: LB.AL },
  { from: 0x1780, to: 0x17f9, cls: LB.SA }, // Khmer
  { from: 0x1800, to: 0x1fff, cls: LB.AL },
  { from: 0x2000, to: 0x2006, cls: LB.SP },
  { from: 0x2007, to: 0x2007, cls: LB.GL }, // figure space
  { from: 0x2008, to: 0x200b, cls: LB.SP },
  { from: 0x200c, to: 0x200d, cls: LB.GL }, // ZWNJ / ZWJ
  { from: 0x2010, to: 0x2010, cls: LB.HY },
  { from: 0x2011, to: 0x2011, cls: LB.GL }, // non-breaking hyphen
  { from: 0x2012, to: 0x2013, cls: LB.BA },
  { from: 0x2014, to: 0x2014, cls: LB.EM },
  { from: 0x2015, to: 0x2016, cls: LB.AL },
  { from: 0x2017, to: 0x2017, cls: LB.NU },
  { from: 0x2018, to: 0x2019, cls: LB.QU },
  { from: 0x201a, to: 0x201b, cls: LB.OP },
  { from: 0x201c, to: 0x201d, cls: LB.QU },
  { from: 0x201e, to: 0x201f, cls: LB.OP },
  { from: 0x2020, to: 0x2027, cls: LB.AL },
  { from: 0x2028, to: 0x2028, cls: LB.BK },
  { from: 0x2029, to: 0x2029, cls: LB.BK },
  { from: 0x202a, to: 0x202f, cls: LB.GL }, // includes NNBSP U+202F
  { from: 0x2030, to: 0x2030, cls: LB.PR }, // per mille
  { from: 0x2031, to: 0x203a, cls: LB.AL },
  { from: 0x203b, to: 0x203b, cls: LB.PR },
  { from: 0x203c, to: 0x203e, cls: LB.AL },
  { from: 0x203f, to: 0x2064, cls: LB.GL },
  { from: 0x2065, to: 0x206f, cls: LB.GL }, // includes WJ U+2060
  { from: 0x2070, to: 0x2080, cls: LB.ORD },
  { from: 0x2081, to: 0x20cf, cls: LB.AL },
  { from: 0x20d0, to: 0x20ff, cls: LB.CM },
  { from: 0x2100, to: 0x214f, cls: LB.AL },
  { from: 0x2150, to: 0x218f, cls: LB.ORD },
  { from: 0x2190, to: 0x2bff, cls: LB.AL },
  { from: 0x2c00, to: 0x2e7f, cls: LB.AL },
  { from: 0x2e80, to: 0x2fff, cls: LB.ID },
  { from: 0x3000, to: 0x3000, cls: LB.ID },
  { from: 0x3001, to: 0x3003, cls: LB.ID },
  { from: 0x3004, to: 0x3004, cls: LB.ID },
  { from: 0x3005, to: 0x3005, cls: LB.ID },
  { from: 0x3006, to: 0x3007, cls: LB.ID },
  { from: 0x3008, to: 0x3008, cls: LB.OP },
  { from: 0x3009, to: 0x3009, cls: LB.CL },
  { from: 0x300a, to: 0x300a, cls: LB.OP },
  { from: 0x300b, to: 0x300b, cls: LB.CL },
  { from: 0x300c, to: 0x300c, cls: LB.OP },
  { from: 0x300d, to: 0x300d, cls: LB.CL },
  { from: 0x300e, to: 0x300e, cls: LB.OP },
  { from: 0x300f, to: 0x300f, cls: LB.CL },
  { from: 0x3010, to: 0x3010, cls: LB.OP },
  { from: 0x3011, to: 0x3011, cls: LB.CL },
  { from: 0x3012, to: 0x3013, cls: LB.ID },
  { from: 0x3014, to: 0x3014, cls: LB.OP },
  { from: 0x3015, to: 0x3015, cls: LB.CL },
  { from: 0x3016, to: 0x3016, cls: LB.OP },
  { from: 0x3017, to: 0x3017, cls: LB.CL },
  { from: 0x3018, to: 0x3018, cls: LB.OP },
  { from: 0x3019, to: 0x3019, cls: LB.CL },
  { from: 0x301a, to: 0x301a, cls: LB.OP },
  { from: 0x301b, to: 0x303f, cls: LB.ID },
  { from: 0x3040, to: 0x30ff, cls: LB.ID },
  { from: 0x3100, to: 0x312f, cls: LB.ID },
  { from: 0x3130, to: 0x318e, cls: LB.ID },
  { from: 0x3190, to: 0x31ef, cls: LB.ID },
  { from: 0x31f0, to: 0x32ff, cls: LB.ID },
  { from: 0x3300, to: 0x4dbf, cls: LB.ID },
  { from: 0x4dc0, to: 0xd7ff, cls: LB.ID }, // CJK ext + Hangul syllables
  { from: 0xd800, to: 0xdfff, cls: LB.CM }, // surrogates (should not occur)
  { from: 0xe000, to: 0xf8ff, cls: LB.AL },
  { from: 0xf900, to: 0xfaff, cls: LB.ID },
  { from: 0xfb00, to: 0xfdff, cls: LB.AL },
  { from: 0xfe00, to: 0xfe0f, cls: LB.CM }, // variation selectors
  { from: 0xfe10, to: 0xfe19, cls: LB.ID },
  { from: 0xfe20, to: 0xfe2f, cls: LB.CM },
  { from: 0xfe30, to: 0xfe52, cls: LB.ID },
  { from: 0xfe54, to: 0xfe66, cls: LB.ID },
  { from: 0xfe68, to: 0xfe6b, cls: LB.ID },
  { from: 0xfe70, to: 0xfeff, cls: LB.AL },
  { from: 0xff01, to: 0xff01, cls: LB.EX },
  { from: 0xff02, to: 0xff03, cls: LB.PR },
  { from: 0xff04, to: 0xff07, cls: LB.ID },
  { from: 0xff08, to: 0xff08, cls: LB.OP },
  { from: 0xff09, to: 0xff09, cls: LB.CL },
  { from: 0xff0a, to: 0xff0b, cls: LB.PR },
  { from: 0xff0c, to: 0xff0c, cls: LB.IS },
  { from: 0xff0d, to: 0xff0d, cls: LB.PR },
  { from: 0xff0e, to: 0xff0e, cls: LB.IN },
  { from: 0xff0f, to: 0xff0f, cls: LB.SY },
  { from: 0xff10, to: 0xff19, cls: LB.NU }, // fullwidth digits
  { from: 0xff1a, to: 0xff1b, cls: LB.IN },
  { from: 0xff1c, to: 0xff1e, cls: LB.AL },
  { from: 0xff1f, to: 0xff20, cls: LB.EX },
  { from: 0xff21, to: 0xff3a, cls: LB.ID },
  { from: 0xff3b, to: 0xff3b, cls: LB.OP },
  { from: 0xff3c, to: 0xff3c, cls: LB.SY },
  { from: 0xff3d, to: 0xff3d, cls: LB.CL },
  { from: 0xff3e, to: 0xff40, cls: LB.AL },
  { from: 0xff41, to: 0xff5a, cls: LB.ID },
  { from: 0xff5b, to: 0xff5b, cls: LB.OP },
  { from: 0xff5c, to: 0xff5c, cls: LB.SY },
  { from: 0xff5d, to: 0xff5d, cls: LB.CL },
  { from: 0xff5e, to: 0xff63, cls: LB.ID },
  { from: 0xff64, to: 0xff65, cls: LB.ID },
  { from: 0xff66, to: 0xff9d, cls: LB.ID },
  { from: 0xff9e, to: 0xff9f, cls: LB.NU },
  { from: 0xffa0, to: 0xffbe, cls: LB.ID },
  { from: 0xffc2, to: 0xffc7, cls: LB.ID },
  { from: 0xffd2, to: 0xffd7, cls: LB.ID },
  { from: 0xffe0, to: 0xffe1, cls: LB.PR },
  { from: 0xffe2, to: 0xffe2, cls: LB.SY },
  { from: 0xffe3, to: 0xffe3, cls: LB.PR },
  { from: 0xffe4, to: 0xffe4, cls: LB.ID },
  { from: 0xffe5, to: 0xffe6, cls: LB.PR },
  { from: 0xffe8, to: 0xffee, cls: LB.ID },
  { from: 0xfff9, to: 0xfffb, cls: LB.GL },
  { from: 0x1f000, to: 0x1fbff, cls: LB.ID }, // emoji / pictographs: break before and after
  { from: 0x20000, to: 0x3fffd, cls: LB.ID }, // CJK ext B..
];

/** Binary search; unlisted code points are `LB.AL`. */
export function classOf(cp: number): LB {
  let lo = 0;
  let hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = RANGES[mid]!;
    if (cp < r.from) hi = mid - 1;
    else if (cp > r.to) lo = mid + 1;
    else return r.cls;
  }
  return LB.AL;
}

/** Classes that must not start a line (UAX #14 LB13 "cannot follow a break"). */
const NO_START: ReadonlySet<LB> = new Set<LB>([LB.CL, LB.EX, LB.IS, LB.NS, LB.PO, LB.CM, LB.SY, LB.IN, LB.QU, LB.HY]);

/** Classes that must not end a line (LB25/LB27/LB28: openers and quotes). */
const NO_END: ReadonlySet<LB> = new Set<LB>([LB.OP, LB.QU, LB.PR, LB.HY, LB.BB]);

function isIdeographicClass(cls: LB): boolean {
  return cls === LB.ID || cls === LB.SA;
}

export interface FindBreakOptions {
  /** Break between every code point (emergency / `word-break: break-all`). */
  anywhere?: boolean;
}

/**
 * Split `text` into break tokens. Guarantees:
 *  - concatenating every `text` reproduces the input (CRLF normalised to LF)
 *  - a token with `breakBefore` may start a line
 *  - kinsoku repairs have already been applied
 */
export function findBreaks(text: string, options: FindBreakOptions = {}): BreakToken[] {
  const out: BreakToken[] = [];
  const chars = Array.from(text);
  let i = 0;

  const emit = (t: string, cls: LB, extra: Partial<BreakToken> = {}): void => {
    const noStart = extra.noStart ?? NO_START.has(cls);
    const noEnd = extra.noEnd ?? NO_END.has(cls);
    out.push({
      text: t,
      class: cls,
      breakBefore: extra.breakBefore ?? (!noStart && cls !== LB.SP),
      breakAfter: extra.breakAfter ?? (!noEnd && cls !== LB.SP),
      space: extra.space ?? (cls === LB.SP || cls === LB.BK || cls === LB.LF || cls === LB.CR),
      hard: extra.hard ?? false,
      softHyphen: extra.softHyphen ?? false,
      noStart,
      noEnd,
    });
  };

  while (i < chars.length) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0)!;
    const cls = classOf(cp);

    // --- hard breaks -------------------------------------------------------
    // Normalised: CR and CRLF both emit a single '\n' so that concatenating
    // every token text reproduces the input with line endings canonicalised.
    if (cls === LB.LF || cls === LB.CR || cls === LB.BK) {
      i += 1;
      if (cls === LB.CR && chars[i] === '\n') i += 1;
      emit('\n', LB.MAND, { hard: true, breakBefore: true, breakAfter: true, space: true });
      continue;
    }

    // --- spaces ------------------------------------------------------------
    if (cls === LB.SP) {
      let t = ch;
      i += 1;
      while (i < chars.length && classOf(chars[i]!.codePointAt(0)!) === LB.SP) {
        t += chars[i]!;
        i += 1;
      }
      emit(t, LB.SP, { breakBefore: true, breakAfter: true, space: true });
      continue;
    }

    // --- soft hyphen -------------------------------------------------------
    // Kept as its own token (noStart:false so kinsoku repair cannot weld it into
    // the preceding word and erase the marker). It never begins a line
    // (breakBefore:false) and is a break point (breakAfter:true).
    if (cp === 0x00ad) {
      emit(ch, LB.HY, { softHyphen: true, breakBefore: false, breakAfter: true, noStart: false, noEnd: true });
      i += 1;
      continue;
    }

    // --- glue: weld to the previous unit -----------------------------------
    if (cls === LB.GL) {
      const prev = out[out.length - 1];
      if (prev && !prev.space && !prev.hard) {
        prev.text += ch;
        prev.breakAfter = false;
        i += 1;
        continue;
      }
      emit(ch, LB.GL, { breakBefore: false, breakAfter: false });
      i += 1;
      continue;
    }

    // --- combining marks attach backwards ----------------------------------
    if (cls === LB.CM) {
      const prev = out[out.length - 1];
      if (prev && !prev.hard) {
        prev.text += ch;
        i += 1;
        continue;
      }
      emit(ch, LB.CM, { breakBefore: false, breakAfter: false });
      i += 1;
      continue;
    }

    // --- ideographic / complex script: one unit per character --------------
    if (isIdeographicClass(cls)) {
      emit(ch, cls, { breakBefore: true, breakAfter: true });
      i += 1;
      continue;
    }

    // --- numeric run with separators and currency --------------------------
    if (cls === LB.NU || cls === LB.PR) {
      const run = scanNumeric(chars, i);
      emit(run.text, LB.NU, { breakBefore: run.leadBreak, breakAfter: true, noStart: false, noEnd: false });
      i = run.next;
      continue;
    }

    // --- alphabetic word ---------------------------------------------------
    if (cls === LB.AL || cls === LB.AI || cls === LB.HL || cls === LB.ORD) {
      const run = scanWord(chars, i);
      emit(run.text, cls, { breakBefore: run.leadBreak, breakAfter: true, noStart: false, noEnd: false });
      i = run.next;
      continue;
    }

    // --- hyphen / dash -----------------------------------------------------
    if (cls === LB.HY || cls === LB.BA || cls === LB.EM) {
      emit(ch, cls, { breakBefore: false, breakAfter: true, noStart: cls === LB.EM ? false : true, noEnd: false });
      i += 1;
      continue;
    }
    if (cls === LB.BB) {
      emit(ch, cls, { breakBefore: true, breakAfter: false });
      i += 1;
      continue;
    }

    // --- punctuation and symbols ------------------------------------------
    emit(ch, cls, { breakBefore: !NO_START.has(cls), breakAfter: !NO_END.has(cls) });
    i += 1;
  }

  if (options.anywhere) {
    for (const t of out) {
      if (t.space || t.class === LB.GL) continue;
      t.breakBefore = true;
      t.breakAfter = true;
    }
  }

  repairKinsoku(out);
  return out;
}

interface RunResult {
  text: string;
  next: number;
  leadBreak: boolean;
}

function precededByBreak(chars: string[], index: number): boolean {
  if (index === 0) return false;
  const prev = classOf(chars[index - 1]!.codePointAt(0)!);
  return prev === LB.SP || prev === LB.LF || prev === LB.CR || prev === LB.BK;
}

/**
 * A "word" is letters/marks, extended over intra-word hyphens and apostrophes
 * (`some-one`, `don't`) and swallowing trailing closers so they cannot lead the
 * next line.
 */
function scanWord(chars: string[], start: number): RunResult {
  let i = start;
  let text = '';
  const leadBreak = precededByBreak(chars, start);
  while (i < chars.length) {
    const ch = chars[i]!;
    const cls = classOf(ch.codePointAt(0)!);
    if (cls === LB.AL || cls === LB.AI || cls === LB.HL || cls === LB.ORD || cls === LB.CM) {
      text += ch;
      i += 1;
      continue;
    }
    // `some-one`, `don't`, `o'clock`: continue only when both sides are letters.
    if ((cls === LB.HY || cls === LB.IS || ch === "'" || ch === '\u2019') && i + 1 < chars.length) {
      const nextCls = classOf(chars[i + 1]!.codePointAt(0)!);
      if (nextCls === LB.AL || nextCls === LB.AI || nextCls === LB.HL || nextCls === LB.NU) {
        text += ch + chars[i + 1]!;
        i += 2;
        continue;
      }
    }
    break;
  }
  // Trailing closers/exclamations stay with the word (LB13).
  while (i < chars.length) {
    const cls = classOf(chars[i]!.codePointAt(0)!);
    if (cls === LB.CL || cls === LB.EX || cls === LB.IS || cls === LB.NS || cls === LB.PO || cls === LB.CM) {
      text += chars[i]!;
      i += 1;
      continue;
    }
    break;
  }
  return { text, next: i, leadBreak };
}

/**
 * Keep numbers/currency atomic: `1,234.56`, `€5.00`, `10%`, `1.2e-3`, `-7`,
 * `12,5 %`. The scan never crosses a space, so `10 kg` stays two units.
 */
function scanNumeric(chars: string[], start: number): RunResult {
  let i = start;
  let text = '';
  const leadBreak = precededByBreak(chars, start);

  // Leading sign / currency.
  while (i < chars.length) {
    const ch = chars[i]!;
    const cls = classOf(ch.codePointAt(0)!);
    if (cls === LB.PR || ch === '+' || ch === '-' || ch === '\u00b1') {
      text += ch;
      i += 1;
      continue;
    }
    break;
  }

  let sawDigit = false;
  while (i < chars.length) {
    const ch = chars[i]!;
    const cls = classOf(ch.codePointAt(0)!);
    if (cls === LB.NU) {
      text += ch;
      i += 1;
      sawDigit = true;
      continue;
    }
    // Thousands/decimal separator followed by another digit.
    if ((cls === LB.IN || cls === LB.IS) && i + 1 < chars.length && classOf(chars[i + 1]!.codePointAt(0)!) === LB.NU) {
      text += ch + chars[i + 1]!;
      i += 2;
      continue;
    }
    // Trailing unit-ish prefix classes: %, °, €, /1000-style symbols.
    if (sawDigit && cls === LB.PR) {
      text += ch;
      i += 1;
      continue;
    }
    // Exponent: 1.2e-3
    if (sawDigit && (ch === 'e' || ch === 'E') && i + 1 < chars.length) {
      const sign = chars[i + 1] === '+' || chars[i + 1] === '-' ? chars[i + 1]! : '';
      const digit = (sign ? chars[i + 2] : chars[i + 1]) ?? '';
      if (classOf(digit.codePointAt(0)!) === LB.NU) {
        text += ch + sign + digit;
        i += 2 + (sign ? 1 : 0);
        continue;
      }
    }
    break;
  }

  if (!sawDigit) {
    // Currency with no digits after it: emit as a single symbol instead.
    return { text: chars[start]!, next: start + 1, leadBreak };
  }
  return { text, next: i, leadBreak };
}

/**
 * LB13/LB25/LB30 equivalent applied to the finished token list:
 *  - a token that cannot start a line is welded to its predecessor
 *  - a token that cannot end a line loses its `breakAfter`
 */
export function repairKinsoku(tokens: BreakToken[]): void {
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.hard || t.space || !t.noStart) continue;
    const prev = tokens[i - 1]!;
    if (prev.space || prev.hard) continue;
    prev.text += t.text;
    prev.breakAfter = prev.breakAfter && t.breakAfter;
    tokens.splice(i, 1);
    i -= 1;
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i]!.noEnd) tokens[i]!.breakAfter = false;
  }
}
