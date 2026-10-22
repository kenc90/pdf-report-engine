/**
 * SVG (vector) → polygon soup.
 *
 * This module is deliberately layout- and pdfkit-free: it turns an SVG document
 * into a flat list of filled/stroked shapes whose outlines are already sampled to
 * polylines (bezier and elliptical-arc flattening happens here, so the writer only
 * ever sees line segments — the same approach the pie/donut charts already take).
 * `layout/svg.ts` then scales the user coordinate space into points and emits the
 * engine's `path` draw commands.
 *
 * Supported subset (enough for the vast majority of report icons, logos and
 * diagrams):
 *   Shapes   path (all commands incl. arcs), rect (rounded), circle, ellipse,
 *            line, polyline, polygon.
 *   Group    g / svg nesting with `transform`
 *            (translate / scale / rotate / matrix / skewX / skewY).
 *   Paint    fill, fill-opacity, fill-rule, stroke, stroke-width, stroke-opacity,
 *            stroke-dasharray, opacity — inherited down the tree, overridable via
 *            either presentation attributes or an inline `style` (style wins).
 *
 * Not modelled (rendered as best-effort): text, gradients/filters/clips/masks
 * (a gradient `fill="url(#…)"` falls back to a solid fill), and `<use>`.
 */
import { toRGB, type RGB } from './color.js';
import { loadImageBytes } from './image.js';

/** A point or curve already flattened to user-space line vertices. */
export interface SvgSubpath {
  points: number[][];
  closed: boolean;
}

export interface SvgShape {
  subpaths: SvgSubpath[];
  /** Absent when the shape is not painted (`fill="none"`). */
  fill?: { color: RGB; opacity: number; rule: 'nonzero' | 'evenodd' };
  stroke?: { color: RGB; width: number; opacity: number; dash?: number[] };
}

export interface SvgTree {
  shapes: SvgShape[];
  /** Intrinsic size in the SVG's own user units (viewBox width/height, or the */
  /** `width`/`height` attributes when there is no viewBox). */
  width: number;
  height: number;
}

// --- source sniffing -------------------------------------------------------

function base64ToBytes(body: string): Uint8Array {
  const g = globalThis as { Buffer?: { from: (s: string, e: string) => ArrayLike<number> }; atob?: (s: string) => string };
  if (typeof g.Buffer?.from === 'function') return new Uint8Array(g.Buffer.from(body, 'base64'));
  if (typeof g.atob === 'function') {
    const bin = g.atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error('no base64 decoder available (need Buffer or atob)');
}

function bytesToText(bytes: Uint8Array): string {
  const TD = (globalThis as { TextDecoder?: new (label?: string) => { decode(b: Uint8Array): string } }).TextDecoder;
  if (TD) return new TD('utf-8').decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Resolve an SVG source to its markup text, or `null` when the source is not an
 * SVG. Accepts inline `<svg>` text, a `data:image/svg+xml` URI (base64 or
 * percent-encoded), raw bytes, or a filesystem path readable through the injected
 * reader. Remote `http(s)` URLs are not fetched here (see `remote-image.ts`, which
 * rewrites them to bytes before layout).
 */
export function svgSourceToText(src: string | Uint8Array): string | null {
  const fromText = (text: string): string | null => (/<svg[\s>]/i.test(text) ? text : null);

  if (typeof src !== 'string') {
    if (src.length < 4) return null;
    const head = bytesToText(src.subarray(0, Math.min(src.length, 512))).toLowerCase();
    // Binary (PNG/JPEG/…) headers — not SVG.
    if (head.charCodeAt(0) === 0xff || /<svg/.test(head)) return fromText(bytesToText(src));
    return null;
  }

  const trimmed = src.trimStart();
  if (trimmed.startsWith('data:')) {
    const comma = trimmed.indexOf(',');
    if (comma < 0) return null;
    const meta = trimmed.slice(0, comma).toLowerCase();
    const body = trimmed.slice(comma + 1);
    try {
      if (/;base64/i.test(meta)) return fromText(bytesToText(base64ToBytes(body.replace(/\s+/g, ''))));
      return fromText(decodeURIComponent(body));
    } catch {
      return null;
    }
  }
  // Inline markup wins before we try to treat it as a path.
  if (/<svg[\s>]/i.test(trimmed)) return trimmed;
  const bytes = loadImageBytes(src);
  return bytes ? fromText(bytesToText(bytes)) : null;
}

// --- element model + mini parser -------------------------------------------

interface SvgNode {
  tag: string;
  attrs: Record<string, string>;
  children: SvgNode[];
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[m[1]!.toLowerCase()] = value.replace(/&(amp|lt|gt|quot|apos);/g, (_, k: string) =>
      k === 'amp' ? '&' : k === 'lt' ? '<' : k === 'gt' ? '>' : k === 'quot' ? '"' : "'");
  }
  return attrs;
}

/** Parse SVG markup into a node tree, discarding everything outside `<svg>`. */
function parseSvgDom(xml: string): SvgNode[] {
  const cleaned = xml
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!doctype[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');
  const root: SvgNode = { tag: '#root', attrs: {}, children: [] };
  const stack: SvgNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const re = /<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1] !== undefined) {
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const tag = m[2]!.toLowerCase();
    const node: SvgNode = { tag, attrs: parseAttrs(m[3] ?? ''), children: [] };
    top().children.push(node);
    if (m[4] !== '/') stack.push(node);
  }
  return root.children;
}

