/**
 * Expression language tests: the scopes a binding can see, the whitelisted
 * function library, the ICU-ish number/date pattern behaviour the docs promise,
 * and the sandbox guards. Every example in `docs/api.html#expr` is asserted here.
 */
import { describe, expect, it } from 'vitest';
import { ExprCompiler, CompiledExpr } from '../src/expr/eval.js';
import { createFunctions } from '../src/expr/functions.js';
import { formatDate, formatNumber } from '../src/expr/format.js';
import { LayoutContext, resolveContent } from '../src/layout/context.js';
import { FontRegistry, HeuristicFontHandle } from '../src/fonts/registry.js';
import { resolveStyle } from '../src/text/style.js';
import type { Content } from '../src/ir/schema.js';

const compiler = new ExprCompiler(createFunctions());
const scope = {
  $row: { region: 'EMEA', amount: 1200, qty: 3, customer: { city: 'Lisbon' }, items: [{ sku: 'A-1' }] },
  $group: { amount_sum: 3600, rowCount: 3 },
  $page: { number: 2, total: 5 },
  $data: { company: 'Acme', rate: 1.21 },
  $vars: { grandTotal: 48120 },
  $index: 4,
};
const ev = (source: string): unknown => compiler.evaluate(source, scope);

/** Layout-side binding resolution: the fast field-path check plus the compiler. */
const registry = new FontRegistry();
registry.addHandle(new HeuristicFontHandle('Test', 400, 'normal'));
const layout = new LayoutContext({
  registry,
  baseStyle: resolveStyle({ fontFamily: 'Test', fontSize: 10 }, registry, undefined),
  data: scope.$data,
  vars: scope.$vars,
});
const bind = (source: string): string => {
  const inlines = resolveContent([{ bind: source } as Content] as Content, layout, layout.baseStyle, scope);
  return inlines.map((i) => i.text).join('');
};

describe('expression scopes', () => {
  it('reads the current row, nested fields and array items', () => {
    expect(ev('$row.region')).toBe('EMEA');
    expect(ev('$row.customer.city')).toBe('Lisbon');
    expect(ev('$row.items[0].sku')).toBe('A-1');
  });

  it('does not accept a bare field name — a path needs its scope root', () => {
    expect(() => ev('amount * 2')).toThrow(/not defined/);
  });

  it('computes across scopes', () => {
    expect(ev('$row.amount * $data.rate')).toBeCloseTo(1452, 6);
    expect(ev('$row.qty >= 3 ? "bulk" : "standard"')).toBe('bulk');
    expect(ev('$row.missing?.amount ?? 0')).toBe(0);
    expect(ev("$data['company']")).toBe('Acme');
  });

  it('exposes group totals, page numbers, variables and the row index', () => {
    expect(ev('$group.amount_sum')).toBe(3600);
    expect(ev('$page.number + " of " + $page.total')).toBe('2 of 5');
    expect(ev('$vars.grandTotal')).toBe(48120);
    expect(ev('$index + 1')).toBe(5);
  });

  it('resolves `$field` shorthand against the row, then the data root', () => {
    // The shorthand lives in the binding fast path, not in compiled code: a plain
    // `$region` is read as "row field, else data field" without becoming an
    // identifier (a bare `$region` inside a real expression is a ReferenceError).
    expect(bind('$region')).toBe('EMEA');
    expect(bind('$company')).toBe('Acme');
    expect(bind('region')).toBe('EMEA');
    expect(bind('customer.city')).toBe('Lisbon');
    // Once there is an operator it is code, so the scope root has to be written out.
    expect(() => bind('amount * 1')).toThrow(/not defined/);
    expect(bind('$row.amount * 1')).toBe('1200');
    expect(() => compiler.evaluate('$region', scope)).toThrow(/not defined/);
  });

  it('calls library functions inside an expression', () => {
    expect(ev("concat(upper($row.region), ' — ', money($group.amount_sum))")).toBe('EMEA — $3,600.00');
    expect(ev('iif($row.amount > 1000, "high", "low")')).toBe('high');
  });
});

