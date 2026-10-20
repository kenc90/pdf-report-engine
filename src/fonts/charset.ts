/**
 * Collects the set of characters that a ReportDoc will actually render, so the
 * remote-font resolver can request only the needed glyphs from Google Fonts via
 * the `text=` subset parameter.
 *
 * Walks every text-bearing node in the IR tree (paragraph/heading content, table
 * cells, band blocks) plus all string/number values reachable from `report.data`
 * (since data-bind expressions pull characters from there at render time). Also
 * includes the full printable ASCII range so `text-transform: uppercase/lowercase`
 * is always covered regardless of whether the source uses capitals.
 *
 * Returns a deduplicated string of all code points (including upper/lower-case
 * variants of non-ASCII glyphs). If the result is empty (no text at all) the
 * caller should skip subsetting and fetch the full font instead.
 */
import type {
  ReportDoc,
  Content,
  ContentSpan,
  CellContent,
  Block,
  RowNode,
  CellNode,
  BandContent,
  GroupNode,
} from '../ir/schema.js';

/** Maximum length (in characters) of the collected charset before we give up on subsetting. */
const MAX_CHARSET = 2000;

/**
 * Walk the ReportDoc and return a string containing every code point that will
 * be rendered, including upper/lower variants. An empty string means the document
 * has no text; callers should fall back to fetching the full font.
 */
export function collectCharset(report: ReportDoc): string {
  const set = new Set<string>();

  // Full printable ASCII so text-transform (uppercase/lowercase) is always covered.
  for (let c = 0x20; c <= 0x7e; c++) set.add(String.fromCharCode(c));

  // Walk body blocks.
  walkBlocks(report.body, set);

  // Walk bands (pageHeader, pageFooter, title, summary, background).
  if (report.bands) {
    for (const band of Object.values(report.bands)) {
      if (band) walkBand(band, set);
    }
  }

  // Walk data values — covers bound cells that pull strings from the dataset.
  if (report.data) walkData(report.data, set);

  // Add upper/lower case variants for non-ASCII chars already collected.
  const extras: string[] = [];
  for (const ch of set) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7e) {
      for (const u of ch.toUpperCase()) { if (u.codePointAt(0)! >= 0x20) extras.push(u); }
      for (const l of ch.toLowerCase()) { if (l.codePointAt(0)! >= 0x20) extras.push(l); }
    }
  }
  for (const ch of extras) set.add(ch);

  // Guard: if charset exceeds Google's practical URL limit, return empty (skip subsetting).
  if (set.size > MAX_CHARSET) return '';

  return [...set].join('');
}

// --- helpers: recursively collect characters from the IR tree ---------------

function walkBlocks(blocks: Block[] | undefined, set: Set<string>): void {
  if (!blocks) return;
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        walkContent(b.content, set);
        break;
      case 'heading':
        walkContent(b.content, set);
        break;
      case 'table':
        walkTable(b, set);
        break;
      default:
        // spacer, pageBreak, image — no text.
        break;
    }
  }
}

function walkTable(block: Extract<Block, { type: 'table' }>, set: Set<string>): void {
  walkRows(block.headerRows, set);
  walkRows(block.footerRows, set);
  walkRows(block.staticRows, set);
  if (block.detail) {
    if ('cells' in block.detail && Array.isArray(block.detail.cells)) {
      // { cells: CellContent[] }
      for (const cell of block.detail.cells) walkCellContent(cell, set);
    } else if ('cells' in block.detail) {
      // RowNode
      walkRowNode(block.detail as RowNode, set);
    }
  }
  if (block.groups) {
    for (const g of block.groups) walkGroup(g, set);
  }
}

function walkGroup(group: GroupNode, set: Set<string>): void {
  if (typeof group.header === 'string') addStr(group.header, set);
  else if (group.header) walkContent(group.header, set);
  if (typeof group.footer === 'string') addStr(group.footer, set);
  else if (group.footer) walkContent(group.footer, set);
  // label/header text
  if (typeof group.label === 'string') addStr(group.label, set);
}

function walkRows(rows: RowNode[] | undefined, set: Set<string>): void {
  if (!rows) return;
  for (const row of rows) walkRowNode(row, set);
}

function walkRowNode(row: RowNode, set: Set<string>): void {
  if (row.cells) for (const cell of row.cells) walkCell(cell, set);
}

function walkCell(cell: CellNode, set: Set<string>): void {
  if (cell.content !== undefined) walkCellContent(cell.content, set);
}

function walkCellContent(content: CellContent, set: Set<string>): void {
  if (content === undefined || content === null) return;
  // CellNode is an object with a .content field or a cell-style shape; Content is
  // string | number | ContentSpan | Array. Distinguish by checking for 'content' key.
  if (typeof content === 'object' && !Array.isArray(content) && 'content' in content) {
    walkCell((content as CellNode).content !== undefined ? (content as CellNode) : { content: content as CellContent, ...{} } as unknown as CellNode, set);
  } else {
    walkContent(content as Content, set);
  }
}

function walkContent(content: Content, set: Set<string>): void {
  if (typeof content === 'string') { addStr(content, set); return; }
  if (typeof content === 'number') { addStr(String(content), set); return; }
  if (Array.isArray(content)) {
    for (const item of content) walkContent(item, set);
    return;
  }
  // ContentSpan
  if (typeof content === 'object' && content !== null) {
    const span = content as ContentSpan;
    if (span.text !== undefined) walkContent(span.text, set);
    if (span.children !== undefined) walkContent(span.children, set);
  }
}

function walkBand(band: BandContent, set: Set<string>): void {
  if (band.blocks) walkBlocks(band.blocks, set);
  if (band.text !== undefined) walkContent(band.text, set);
}

function walkData(data: unknown, set: Set<string>): void {
  if (typeof data === 'string') { addStr(data, set); return; }
  if (typeof data === 'number') { addStr(String(data), set); return; }
  if (Array.isArray(data)) {
    for (const item of data) walkData(item, set);
    return;
  }
  if (data && typeof data === 'object') {
    for (const val of Object.values(data)) walkData(val, set);
  }
}

function addStr(s: string, set: Set<string>): void {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20) set.add(ch); // skip control chars
  }
}