// --- transforms ------------------------------------------------------------

type Mat = [number, number, number, number, number, number]; // a b c d e f
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMat(m: Mat, x: number, y: number): number[] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const RAD = Math.PI / 180;

/** Multiply out a `transform` attribute (whitespace/comma separated functions). */
function parseTransform(str: string | undefined): Mat {
  if (!str) return IDENTITY;
  let m: Mat = IDENTITY;
  const fn = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/gi;
  let t: RegExpExecArray | null;
  while ((t = fn.exec(str)) !== null) {
    const name = t[1]!.toLowerCase();
    const args = numList(t[2] ?? '');
    let step: Mat = IDENTITY;
    switch (name) {
      case 'translate':
        step = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? args[0] ?? 0];
        break;
      case 'scale':
        step = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const a = (args[0] ?? 0) * RAD;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        step = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          const cx = args[1]!;
          const cy = args[2]!;
          step = mul([1, 0, 0, 1, cx, cy], mul(step, [1, 0, 0, 1, -cx, -cy]));
        }
        break;
      }
      case 'matrix':
        if (args.length >= 6) step = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
        break;
      case 'skewx':
        step = [1, 0, Math.tan((args[0] ?? 0) * RAD), 1, 0, 0];
        break;
      case 'skewy':
        step = [1, Math.tan((args[0] ?? 0) * RAD), 0, 1, 0, 0];
        break;
    }
    m = mul(m, step);
  }
  return m;
}

/** Average scale factor of a matrix — used to scale stroke widths and dashes. */
function scaleFactor(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

// --- number helpers --------------------------------------------------------

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

function numList(s: string): number[] {
  NUM.lastIndex = 0;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = NUM.exec(s)) !== null) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function numAttr(el: SvgNode, name: string, fallback = 0): number {
  const raw = el.attrs[name];
  if (raw === undefined) return fallback;
  const n = numList(raw)[0];
  return n === undefined ? fallback : n;
}

// --- paint resolution ------------------------------------------------------

interface Paint {
  fill?: string;
  fillOpacity: number;
  fillRule: 'nonzero' | 'evenodd';
  stroke?: string;
  strokeWidth: number;
  strokeOpacity: number;
  dash?: number[];
  /** Inherited group opacity, folded into each shape's fill/stroke opacity. */
  opacity: number;
}

const BASE_PAINT: Paint = { fillOpacity: 1, fillRule: 'nonzero', strokeWidth: 1, strokeOpacity: 1, opacity: 1 };

function styleDecls(style: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!style) return map;
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    map[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return map;
}

/** Presentation attributes overridden by the inline `style` attribute. */
function ownProps(el: SvgNode): Record<string, string> {
  const props = { ...el.attrs, ...styleDecls(el.attrs['style']) };
  return props;
}