describe('expression library', () => {
  const lib = createFunctions() as Record<string, (...a: unknown[]) => unknown>;
  const call = (name: string) => lib[name] as (...a: unknown[]) => unknown;

  it('formats money, percent and plain numbers', () => {
    expect(call('money')(1234.5)).toBe('$1,234.50');
    expect(call('money')(-1234.5)).toBe('-$1,234.50');
    expect(call('percent')(0.1842)).toBe('18.4%');
    expect(call('number')(1234567.891)).toBe('1,234,567.891');
    expect(call('number')(1.5)).toBe('1.5');
  });

  it('formats with an explicit pattern, dates included', () => {
    const d = new Date(2026, 9, 20, 14, 5, 9, 123);
    expect(call('format')(1234.5, '#,##0.00')).toBe('1,234.50');
    expect(call('format')(d, 'dd/MM/yyyy')).toBe('20/10/2026');
    expect(call('format')('hello world')).toBe('hello world');
    expect(call('format')(null, '#,##0')).toBe('');
    expect(call('date')('2026-10-20T14:05:09')).toBe('2026-10-20');
  });

  it('manipulates strings', () => {
    expect(call('title')('quarterly report')).toBe('Quarterly Report');
    expect(call('concat')('Total: ', 12.5, null, 'x')).toBe('Total: 12.5x');
    expect(call('pad')('7', 3, '0')).toBe('007');
    expect(call('replace')('a-b-c', '-', '+')).toBe('a+b+c');
    expect(call('substring')('invoice-2026', 8)).toBe('2026');
    expect([call('length')([1, 2, 3]), call('length')('abc')]).toEqual([3, 3]);
    expect(call('defaultValue')('', 'n/a')).toBe('n/a');
  });

  it('rounds half away from zero and folds arrays into the maths helpers', () => {
    expect(call('round')(2.675, 2)).toBe(2.68);
    expect(call('round')(-2.5)).toBe(-3);
    expect(call('sum')([1, 2], [3])).toBe(6);
    expect([call('min')(4, 2, 9), call('max')(4, 2, 9)]).toEqual([2, 9]);
    expect([call('abs')(-3), call('ceil')(1.2), call('floor')(1.8)]).toEqual([3, 2, 1]);
  });

  it('answers logic questions', () => {
    expect(call('iif')(1 > 2, 'a', 'b')).toBe('b');
    expect([call('isBlank')([]), call('isBlank')('x')]).toEqual([true, false]);
    expect(call('coalesce')(null, '', 7)).toBe(7);
  });
});

describe('number patterns', () => {
  it('rounds to the declared fraction digits and keeps optional ones blank', () => {
    expect(formatNumber(1234.5, '#,##0.00').text).toBe('1,234.50');
    expect(formatNumber(1234.5, '#,##0').text).toBe('1,235');
    expect(formatNumber(1234.4, '#,##0').text).toBe('1,234');
    expect(formatNumber(1.5, '#,##0.###').text).toBe('1.5');
    expect(formatNumber(5.004, '0.00').text).toBe('5.00');
    expect(formatNumber(42, '0000').text).toBe('0042');
  });

  it('scales on percent and permille wherever the sign sits', () => {
    expect(formatNumber(0.1234, '#,##0%').text).toBe('12%');
    // A leading sign still scales the value but stays a prefix, as in Java.
    expect(formatNumber(0.1234, '%#,##0.0').text).toBe('%12.3');
    expect(formatNumber(0.1234, '#,##0.0‰').text).toBe('123.4‰');
  });

  it('puts a negative sign before the prefix, and honours extra sections', () => {
    expect(formatNumber(-52, '$#,##0.00').text).toBe('-$52.00');
    const red = formatNumber(-52, '$#,##0.00;[Red]-$#,##0.00');
    expect(red.text).toBe('-$52.00');
    expect(red.color).toEqual([1, 0, 0]);
    expect(formatNumber(0, '#,##0;-#,##0;(0);@').text).toBe('(0)');
  });

  it('supports quoting, padding, scientific notation and literals', () => {
    expect(formatNumber(12.5, "'€'#,##0.00").text).toBe('€12.50');
    expect(formatNumber(12.34, '#,##0.0"%"').text).toBe('12.3%'); // quoted % is not a scale
    expect(formatNumber(42, '*0#,##0').text).toBe('0042');
    expect(formatNumber(123456, '0.###E0').text).toBe('1.235E5');
    expect(formatNumber(0, '#,##0;(#,##0);"-"').text).toBe('-'); // label-only zero section
  });

  it('prints a fixed token for non-finite values', () => {
    expect(formatNumber(Number.NaN, '#,##0.00').text).toBe('NaN');
    expect(formatNumber(Infinity, '#,##0.00').text).toBe('\u221e');
    expect(formatNumber(-Infinity, '#,##0.00').text).toBe('-\u221e');
  });
});

