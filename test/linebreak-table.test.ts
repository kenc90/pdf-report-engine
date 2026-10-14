/**
 * Validates the break-class range table: it must be sorted, non-overlapping and
 * complete where it claims to be. A binary search silently returns *some* match,
 * so an overlap is a correctness bug, not a style issue.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LB, classOf, findBreaks } from '../src/text/linebreak.js';

interface Range {
  from: number;
  to: number;
  cls: LB;
}

function loadRanges(): Range[] {
  const src = readFileSync(new URL('../src/text/linebreak.ts', import.meta.url), 'utf8');
  const body = /const RANGES: Range\[\] = \[([\s\S]*?)\];/.exec(src);
  if (!body) throw new Error('RANGES table not found');
  const out: Range[] = [];
  for (const m of body[1]!.matchAll(/from:\s*(0x[0-9a-fA-F]+),\s*to:\s*(0x[0-9a-fA-F]+),\s*cls:\s*LB\.(\w+)/g)) {
    out.push({ from: parseInt(m[1]!, 16), to: parseInt(m[2]!, 16), cls: m[3]! as LB });
  }
  return out;
}

it('break-class table is sorted and non-overlapping', () => {
  const ranges = loadRanges();
  expect(ranges.length).toBeGreaterThan(50);
  const problems: string[] = [];
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = ranges[i - 1]!;
    const cur = ranges[i]!;
    if (cur.from <= prev.to) {
      problems.push(`overlap: U+${cur.from.toString(16)} (${cur.cls}) inside U+${prev.from.toString(16)}-U+${prev.to.toString(16)} (${prev.cls})`);
    }
    if (cur.from > cur.to) problems.push(`inverted range U+${cur.from.toString(16)}-U+${cur.to.toString(16)}`);
  }
  expect(problems, problems.join('\n')).toEqual([]);
});

it('classifies the characters reports actually contain', () => {
  expect(classOf(0x0041)).toBe(LB.AL); // A
  expect(classOf(0x00e9)).toBe(LB.AL); // é
  expect(classOf(0x0430)).toBe(LB.AL); // а
  expect(classOf(0x0020)).toBe(LB.SP);
  expect(classOf(0x00a0)).toBe(LB.GL); // NBSP
  expect(classOf(0x0030)).toBe(LB.NU);
  expect(classOf(0x002e)).toBe(LB.IN);
  expect(classOf(0x0028)).toBe(LB.OP);
  expect(classOf(0x0029)).toBe(LB.CL);
  expect(classOf(0x002d)).toBe(LB.IS);
  expect(classOf(0x4e2d)).toBe(LB.ID); // 中
  expect(classOf(0x3002) as LB).toBe(LB.ID); // 。
  expect(classOf(0x0e01)).toBe(LB.SA); // Thai ก
  expect(classOf(0x2014)).toBe(LB.EM); // em dash
});

it('token round-trips the input exactly', () => {
  const samples = [
    'Hello, world! 42 items (see p.7) — €1,234.56 each.',
    '本報告書は、売上高 ¥1,234,567（前年比 +12.5%）を示します。',
    'a b c​d',
    'multi\nline\r\ntext',
    'soft hy\u00ADphen break',
  ];
  for (const s of samples) {
    const tokens = findBreaks(s);
    expect(tokens.map((t) => t.text).join(''), s).toBe(s.replace(/\r\n/g, '\n'));
  }
});