function resolvePaint(parent: Paint, el: SvgNode): Paint {
  const p = ownProps(el);
  const out: Paint = { ...parent };
  if (p['fill'] !== undefined) out.fill = p['fill'].trim();
  if (p['fill-rule'] === 'evenodd') out.fillRule = 'evenodd';
  else if (p['fill-rule'] === 'nonzero') out.fillRule = 'nonzero';
  if (p['stroke'] !== undefined) out.stroke = p['stroke'].trim();
  if (p['stroke-width'] !== undefined) {
    const w = numList(p['stroke-width'])[0];
    if (w !== undefined && w > 0) out.strokeWidth = w;
  }
  const op = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
  };
  const fo = op(p['fill-opacity']);
  if (fo !== undefined) out.fillOpacity = fo;
  const so = op(p['stroke-opacity']);
  if (so !== undefined) out.strokeOpacity = so;
  const o = op(p['opacity']);
  if (o !== undefined) out.opacity = o;
  if (p['stroke-dasharray'] !== undefined) {
    const d = p['stroke-dasharray'].trim();
    out.dash = d === 'none' ? undefined : numList(d).filter((n) => n > 0);
  }
  return out;
}

/** A colour token → RGB; `none`/empty/`url(...)` that cannot resolve → `undefined`. */
function paintColor(token: string | undefined): RGB | undefined {
  if (token === undefined) return undefined;
  const v = token.trim();
  if (!v || v === 'none') return undefined;
  if (v.startsWith('url(')) return undefined; // gradient/pattern reference
  if (v.startsWith('#') || /^[a-z]/i.test(v) || /^rgb/i.test(v)) {
    try {
      return toRGB(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const FALLBACK_BLACK: RGB = [0, 0, 0];

function finalizeShape(subpaths: SvgSubpath[], paint: Paint, geomScale: number): SvgShape | undefined {
  if (subpaths.length === 0) return undefined;
  const shape: SvgShape = { subpaths };
  // Absent `fill` inherits (defaulting to black at the root); `fill="none"` opts out.
  // A gradient/pattern `url(#…)` we cannot model falls back to a solid fill so the
  // shape still renders rather than vanishing.
  if (paint.fill !== 'none') {
    const token = paint.fill ?? 'black';
    const rgb = paintColor(token);
    const color = rgb ?? (/^(url\()/.test(token.trim()) || /^[a-z#]/i.test(token.trim()) ? FALLBACK_BLACK : undefined);
    if (color) shape.fill = { color, opacity: paint.fillOpacity * paint.opacity, rule: paint.fillRule };
  }
  const strokeColor = paint.stroke && paint.stroke !== 'none' ? paintColor(paint.stroke) : undefined;
  if (strokeColor && paint.strokeWidth > 0) {
    // Stroke width is authored in the element's local space; scale it into the
    // viewBox space so a transformed group's outlines thicken like their geometry.
    shape.stroke = { color: strokeColor, width: paint.strokeWidth * geomScale, opacity: paint.strokeOpacity * paint.opacity, dash: paint.dash?.map((d) => d * geomScale) };
  }
  if (!shape.fill && !shape.stroke) return undefined;
  return shape;
}

// --- geometry builders (user coords; flattening happens here) --------------

function mapRing(m: Mat, pts: number[][]): number[][] {
  return pts.map((p) => applyMat(m, p[0]!, p[1]!));
}

function circleRing(cx: number, cy: number, rx: number, ry: number): number[][] {
  const sweep = Math.PI * 2;
  const steps = Math.max(8, Math.ceil(sweep / (Math.PI / 36)));
  const pts: number[][] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (sweep * i) / steps;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

function flattenCubic(p0: number[], p1: number[], p2: number[], p3: number[]): number[][] {
  const len = Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!) + Math.hypot(p2[0]! - p1[0]!, p2[1]! - p1[1]!) + Math.hypot(p3[0]! - p2[0]!, p3[1]! - p2[1]!);
  const steps = Math.max(4, Math.min(64, Math.round(len / 2)));
  const out: number[][] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    out.push([
      a * p0[0]! + b * p1[0]! + c * p2[0]! + d * p3[0]!,
      a * p0[1]! + b * p1[1]! + c * p2[1]! + d * p3[1]!,
    ]);
  }
  return out;
}

function quadToCubic(p0: number[], q: number[], p3: number[]): [number[], number[]] {
  const c1 = [p0[0]! + (2 / 3) * (q[0]! - p0[0]!), p0[1]! + (2 / 3) * (q[1]! - p0[1]!)];
  const c2 = [p3[0]! + (2 / 3) * (q[0]! - p3[0]!), p3[1]! + (2 / 3) * (q[1]! - p3[1]!)];
  return [c1, c2];
}

/** SVG elliptical arc (endpoint parameterisation) sampled to a polyline. */
function arcToPolyline(x1: number, y1: number, rxIn: number, ryIn: number, angleDeg: number, largeArc: number, sweep: number, x2: number, y2: number): number[][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = angleDeg * RAD;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweep === 0 && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep === 1 && dtheta < 0) dtheta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(dtheta) / (Math.PI / 36)));
  const out: number[][] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = theta1 + (dtheta * i) / steps;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cosPhi * ex - sinPhi * ey + cx, sinPhi * ex + cosPhi * ey + cy]);
  }
  out[out.length - 1] = [x2, y2];
  return out;
}

