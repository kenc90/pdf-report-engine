/**
 * A deliberately tiny, *sandboxed* expression evaluator for bindings and
 * aggregates. Design constraints:
 *
 *  - no `eval` of arbitrary host globals: the expression runs inside a strict
 *    `Function` whose scope is a proxy whitelist, and every ECMAScript built-in
 *    is shadowed by a parameter bound to `undefined`.
 *  - no prototype reachability: `__proto__` / `constructor` / `prototype` and any
 *    dunder property are rejected in the source, in *every* access form (`.x`,
 *    `['x']`, bare), so a template cannot walk from a data value to `Function`.
 *  - identifiers starting with `$` are the data scope; bare names are functions
 *    from the function library.
 *
 * Supported: literals, arithmetic, comparison, ternary, `?.`, member/index
 * access on data, and library calls. That is enough for report bindings and
 * totals without becoming a language project.
 */

/** Property names that may never be read, whatever the access form. */
const FORBIDDEN_PROPS = ['__proto__', 'constructor', 'prototype'];

/** Reserved words and host handles that may never appear as an identifier. */
const FORBIDDEN_WORDS = ['eval', 'globalThis', 'global', 'process', 'require', 'import', 'export', 'module', 'this', 'arguments', 'super'];

/**
 * ECMAScript / host globals neutralised by shadowing them with an `undefined`
 * parameter. Report templates get the whitelist below, never the realm's globals:
 * `Date`/`Math`/`JSON`/`Function` are simply not there. (`eval`/`arguments` cannot
 * be parameter names in strict code, so they are rejected by the scan instead.)
 */
const SHADOWED_GLOBALS = [
  'Function', 'Date', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol',
  'Reflect', 'Proxy', 'WeakMap', 'WeakSet', 'Map', 'Set', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Intl', 'WebAssembly', 'Atomics', 'structuredClone',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'fetch', 'XMLHttpRequest',
  'window', 'document', 'self', 'top', 'parent', 'Buffer',
];

/**
 * Keys stripped from incoming data and refused by the scope proxy. Deliberately
 * narrow: ordinary report fields must survive `harden()`.
 */
const FORBIDDEN_KEYS = new Set([...FORBIDDEN_PROPS, 'globalThis', 'process', 'require', 'import']);

/**
 * The scope roots exposed as direct identifiers in a compiled expression, in the
 * exact order they are bound at call time in {@link CompiledExpr.eval}. `rows`
 * (the aggregate array) is bound separately ahead of these.
 */
const SCOPE_PARAM_NAMES = ['$row', '$group', '$report', '$page', '$data', '$vars', '$index'] as const;

export type ExprValue = unknown;

export interface ExprContext {
  $row?: Record<string, unknown>;
  $group?: Record<string, unknown>;
  $report?: Record<string, unknown>;
  $page?: { number: number; total: number; top?: number; bottom?: number };
  $data?: Record<string, unknown>;
  $index?: number;
  $vars?: Record<string, unknown>;
}

export type Aggregator = 'sum' | 'count' | 'min' | 'max' | 'avg';

/**
 * Normalises the two accepted forms (`{ expr }` or a bare string) into a string.
 */
