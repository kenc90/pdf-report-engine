/**
 * Function library exposed to report expressions, plus the aggregation engine.
 *
 * Aggregates need the row collection, which an expression cannot see from inside
 * a single row, so they take it explicitly:
 *
 *   `sum(rows, 'amount')`              — path shorthand
 *   `sum(rows, r => r.total * 1.2)`    — full control
 *
 * The layout engine binds `rows` to the current group's row array before
 * evaluating, and pre-computes group totals for `{TOP}`/`{BOTTOM}` tokens.
 */
import { formatNumber, formatDate, DEFAULT_SYMBOLS, type NumberSymbols } from './format.js';

export type Path = string | number | Array<string | number>;

export function getPath(obj: unknown, path: Path): unknown {
  if (Array.isArray(path)) {
    let cur = obj;
    for (const key of path) cur = (cur as Record<string, unknown> | undefined)?.[key as string];
    return cur;
  }
  const normalized = String(path)
    .replace(/^\$/, '')
    .replace(/\[(\d+)\]/g, '.$1');
  let cur: unknown = obj;
  for (const key of normalized.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (key === '') continue;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export type AggregateName = 'sum' | 'count' | 'min' | 'max' | 'avg';

/** Accept either a data path or a real function as an aggregate accessor. */
export type AccessorInput = Path | ((row: Record<string, unknown>, index: number) => unknown);

export function makeAccessor(input: AccessorInput): (row: Record<string, unknown>, index: number) => unknown {
  if (typeof input === 'function') return input;
  const path = input;
  return (row) => getPath(row, path);
}

function numericValues(rows: Array<Record<string, unknown>>, accessor: (row: Record<string, unknown>) => unknown): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = accessor(row);
    const n = typeof v === 'number' ? v : Number(v);
    if (typeof v === 'number' || (v !== null && v !== undefined && v !== '' && Number.isFinite(n))) out.push(n);
  }
  return out;
}

export function aggregate(
  name: AggregateName,
  rows: Array<Record<string, unknown>>,
  accessor: (row: Record<string, unknown>) => unknown,
): number {
  switch (name) {
    case 'count':
      return rows.filter((row) => accessor(row) !== null && accessor(row) !== undefined).length;
    case 'sum':
      return numericValues(rows, accessor).reduce((a, b) => a + b, 0);
    case 'avg': {
      const vals = numericValues(rows, accessor);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
    case 'min': {
      const vals = numericValues(rows, accessor);
      return vals.length ? Math.min(...vals) : 0;
    }
    case 'max': {
      const vals = numericValues(rows, accessor);
      return vals.length ? Math.max(...vals) : 0;
    }
  }
}

export interface LibOptions {
  symbols?: NumberSymbols;
  /** Current page info, injected as `$page` for `pageNum()` style helpers. */
  now?: () => Date;
}

/**
 * The whitelist. Anything not here is simply not callable from a template.
 */
export function createFunctions(options: LibOptions = {}): Record<string, (...args: never[]) => unknown> {
  const symbols = options.symbols ?? DEFAULT_SYMBOLS;
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

  const lib: Record<string, (...args: never[]) => unknown> = {
    // ---- formatting -------------------------------------------------------
    format: (value: unknown, pattern?: string) => {
      if (value instanceof Date || (typeof value === 'string' && pattern && /[yMdHhms]/.test(pattern) && !/[#0]/.test(pattern))) {
        return formatDate(value as Date | string, pattern ?? 'yyyy-MM-dd', undefined);
      }
      if (typeof value === 'number') return formatNumber(value, pattern ?? '#,##0.###', symbols).text;
      if (value === null || value === undefined) return '';
      return String(value);
    },
    money: (value: unknown, pattern = '#,##0.00') => formatNumber(num(value), `$${pattern}`, symbols).text,
    percent: (value: unknown, pattern = '#,##0.0%') => formatNumber(num(value), pattern, symbols).text,
    number: (value: unknown, pattern = '#,##0.###') => formatNumber(num(value), pattern, symbols).text,
    date: (value: unknown, pattern = 'yyyy-MM-dd') => formatDate(value as Date | string, pattern),
    now: () => (options.now ?? (() => new Date()))(),

    // ---- strings ---------------------------------------------------------
    upper: (v: unknown) => String(v ?? '').toUpperCase(),
    lower: (v: unknown) => String(v ?? '').toLowerCase(),
    title: (v: unknown) =>
      String(v ?? '').replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()),
    trim: (v: unknown) => String(v ?? '').trim(),
    concat: (...parts: unknown[]) => parts.map((p) => String(p ?? '')).join(''),
    substring: (v: unknown, start: number, end?: number) => String(v ?? '').substring(num(start), end === undefined ? undefined : num(end)),
    replace: (v: unknown, search: string, replacement: string) => String(v ?? '').split(String(search)).join(String(replacement)),
    pad: (v: unknown, width: number, char = ' ') => String(v ?? '').padStart(num(width), String(char)),
    length: (v: unknown) => (Array.isArray(v) ? v.length : String(v ?? '').length),
    defaultValue: (v: unknown, fallback: unknown) => (v === null || v === undefined || v === '' ? fallback : v),

    // ---- math -----------------------------------------------------------
    round: (v: unknown, digits = 0) => {
      const f = 10 ** num(digits);
      const x = num(v) * f;
      return (x >= 0 ? Math.round(x) : -Math.round(-x)) / f;
    },
    abs: (v: unknown) => Math.abs(num(v)),
    ceil: (v: unknown) => Math.ceil(num(v)),
    floor: (v: unknown) => Math.floor(num(v)),
    min: (...args: unknown[]) => {
      const flat = flattenArgs(args);
      const nums = flat.map(num).filter(Number.isFinite);
      return nums.length ? Math.min(...nums) : 0;
    },
    max: (...args: unknown[]) => {
      const flat = flattenArgs(args);
      const nums = flat.map(num).filter(Number.isFinite);
      return nums.length ? Math.max(...nums) : 0;
    },
    sum: (...args: unknown[]) => {
      const flat = flattenArgs(args);
      return flat.map(num).filter(Number.isFinite).reduce((a, b) => a + b, 0);
    },

    // ---- logic ----------------------------------------------------------
    // Named `iif` (not `if`): library keys become `new Function` parameter names,
    // and `if` is a reserved word that cannot be an identifier.
    iif: (cond: unknown, a: unknown, b: unknown) => (cond ? a : b),
    isBlank: (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0),
    coalesce: (...args: unknown[]) => args.find((a) => a !== null && a !== undefined && a !== '') ?? null,
  };
  return lib;
}

function flattenArgs(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...a);
    else out.push(a);
  }
  return out;
}