/** Parse a `path` `d` attribute into flattened subpaths (user coords). */
export function parsePathData(d: string): SvgSubpath[] {
  NUM.lastIndex = 0;
  const tokens: Array<string | number> = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    if (/^[a-zA-Z]$/.test(m[0])) tokens.push(m[0]);
    else {
      const n = Number(m[0]);
      if (Number.isFinite(n)) tokens.push(n);
    }
  }

  const subpaths: SvgSubpath[] = [];
  let cur: number[][] = [];
  let start: number[] = [0, 0];
  let cx = 0;
  let cy = 0;
  let prevCtrl: number[] | null = null;
  let prevQuad: number[] | null = null;
  let prevCmd = '';
  let i = 0;

  const flush = (closed: boolean): void => {
    if (cur.length >= 2) subpaths.push({ points: cur, closed });
    cur = [];
  };
  const nextNum = (): number => {
    const v = tokens[i++];
    return typeof v === 'number' ? v : 0;
  };
  const move = (x: number, y: number): void => {
    flush(false);
    start = [x, y];
    cur = [[x, y]];
    cx = x;
    cy = y;
    prevCtrl = null;
    prevQuad = null;
  };
  const line = (x: number, y: number): void => {
    cur.push([x, y]);
    cx = x;
    cy = y;
    prevCtrl = null;
    prevQuad = null;
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    cur.push(...flattenCubic([cx, cy], [x1, y1], [x2, y2], [x, y]));
    prevCtrl = [x2, y2];
    prevQuad = null;
    cx = x;
    cy = y;
  };
  const quad = (x1: number, y1: number, x: number, y: number): void => {
    const [c1, c2] = quadToCubic([cx, cy], [x1, y1], [x, y]);
    cur.push(...flattenCubic([cx, cy], c1, c2, [x, y]));
    prevQuad = [x1, y1];
    prevCtrl = null;
    cx = x;
    cy = y;
  };

  while (i < tokens.length) {
    let cmd: string;
    if (typeof tokens[i] === 'string') cmd = tokens[i++] as string;
    else cmd = prevCmd; // implicit repetition
    const rel = cmd >= 'a' && cmd <= 'z';
    const up = cmd.toUpperCase();
    if (up === 'Z') {
      if (cur.length >= 2) {
        cur.push([start[0]!, start[1]!]);
        subpaths.push({ points: cur, closed: true });
        cur = [];
      }
      cx = start[0]!;
      cy = start[1]!;
      prevCmd = cmd;
      continue;
    }
    switch (up) {
      case 'M': {
        const x = nextNum() + (rel ? cx : 0);
        const y = nextNum() + (rel ? cy : 0);
        move(x, y);
        // Subsequent coordinate pairs are implicit linetos.
        while (i < tokens.length && typeof tokens[i] === 'number') line(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        break;
      }
      case 'L': {
        line(nextNum() + (rel ? cx : 0), nextNum() + (rel ? cy : 0));
        break;
      }
      case 'H':
        line(nextNum() + (rel ? cx : 0), cy);
        break;
      case 'V':
        line(cx, nextNum() + (rel ? cy : 0));
        break;
      case 'C': {
        const o = rel ? [cx, cy] : [0, 0];
        cubic(nextNum() + o[0]!, nextNum() + o[1]!, nextNum() + o[0]!, nextNum() + o[1]!, nextNum() + o[0]!, nextNum() + o[1]!);
        break;
      }
      case 'S': {
        const o = rel ? [cx, cy] : [0, 0];
        // Reflect the previous cubic control point only when the last command
        // was a cubic; otherwise the first control point coincides with current.
        const c1 = prevCtrl ?? [cx, cy];
        const refl = [2 * cx - c1[0]!, 2 * cy - c1[1]!];
        cubic(refl[0]!, refl[1]!, nextNum() + o[0]!, nextNum() + o[1]!, nextNum() + o[0]!, nextNum() + o[1]!);
        break;
      }
      case 'Q': {
        const o = rel ? [cx, cy] : [0, 0];
        quad(nextNum() + o[0]!, nextNum() + o[1]!, nextNum() + o[0]!, nextNum() + o[1]!);
        break;
      }
      case 'T': {
        const o = rel ? [cx, cy] : [0, 0];
        const q = prevQuad ?? [cx, cy];
        quad(2 * cx - q[0]!, 2 * cy - q[1]!, nextNum() + o[0]!, nextNum() + o[1]!);
        break;
      }
      case 'A': {
        const rx = nextNum();
        const ry = nextNum();
        const rot = nextNum();
        const la = nextNum();
        const sw = nextNum();
        const x = nextNum() + (rel ? cx : 0);
        const y = nextNum() + (rel ? cy : 0);
        cur.push(...arcToPolyline(cx, cy, rx, ry, rot, la ? 1 : 0, sw ? 1 : 0, x, y));
        cx = x;
        cy = y;
        prevCtrl = null;
        prevQuad = null;
        break;
      }
      default:
        i += 1; // unknown token; skip defensively
    }
    prevCmd = cmd;
  }
  flush(false);
  return subpaths;
}