describe('date patterns', () => {
  const d = new Date(2026, 9, 20, 14, 5, 9, 123); // Tue 20 Oct 2026, 14:05:09.123

  it('renders the supported tokens', () => {
    expect(formatDate(d, 'yyyy-MM-dd')).toBe('2026-10-20');
    expect(formatDate(d, 'yyyy-MM-dd HH:mm')).toBe('2026-10-20 14:05');
    expect(formatDate(d, 'dd/MM/yyyy')).toBe('20/10/2026');
    expect(formatDate(d, 'MMM d, yyyy')).toBe('Oct 20, 2026');
    expect(formatDate(d, 'MMMM yyyy')).toBe('October 2026');
    expect(formatDate(d, 'EEE, d MMM yyyy HH:mm:ss')).toBe('Tue, 20 Oct 2026 14:05:09');
    expect(formatDate(d, 'h:mm a')).toBe('2:05 PM');
    expect(formatDate(d, `yyyy-MM-dd'T'HH:mm`)).toBe('2026-10-20T14:05');
    expect(formatDate(d, 'HH:mm:ss.SSS')).toBe('14:05:09.123');
    expect(formatDate(d, 'M/d/yy')).toBe('10/20/26');
  });

  it('passes an unsupported token through rather than guessing', () => {
    expect(formatDate(d, 'QQQQ')).toBe('QQQQ'); // no quarter names
  });

  it('parses a date string', () => {
    expect(formatDate('2026-10-20T14:05:09', 'yyyy-MM-dd HH:mm')).toBe('2026-10-20 14:05');
  });
});

describe('expression sandbox', () => {
  const run = (source: string): unknown => new CompiledExpr(source, createFunctions()).eval(scope);

  it('refuses prototype plumbing in every access form', () => {
    for (const source of [
      '$row.constructor',
      '$row.region.constructor.constructor("return 6*7")()',
      "$row.region['constructor']",
      '$row.__proto__',
      '$row.nested.prototype',
      '$row.__defineGetter__("x", 1)',
    ]) {
      expect(() => run(source)).toThrow(/forbidden identifier|dunder/);
    }
  });

  it('refuses the host realm: globals are shadowed, eval and this are rejected', () => {
    for (const source of [
      'eval("1+1")',
      '(1, eval)("1+1")',
      'this',
      'globalThis',
      'process.exit(1)',
      'require("fs")',
      'Date.now()',
      'new Date(0)',
      'Math.max(1, 2)',
      'JSON.stringify($row)',
      'Function("return 1")()',
    ]) {
      expect(() => run(source)).toThrow();
      expect(() => run(source)).not.toThrow(/Cannot compile/); // blocked by the sandbox, not by syntax
    }
    expect(() => run('Math.max(1, 2)')).toThrow(/undefined/);
  });

  it('still allows the documented grammar', () => {
    expect(run('$row.amount && "yes"')).toBe('yes');
    expect(run('$row.missing || "fallback"')).toBe('fallback');
    expect(run('!$row.missing')).toBe(true);
    expect(run('$row.region.toUpperCase()')).toBe('EMEA');
    expect(run('[1, 2, 3].length')).toBe(3);
    expect(run('rows.length')).toBe(0);
  });
});
