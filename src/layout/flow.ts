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

export type DrawCommand =
  | { op: 'fillRect'; x: number; y: number; w: number; h: number; color: RGB }
  | { op: 'strokeRect'; x: number; y: number; w: number; h: number; color: RGB; lineWidth: number; dash?: DashPattern }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: RGB; lineWidth: number; dash?: DashPattern }
  | { op: 'text'; x: number; baselineY: number; runs: PositionedRun[]; gapWidth: number; decorations: Decoration[] }
  | { op: 'underline'; x1: number; y1: number; x2: number; color: RGB; lineWidth: number; lineThrough?: boolean }
  | { op: 'image'; x: number; y: number; w: number; h: number; src: string | Uint8Array };

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