export function exprSource(expr: unknown): string | undefined {
  if (typeof expr === 'string') return expr;
  if (expr && typeof expr === 'object' && 'expr' in expr) {
    const value = (expr as { expr: unknown }).expr;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function isSafeKey(key: unknown): boolean {
  return typeof key === 'string' ? !FORBIDDEN_KEYS.has(key) : true;
}

/** Recursive guard: data objects coming from user JSON can carry hostile keys. */
function harden(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as object;
  seen ??= new WeakSet();
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  if (Array.isArray(value)) return value.map((v) => harden(v, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!isSafeKey(key)) continue;
    out[key] = harden((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

export interface EvalOptions {
  functions?: Record<string, (...args: never[]) => unknown>;
}

/** Compile once, evaluate many: report rows reuse the same generated closure. */
export class CompiledExpr {
  readonly source: string;
  private readonly fn: (...args: unknown[]) => unknown;
  /** Library function values, ordered to match the parameter names bound below. */
  private readonly libArgs: unknown[];
  /** One `undefined` per shadowed global, so those names can never resolve. */
  private readonly shadowArgs: unknown[];

  constructor(source: string, functions: Record<string, (...args: never[]) => unknown>) {
    this.source = source;
    // Validate before wrapping. Forbidden *properties* are matched even after a
    // dot or inside a bracket string, because `.constructor` is precisely how a
    // template would climb from a data value to `Function`.
    for (const forbidden of FORBIDDEN_PROPS) {
      if (new RegExp(`(^|[^$\\w])${forbidden}\\b`).test(source)) {
        throw new Error(`Expression references a forbidden identifier "${forbidden}": ${source}`);
      }
    }
    for (const forbidden of FORBIDDEN_WORDS) {
      if (new RegExp(`(^|[^$\\w.])${forbidden}\\b`).test(source)) {
        throw new Error(`Expression references a forbidden identifier "${forbidden}": ${source}`);
      }
    }
    // Any dunder (`__defineGetter__`, `__lookupGetter__`, …) is prototype plumbing.
    if (/__\w/.test(source)) {
      throw new Error(`Expression may not access a dunder property: ${source}`);
    }
    // Scope roots are declared as parameters so a template can write them
    // directly (`$page.number`, `$row.amount * 1.2`, `$group.total`). The `$`
    // proxy stays for `$.whatever` member access; everything else is a library
    // function from the whitelist. Globals are shadowed last so they can never
    // resolve to the host realm's.
    const libNames = Object.keys(functions);
    const shadowed = SHADOWED_GLOBALS.filter((g) => !libNames.includes(g) && !SCOPE_PARAM_NAMES.includes(g as never));
    const names = ['$', 'rows', ...SCOPE_PARAM_NAMES, ...libNames, ...shadowed];
    this.libArgs = libNames.map((n) => functions[n]);
    this.shadowArgs = shadowed.map(() => undefined);
    try {
      // eslint-disable-next-line no-new-func
      this.fn = new Function(...names, `"use strict"; return (${source});`) as (
        ...args: unknown[]
      ) => unknown;
    } catch (error) {
      throw new Error(`Cannot compile expression ${JSON.stringify(source)}: ${(error as Error).message}`);
    }
  }

  eval(ctx: ExprContext, rows?: Array<Record<string, unknown>>): unknown {
    const scope: Record<string, unknown> = {
      row: ctx.$row ?? {},
      group: ctx.$group ?? {},
      report: ctx.$report ?? {},
      page: ctx.$page ?? { number: 1, total: 1 },
      data: ctx.$data ?? {},
      vars: ctx.$vars ?? {},
      index: ctx.$index ?? 0,
    };
    const proxy = new Proxy(scope, {
      get(target, key) {
        if (typeof key === 'symbol') return undefined;
        if (!isSafeKey(key)) return undefined;
        if (key in target) return target[key];
        // `$region` style shorthand resolves against the row first, then data.
        if (key.startsWith('$')) {
          const bare = key.slice(1);
          const row = target.row as Record<string, unknown>;
          if (row && bare in row) return row[bare];
          const data = target.data as Record<string, unknown>;
          if (data && bare in data) return data[bare];
        }
        return undefined;
      },
      has(target, key) {
        return typeof key === 'string' && isSafeKey(key);
      },
      // Blocking everything else keeps `Function` from falling back to globals.
      getOwnPropertyDescriptor() {
        return undefined;
      },
      getPrototypeOf() {
        return null;
      },
    });
    // Bind scope roots in the same order as SCOPE_PARAM_NAMES so `$page.number`,
    // `$row.amount`, `$index`, etc. resolve as direct identifiers. `$page` always
    // has a value (default 1/1) so running tokens never throw on a bare template.
    const rootValues: Record<string, unknown> = {
      $row: ctx.$row,
      $group: ctx.$group,
      $report: ctx.$report,
      $page: ctx.$page ?? { number: 1, total: 1 },
      $data: ctx.$data,
      $vars: ctx.$vars,
      $index: ctx.$index ?? 0,
    };
    const scopeArgs = SCOPE_PARAM_NAMES.map((name) => rootValues[name]);
    // Call detached (not `this.fn(...)`), so in strict mode `this` inside the
    // closure is `undefined` rather than this instance — a template cannot read
    // the engine's own objects off the receiver.
    const fn = this.fn;
    return fn(proxy, rows ?? [], ...scopeArgs, ...this.libArgs, ...this.shadowArgs);
  }
}

export class ExprCompiler {
  private readonly functions: Record<string, (...args: never[]) => unknown>;
  private readonly cache = new Map<string, CompiledExpr>();

  constructor(functions: Record<string, (...args: never[]) => unknown> = {}) {
    this.functions = functions;
  }

  compile(expr: unknown): CompiledExpr | undefined {
    const source = exprSource(expr);
    if (source === undefined) return undefined;
    let cached = this.cache.get(source);
    if (!cached) {
      cached = new CompiledExpr(source, this.functions as Record<string, (...args: never[]) => unknown>);
      this.cache.set(source, cached);
    }
    return cached;
  }

  evaluate(expr: unknown, ctx: ExprContext, rows?: Array<Record<string, unknown>>): unknown {
    const compiled = this.compile(expr);
    if (!compiled) return undefined;
    return compiled.eval(harden(ctx, new WeakSet()) as ExprContext, rows);
  }
}

/** Collect `rows` from an aggregation call so the evaluator can pass the array. */
const AGGREGATE_CALL = /\b(sum|count|min|max|avg)\s*\(/g;

export function usesAggregate(source: string): boolean {
  AGGREGATE_CALL.lastIndex = 0;
  return AGGREGATE_CALL.test(source);
}
