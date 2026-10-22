/**
 * The flow model shared by layout, pagination and the writer.
 *
 * A `Fragment` is the atomic unit a page cursor can move to the next page. It
 * carries only what pagination needs (heights, spacing, break hints, role) plus a
 * list of `DrawCommand`s expressed in *fragment-local* coordinates (origin at the
 * fragment's top-left, full content width). Pagination translates them to page
 * space; the writer executes them. Keeping paint as inert data (not closures)
 * means fragments are serialisable and the layout pass never touches pdfkit.
 */
import { toRGB, type RGB, type ColorInput } from '../core/color.js';
import type { PositionedRun } from '../text/typeset.js';

export type DashPattern = number[];

/** A point in fragment-local space, used by `poly`. */
export type PolyPoint = [number, number];

export type DrawCommand =
  | { op: 'fillRect'; x: number; y: number; w: number; h: number; color: RGB; opacity?: number }
  | { op: 'strokeRect'; x: number; y: number; w: number; h: number; color: RGB; lineWidth: number; dash?: DashPattern }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: RGB; lineWidth: number; dash?: DashPattern }
  | {
      op: 'poly';
      points: PolyPoint[];
      /** Fill the closed outline (implicitly closed, like SVG `fill`). */
      fill?: RGB;
      fillOpacity?: number;
      stroke?: { color: RGB; lineWidth: number; dash?: DashPattern };
      close?: boolean;
      /**
       * Winding rule used when filling. Defaults to `'nonzero'` (the PDF `f`
       * operator, and what the rest of the engine emits); `'evenodd'` maps to
       * `f*` and is how SVG `fill-rule="evenodd"` self-overlapping paths — a
       * donut made of two same-direction circles — punch their holes.
       */
      fillRule?: 'nonzero' | 'evenodd';
    }
  | {
      op: 'path';
      /**
       * One or more subpaths. Keeping them in a single command (rather than
       * separate `poly`s) is what lets SVG fills express holes: both the
       * `evenodd` rule and reverse-wound `nonzero` need the rings in one path.
       */
      subpaths: Array<{ points: PolyPoint[]; closed: boolean }>;
      fill?: RGB;
      fillOpacity?: number;
      fillRule?: 'nonzero' | 'evenodd';
      stroke?: { color: RGB; lineWidth: number; dash?: DashPattern };
    }
  | { op: 'text'; x: number; baselineY: number; runs: PositionedRun[]; gapWidth: number; decorations: Decoration[] }
  | { op: 'underline'; x1: number; y1: number; x2: number; color: RGB; lineWidth: number; lineThrough?: boolean }
  | { op: 'image'; x: number; y: number; w: number; h: number; src: string | Uint8Array };

/** A heading that becomes a PDF bookmark and a table-of-contents entry. */
export interface OutlineEntry {
  level: number;
  title: string;
  /** Destination anchor name (the heading's `id`, when present). */
  anchor?: string;
  /** `'append'` prefixes the entry with a hierarchical section number. */
  numbering?: 'append' | 'none';
}

export interface Decoration {
  kind: 'underline' | 'line-through';
}

export type FragmentRole = 'detail' | 'header' | 'footer' | 'groupHeader' | 'groupFooter';

export interface Fragment {
  /** Content height of the fragment box, excluding `before`/`after` margins. */
  height: number;
  before: number;
  after: number;
  commands: DrawCommand[];
  breakBefore?: 'auto' | 'page' | 'avoid';
  breakAfter?: 'auto' | 'page' | 'avoid';
  /** Never let this fragment split across pages (single table row, keep-together block). */
  avoidSplit?: boolean;
  keepWithNext?: boolean;
  role?: FragmentRole;
  /** Groups fragments that repeat together, e.g. a table's header rows on each page. */
  groupKey?: string;
  /** A hard page break marker emitted by `pageBreak` blocks. */
  isPageBreak?: boolean;
  /** Restart `{PAGE}` numbering before this fragment (Jasper "reset page number"). */
  resetPageNumber?: boolean;
  /** Marks the first fragment of a group so pagination can honour group page breaks. */
  groupValue?: unknown;
  /** Heading metadata: drives PDF bookmarks and table-of-contents entries. */
  outline?: OutlineEntry;
  /** Destination name this fragment defines (any block can be an anchor target). */
  anchor?: string;
  /** Paint the whole fragment with this opacity (watermarks / background bands). */
  opacity?: number;
}

/** Box geometry a fragment is painted into; used by borders and backgrounds. */
export interface PaintBox {
  fill?: ColorInput;
  border?: { width: number; color: RGB; style: 'solid' | 'dashed' | 'dotted' };
}

export function fillRect(fill: ColorInput | undefined, w: number, h: number): DrawCommand[] {
  if (!fill) return [];
  return [{ op: 'fillRect', x: 0, y: 0, w, h, color: toRGB(fill) }];
}

/**
 * Shift a fragment's draw commands by (dx, dy). Layout emits everything in
 * fragment-local space; this is how a nested layout (a block inside a table
 * cell, or a cell nested in a merged grid) is placed without the writer
 * needing to know about nesting.
 */
export function translateCommands(commands: DrawCommand[], dx: number, dy: number): DrawCommand[] {
  if (dx === 0 && dy === 0) return commands;
  return commands.map((cmd): DrawCommand => {
    switch (cmd.op) {
      case 'fillRect':
      case 'strokeRect':
      case 'image':
        return { ...cmd, x: cmd.x + dx, y: cmd.y + dy };
      case 'line':
        return { ...cmd, x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx, y2: cmd.y2 + dy };
      case 'underline':
        return { ...cmd, x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx };
      case 'poly':
        return { ...cmd, points: cmd.points.map(([x, y]) => [x + dx, y + dy] as PolyPoint) };
      case 'path':
        return {
          ...cmd,
          subpaths: cmd.subpaths.map((sp) => ({
            ...sp,
            points: sp.points.map(([x, y]) => [x + dx, y + dy] as PolyPoint),
          })),
        };
      case 'text':
        return { ...cmd, x: cmd.x + dx, baselineY: cmd.baselineY + dy };
    }
  });
}
