/**
 * ICU/Java-flavoured number and date patterns — the formats report authors
 * already write (`#,##0.00`, `dd/MM/yyyy`, `$#,##0.00;[Red]-$#,##0.00`).
 * Deliberately a subset: no plurals, no locales beyond an injectable symbol
 * table, because full CLDR would dwarf the layout engine.
 */
import { toRGB, type RGB } from '../core/color.js';

export interface NumberSymbols {
  decimal: string;
  group: string;
  percent: string;
  minus: string;
  currency: string;
  exponential: string;
}

export const DEFAULT_SYMBOLS: NumberSymbols = {
  decimal: '.',
  group: ',',
  percent: '%',
  minus: '-',
  currency: '$',
  exponential: 'E',
};

/** `[positive, negative]`; a `[Red]` style prefix is returned as a colour hint. */
export interface FormatResult {
  text: string;
  color?: RGB;
}

interface ParsedSection {
  pattern: string;
  literal: string;
  /** True when the section carries no digit placeholder at all (`"—"`, `"N/A"`). */
  literalOnly: boolean;
  minIntegerDigits: number;
  minFractionDigits: number;
  maxFractionDigits: number;
  groupSize: number;
  percentScale: boolean;
  permilleScale: boolean;
  currency: boolean;
  scientific: boolean;
  padChar?: string;
  color?: RGB;
  prefix: string;
  suffix: string;
}

const ESCAPED = /^'([^']|'')*'/;
const QUOTED_LITERAL = /^"([^"]*)"/;

/** Drop `'…'` / `"…"` quoted spans, so a literal `'%'` is not read as an attribute. */
function stripQuoted(pattern: string): string {
  return pattern.replace(/'[^']*'|"[^"]*"/g, '');
}

