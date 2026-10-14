/**
 * Regenerates the sorted, deduplicated break-class table inside
 * `src/text/linebreak.ts`. Run after editing the table by hand:
 *
 *   npx tsx scripts/fix-linebreak-table.ts
 *
 * Overlaps resolve "later entry wins", so you can append a narrow override
 * after a broad range. The script rebuilds the table by run-length encoding a
 * code-point -> class array, which guarantees sorted + non-overlapping output.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Range {
  from: number;
  to: number;
  cls: string;
}

const OPEN = 'const RANGES: Range[] = [';
const file = new URL('../src/text/linebreak.ts', import.meta.url);
const src = readFileSync(file, 'utf8');
const start = src.indexOf(OPEN);
if (start < 0) throw new Error('RANGES table opening not found');
const end = src.indexOf('\n];', start);
if (end < 0) throw new Error('RANGES table end not found');
const body = src.slice(start + OPEN.length, end);

const entryRe = new RegExp('from:\\s*(0x[0-9a-fA-F]+),\\s*to:\\s*(0x[0-9a-fA-F]+),\\s*cls:\\s*LB\\.(\\w+)', 'g');
const entries: Range[] = [];
for (const m of body.matchAll(entryRe)) {
  entries.push({ from: parseInt(m[1]!, 16), to: parseInt(m[2]!, 16), cls: m[3]! });
}
console.log('parsed', entries.length, 'entries');

const MAX = 0x110000;
const ids: string[] = [];
const idOf = new Map<string, number>();
const classMap = new Int32Array(MAX); // 0 == unset (falls back to LB.AL)
for (const e of entries) {
  let id = idOf.get(e.cls);
  if (id === undefined) {
    id = ids.push(e.cls) - 1;
    idOf.set(e.cls, id + 1);
  }
  classMap.fill(id + 1, Math.max(0, e.from), Math.min(MAX, e.to + 1));
}

const runs: Range[] = [];
let cur = 0;
let from = 0;
for (let cp = 0; cp < MAX; cp += 1) {
  const v = classMap[cp]!;
  if (v !== cur) {
    if (cur !== 0) runs.push({ from, to: cp - 1, cls: ids[cur - 1]! });
    cur = v;
    from = cp;
  }
}
if (cur !== 0) runs.push({ from, to: MAX - 1, cls: ids[cur - 1]! });

const merged: Range[] = [];
for (const r of runs) {
  const last = merged[merged.length - 1];
  if (last && last.cls === r.cls && last.to + 1 === r.from) last.to = r.to;
  else merged.push({ ...r });
}

const hex = (n: number): string => '0x' + n.toString(16).padStart(4, '0');
const table = merged.map((r) => `  { from: ${hex(r.from)}, to: ${hex(r.to)}, cls: LB.${r.cls} },`).join('\n');
writeFileSync(file, src.slice(0, start + OPEN.length) + '\n' + table + src.slice(end));
console.log('wrote', merged.length, 'ranges');
console.log(
  'sanity: ID =',
  merged.some((r) => r.cls === 'ID'),
  '| SA =',
  merged.some((r) => r.cls === 'SA'),
  '| AL =',
  merged.some((r) => r.cls === 'AL'),
);