function rectSubpaths(el: SvgNode): SvgSubpath[] {
  const x = numAttr(el, 'x');
  const y = numAttr(el, 'y');
  const w = numAttr(el, 'width');
  const h = numAttr(el, 'height');
  if (w <= 0 || h <= 0) return [];
  let rx = numAttr(el, 'rx');
  let ry = numAttr(el, 'ry');
  if (rx === 0 && ry > 0) rx = ry;
  if (ry === 0 && rx > 0) ry = rx;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx <= 0) return [{ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
  // Rounded corners: four straight edges joined by quarter-ellipse arcs.
  const k = 0.5522847498; // cubic approximation of a quarter arc
  const pts: number[][] = [];
  const corner = (ccx: number, ccy: number, sx: number, sy: number): void => {
    const p0 = [ccx, ccy + sy * -ry];
    const p3 = [ccx + sx * -rx, ccy];
    const c1 = [ccx, ccy + sy * -ry * (1 - k)];
    const c2 = [ccx + sx * rx * (1 - k), ccy];
    pts.push(...flattenCubic(p0, c1, c2, p3));
  };
  pts.push([x + rx, y]);
  pts.push([x + w - rx, y]);
  corner(x + w - rx, y + ry, 1, -1);
  pts.push([x + w, y + ry]);
  pts.push([x + w, y + h - ry]);
  corner(x + w - rx, y + h - ry, 1, 1);
  pts.push([x + w - rx, y + h]);
  pts.push([x + rx, y + h]);
  corner(x + rx, y + h - ry, -1, 1);
  pts.push([x, y + h - ry]);
  pts.push([x, y + ry]);
  corner(x + rx, y + ry, -1, -1);
  pts.push([x + rx, y]);
  return [{ points: pts, closed: true }];
}

function pointsToSubpath(raw: string, closed: boolean): SvgSubpath[] {
  const nums = numList(raw);
  const pts: number[][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  if (pts.length < 2) return [];
  return [{ points: pts, closed }];
}

function shapeSubpaths(el: SvgNode, tag: string): SvgSubpath[] {
  switch (tag) {
    case 'path': {
      const d = el.attrs['d'];
      return d ? parsePathData(d) : [];
    }
    case 'rect':
      return rectSubpaths(el);
    case 'circle': {
      const r = numAttr(el, 'r');
      if (r <= 0) return [];
      return [{ points: circleRing(numAttr(el, 'cx'), numAttr(el, 'cy'), r, r), closed: true }];
    }
    case 'ellipse': {
      const rx = numAttr(el, 'rx');
      const ry = numAttr(el, 'ry');
      if (rx <= 0 || ry <= 0) return [];
      return [{ points: circleRing(numAttr(el, 'cx'), numAttr(el, 'cy'), rx, ry), closed: true }];
    }
    case 'line': {
      const pts = [
        [numAttr(el, 'x1'), numAttr(el, 'y1')],
        [numAttr(el, 'x2'), numAttr(el, 'y2')],
      ];
      return [{ points: pts, closed: false }];
    }
    case 'polyline':
      return pointsToSubpath(el.attrs['points'] ?? '', false);
    case 'polygon':
      return pointsToSubpath(el.attrs['points'] ?? '', true);
    default:
      return [];
  }
}

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

// --- traversal -------------------------------------------------------------

function walk(node: SvgNode, ctm: Mat, paint: Paint, out: SvgShape[]): void {
  const own = node.tag === 'svg' || node.tag === 'g' || node.tag === 'switch' || node.tag === 'a';
  if (!own && !SHAPE_TAGS.has(node.tag)) return;
  const localTransform = parseTransform(node.attrs['transform']);
  const m = mul(ctm, localTransform);
  const childPaint = node.tag === '#root' ? paint : resolvePaint(paint, node);
  if (SHAPE_TAGS.has(node.tag)) {
    const raw = shapeSubpaths(node, node.tag);
    if (raw.length) {
      const mapped = raw.map((sp) => ({ points: mapRing(m, sp.points), closed: sp.closed }));
      const shape = finalizeShape(mapped, childPaint, scaleFactor(m));
      if (shape) out.push(shape);
    }
    return;
  }
  for (const child of node.children) walk(child, m, childPaint, out);
}

// --- public entry points ---------------------------------------------------

function viewBoxOf(text: string): { x: number; y: number; w: number; h: number } | null {
  const open = /<svg\b[^>]*>/i.exec(text);
  if (!open) return null;
  const attrs = parseAttrs(open[0].slice(4, -1));
  const vb = attrs['viewbox'];
  if (vb) {
    const n = numList(vb);
    if (n.length >= 4 && n[2]! > 0 && n[3]! > 0) return { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
  }
  const w = numList(attrs['width'] ?? '')[0];
  const h = numList(attrs['height'] ?? '')[0];
  if (w !== undefined && h !== undefined && w > 0 && h > 0) return { x: 0, y: 0, w, h };
  return null;
}

/** Intrinsic pixel size of the SVG (viewBox or `width`/`height`), or `null`. */
export function svgIntrinsicSize(text: string): { width: number; height: number } | null {
  const vb = viewBoxOf(text);
  return vb ? { width: vb.w, height: vb.h } : null;
}

/**
 * Parse SVG markup into flattened, styled shapes in viewBox coordinate space
 * (origin-shifted so the drawing sits at 0,0). Returns `null` when the input is
 * not an SVG or has no drawable geometry.
 */
export function parseSvg(text: string): SvgTree | null {
  if (!/<svg[\s>]/i.test(text)) return null;
  const vb = viewBoxOf(text);
  const dom = parseSvgDom(text);
  const shapes: SvgShape[] = [];
  // A viewBox offset translates all user coords so the drawing sits at origin.
  const base: Mat = vb ? [1, 0, 0, 1, -vb.x, -vb.y] : IDENTITY;
  for (const node of dom) walk(node, base, BASE_PAINT, shapes);
  if (shapes.length === 0) return null;
  const width = vb?.w ?? 100;
  const height = vb?.h ?? 100;
  return { shapes, width, height };
}