function parseSection(pattern: string, symbols: NumberSymbols): ParsedSection {
  let prefix = '';
  let suffix = '';
  let color: RGB | undefined;
  let padChar: string | undefined;

  // Affixes and attributes outside the numeric part.
  const numericStart = findNumericStart(pattern);
  const head = pattern.slice(0, numericStart);
  const tail = pattern.slice(matchedEnd(pattern, numericStart));
  for (const chunk of splitTokens(head, true, symbols)) {
    if (chunk.type === 'color') color = chunk.color;
    else if (chunk.type === 'pad') padChar = chunk.char;
    else prefix += chunk.text;
  }
  for (const chunk of splitTokens(tail, false, symbols)) {
    if (chunk.type === 'color') color = chunk.color;
    else if (chunk.type === 'pad') padChar = chunk.char;
    else suffix += chunk.text;
  }

  const body = pattern.slice(numericStart, matchedEnd(pattern, numericStart));
  const exp = /(?:[eE])([0#]*)$/.exec(body);
  const mantissa = exp ? body.slice(0, exp.index) : body;
  // Scaling and currency belong to the *whole* section: in `#,##0.0%` the percent
  // sign sits in the suffix (matchedEnd moves it out of `body`), so testing only
  // the numeric body silently dropped the ×100. Quoted spans are stripped first.
  const bare = stripQuoted(pattern);
  const percentScale = bare.includes('%') || bare.includes(symbols.percent);
  const permilleScale = bare.includes('‰');
  const currency = bare.includes('¤') || prefix.includes(symbols.currency) || suffix.includes(symbols.currency);

  const [intPartRaw, fracPartRaw = ''] = splitDecimal(mantissa);
  const intPart = intPartRaw.replace(/[,%‰¤]/g, '');
  const minIntegerDigits = (intPart.match(/0/g) ?? []).length || 1;
  const groupPositions: number[] = [];
  {
    let fromRight = 0;
    // Scan the *raw* integer part: `intPart` has already lost the separators.
    for (let k = intPartRaw.length - 1; k >= 0; k -= 1) {
      const ch = intPartRaw[k]!;
      if (ch === ',') groupPositions.push(fromRight);
      else if (ch === '0' || ch === '#') fromRight += 1;
    }
  }
  const groupSize = groupPositions.length ? Math.max(...groupPositions) : 0;
  const fracDigits = fracPartRaw.replace(/[^0#]/g, '');
  const minFractionDigits = (fracDigits.match(/0/g) ?? []).length;
  const maxFractionDigits = fracDigits.length;

  return {
    pattern,
    literal: '',
    literalOnly: numericStart >= pattern.length,
    minIntegerDigits: exp ? 1 : Math.max(1, minIntegerDigits),
    minFractionDigits,
    maxFractionDigits,
    groupSize: exp ? 0 : groupSize,
    percentScale,
    permilleScale,
    currency,
    scientific: !!exp,
    padChar,
    color,
    prefix: exp ? prefix : prefix,
    suffix,
  };
}

function matchedEnd(pattern: string, numericStart: number): number {
  // The numeric body runs until the end; suffix affixes are stripped by scanning
  // back over non-digit-class characters.
  let end = pattern.length;
  while (end > numericStart + 1 && !/[0#.,]/.test(pattern[end - 1]!)) end -= 1;
  return end;
}

function findNumericStart(pattern: string): number {
  // `*X` is the ICU pad escape: the character after `*` is padding, not a digit
  // placeholder, so the scan for the numeric body has to step over the pair.
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '*' && i + 1 < pattern.length) {
      i += 1;
      continue;
    }
    if (pattern[i] === '0' || pattern[i] === '#') return i;
  }
  return pattern.length;
}

function splitDecimal(body: string): [string, string] {
  const i = body.indexOf('.');
  return i < 0 ? [body, ''] : [body.slice(0, i), body.slice(i + 1)];
}

type Token = { type: 'text'; text: string } | { type: 'color'; color: RGB } | { type: 'pad'; char: string };

function splitTokens(input: string, isPrefix: boolean, _symbols: NumberSymbols): Token[] {
  const out: Token[] = [];
  let i = 0;
  let text = '';
  while (i < input.length) {
    const rest = input.slice(i);
    const colorMatch = /^\[([^\]]+)\]/.exec(rest);
    if (colorMatch) {
      const name = colorMatch[1]!.toLowerCase();
      if (name === 'red') {
        if (text) out.push({ type: 'text', text });
        text = '';
        out.push({ type: 'color', color: toRGB('red') });
      }
      i += colorMatch[0].length;
      continue;
    }
    const padMatch = /^\*(.)/.exec(rest);
    if (padMatch) {
      if (text) out.push({ type: 'text', text });
      text = '';
      out.push({ type: 'pad', char: padMatch[1]! });
      i += padMatch[0].length;
      continue;
    }
    if (rest.startsWith("''")) {
      text += "'";
      i += 2;
      continue;
    }
    if (rest.startsWith("'")) {
      const m = ESCAPED.exec(rest);
      if (m) {
        text += m[0].slice(1, -1).replace(/''/g, "'");
        i += m[0].length;
        continue;
      }
      // Unterminated quote: treat the remainder literally.
      text += rest.slice(1);
      break;
    }
    if (rest.startsWith('"')) {
      const m = QUOTED_LITERAL.exec(rest);
      if (m) {
        text += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (rest[0] === '\u00a4') {
      text += _symbols.currency;
      i += 1;
      continue;
    }
    text += rest[0];
    i += 1;
  }
  if (text) out.push({ type: 'text', text });
  void isPrefix;
  return out;
}

let parsedCache = new Map<string, { sections: ParsedSection[]; symbols: NumberSymbols }>();

function parsePattern(pattern: string, symbols: NumberSymbols): ParsedSection[] {
  const key = pattern;
  const hit = parsedCache.get(key);
  if (hit && hit.symbols === symbols) return hit.sections;
  const sections = splitSections(pattern).map((s) => parseSection(s, symbols));
  if (parsedCache.size > 500) parsedCache = new Map();
  parsedCache.set(key, { sections, symbols });
  return sections;
}

/** Split on `;` honouring quoted literals. */
function splitSections(pattern: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function group(digits: string, size: number, sep: string): string {
  if (!size || digits.length <= size) return digits;
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= size) {
    parts.unshift(digits.slice(Math.max(0, end - size), end));
  }
  return parts.join(sep);
}

function applyPattern(value: number, sec: ParsedSection, symbols: NumberSymbols): string {
  // A section with no digit placeholder is a label (`#,##0;-#,##0;—`): print the
  // affixes only — padding a synthetic `0` onto it read as "—0" in a total column.
  if (sec.literalOnly) return `${sec.prefix}${sec.suffix}`;
  let v = value;
  if (sec.percentScale) v *= 100;
  if (sec.permilleScale) v *= 1000;
  const negative = v < 0 && !Object.is(v, -0);
  v = Math.abs(v);

  let text: string;
  if (sec.scientific) {
    const digits = v.toExponential(Math.max(sec.maxFractionDigits, 0));
    text = digits.replace('e+', 'E').replace('e-', 'E-');
  } else {
    const maxFrac = Math.max(sec.maxFractionDigits, sec.minFractionDigits);
    const rounded = roundTo(v, maxFrac);
    const fixed = rounded.toFixed(maxFrac);
    const [intRaw, fracRaw = ''] = fixed.split('.');
    let intDigits = intRaw ?? '0';
    if (intDigits.length < sec.minIntegerDigits) intDigits = intDigits.padStart(sec.minIntegerDigits, '0');
    let fracDigits = fracRaw;
    // `#` in the fraction is optional: drop trailing zeros, then pad back to
    // the minimum (`#,##0.###` renders 1.5 as "1.5", not "1.500").
    if (sec.maxFractionDigits > sec.minFractionDigits) fracDigits = fracDigits.replace(/0+$/, '');
    while (fracDigits.length < sec.minFractionDigits) fracDigits += '0';
    intDigits = group(intDigits, sec.groupSize, symbols.group);
    text = fracDigits ? `${intDigits}${symbols.decimal}${fracDigits}` : intDigits;
  }
  if (sec.padChar) text = text.padStart(text.length + 2, sec.padChar);
  // ICU/Java put the negative sign *before* the prefix (`-$1,234.50`), and when the
  // section's own affixes already carry one (`[Red]-$#,##0.00`) the affix supplies
  // it — emitting ours as well produced the doubled `-$-52.00`.
  const affixSigned = sec.prefix.includes(symbols.minus) || sec.suffix.includes(symbols.minus);
  const sign = negative && !affixSigned ? symbols.minus : '';
  return `${sign}${sec.prefix}${text}${sec.suffix}`;
}

function roundTo(value: number, digits: number): number {
  // Round half away from zero, which is what financial formats expect.
  const factor = 10 ** digits;
  const scaled = value * factor;
  const rounded = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return rounded / factor;
}

/**
 * Format a number. Sections: `positive;negative` or `positive;negative;zero`.
 * A `[Red]` attribute anywhere in the section colourises the result.
 */
export function formatNumber(
  value: number,
  pattern = '#,##0.###',
  symbols: NumberSymbols = DEFAULT_SYMBOLS,
): FormatResult {
  // Non-finite input never takes a numeric section: like ICU/Java it prints a fixed
  // token, so a bad binding shows up as `NaN` rather than the pattern-shaped
  // `NaN.00` the digit loop used to produce.
  if (Number.isNaN(value)) return { text: 'NaN' };
  if (!Number.isFinite(value)) return { text: `${value < 0 ? symbols.minus : ''}\u221e` };
  const sections = parsePattern(pattern, symbols);
  const negative = value < 0;
  const zero = value === 0;
  let sec: ParsedSection;
  if (zero && sections.length >= 3) sec = sections[2]!;
  else if (negative && sections.length >= 2) sec = sections[1]!;
  else sec = sections[0]!;
  const text = applyPattern(value, sec, symbols);
  return { text, color: sec.color };
}

const DATE_TOKENS = /^(yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|SSS|a|Z|XXX|X)/;

export interface DateSymbols {
  monthNames: string[];
  monthShort: string[];
  dayNames: string[];
  dayShort: string[];
  am: string;
  pm: string;
}

export const DEFAULT_DATE_SYMBOLS: DateSymbols = {
  monthNames: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  monthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  dayShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  am: 'AM',
  pm: 'PM',
};

export function formatDate(
  date: Date | number | string,
  pattern = 'yyyy-MM-dd HH:mm',
  symbols: DateSymbols = DEFAULT_DATE_SYMBOLS,
): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const parts: Record<string, string> = {
    yyyy: String(d.getFullYear()).padStart(4, '0'),
    yy: String(d.getFullYear()).slice(-2),
    MMMM: symbols.monthNames[d.getMonth()]!,
    MMM: symbols.monthShort[d.getMonth()]!,
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    M: String(d.getMonth() + 1),
    dd: String(d.getDate()).padStart(2, '0'),
    d: String(d.getDate()),
    EEEE: symbols.dayNames[d.getDay()]!,
    EEE: symbols.dayShort[d.getDay()]!,
    HH: String(d.getHours()).padStart(2, '0'),
    H: String(d.getHours()),
    hh: String(d.getHours() % 12 || 12).padStart(2, '0'),
    h: String(d.getHours() % 12 || 12),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ss: String(d.getSeconds()).padStart(2, '0'),
    SSS: String(d.getMilliseconds()).padStart(3, '0'),
    a: d.getHours() < 12 ? symbols.am : symbols.pm,
  };
  let out = '';
  let rest = pattern;
  let quote: string | undefined;
  while (rest.length) {
    if (quote) {
      const end = rest.indexOf(quote);
      if (end < 0) {
        out += rest;
        break;
      }
      out += rest.slice(0, end);
      rest = rest.slice(end + 1);
      quote = undefined;
      continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      quote = rest[0];
      rest = rest.slice(1);
      continue;
    }
    const m = DATE_TOKENS.exec(rest);
    if (m) {
      out += parts[m[1]!] ?? m[1]!;
      rest = rest.slice(m[0].length);
      continue;
    }
    out += rest[0];
    rest = rest.slice(1);
  }
  return out;
}
