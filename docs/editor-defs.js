// Support module for the online report editor (editor.html / editor.js).
//
// Everything the editor needs that is not UI wiring lives here:
//   - a small HTML parser / pretty serializer round-trip that powers the
//     element model behind the properties panel (deliberately tolerant: the
//     editor works on partially typed markup, and the engine's own adapter is
//     the authority on what is ultimately valid),
//   - source-offset mapping between textarea caret positions and tree elements
//     (serialization records the ranges in the same pass, so they cannot drift),
//   - the HTML/CSS syntax highlighter (same overlay technique as the demo),
//   - the block palette and the property schemas (checked against the
//     supported CSS subset and data-* attributes in src/adapter/html.ts).

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Tags the engine's adapter treats as void (self-closing). */
export const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'source']);

/** Tags that render as blocks in the pretty serializer (everything else is inline). */
export const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'colgroup', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);

/** Tags whose inner content is kept verbatim. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'pre']);

const ATTR_RE = /([A-Za-z_:][-.:\w]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

function decodeEnt(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function attrsToStr(attrs) {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    out += v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`;
  }
  return out;
}

/**
 * Tokenize `src` into a loose element/text tree. Never throws; unclosed tags
 * are repaired by implicit nesting (an end tag pops until it matches).
 * Element nodes: {type:'element', tag, attrs, children, selfClosed}.
 * Text nodes:    {type:'text', text}. Comments: {type:'comment', text}.
 */
export function parseHtml(src) {
  const root = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      const stop = end === -1 ? src.length : end + 3;
      stack[stack.length - 1].children.push({ type: 'comment', text: src.slice(lt, stop) });
      i = stop;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][-.:\w]*)([\s\S]*?)(\/?)>/.exec(src.slice(lt));
    if (!m) { // a stray `<` or an unterminated tag (mid-typing) — keep as text;
      // the `<` plus the leftover chars re-serialize verbatim, so the model
      // round-trips half-typed markup without rewriting it
      pushText('<');
      i = lt + 1;
      continue;
    }
    const [full, closing, nameRaw, attrSrc, selfClose] = m;
    const name = nameRaw.toLowerCase();
    if (closing) {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
    } else {
      const attrs = {};
      if (attrSrc) {
        ATTR_RE.lastIndex = 0;
        let a;
        while ((a = ATTR_RE.exec(attrSrc)) !== null) {
          attrs[a[1]] = decodeEnt(a[2] ?? a[3] ?? a[4] ?? '');
        }
      }
      const el = { type: 'element', tag: name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (VOID_TAGS.has(name)) {
        el.selfClosed = selfClose === '/' ? 'xml' : 'void';
      } else if (selfClose === '/') {
        el.selfClosed = 'xml';
      } else if (RAW_TEXT_TAGS.has(name)) {
        const closeRe = new RegExp('</' + name + '\\s*>', 'i');
        const rest = src.slice(lt + full.length);
        const cm = closeRe.exec(rest);
        const body = cm ? rest.slice(0, cm.index) : rest;
        if (body) el.children.push({ type: 'raw', text: body });
        i = lt + full.length + (cm ? cm.index + cm[0].length : body.length);
        continue;
      } else {
        stack.push(el);
      }
    }
    i = lt + full.length;
  }
  return root;

  function pushText(text) {
    // Store the logical (entity-decoded) text; the serializer escapes it once,
    // so `a &amp; b` round-trips instead of compounding to `&amp;amp;`.
    if (text) stack[stack.length - 1].children.push({ type: 'text', text: decodeEnt(text) });
  }
}

// ---------------------------------------------------------------------------
// Pretty serialization + source-offset mapping
// ---------------------------------------------------------------------------
// One core walk formats the tree with two spaces per block level *and*
// (optionally) records, per element path, the range of its open tag.
//
// Every piece of output — pads, newlines, text, tags — is appended into a
// single buffer, so an element's open-tag range is always exactly the buffer
// length at the moment the tag goes in. Recording offsets this way cannot drift
// relative to the produced string (no post-hoc position arithmetic).

function openTag(el) {
  const self = el.selfClosed === 'xml' ? ' /' : '';
  return `<${el.tag}${attrsToStr(el.attrs)}${self}>`;
}

/**
 * Does this node contribute any output? Checked before a pad/newline is emitted
 * so indentation is appended *ahead of* its child (never spliced in after, which
 * would invalidate offsets already recorded for that child's subtree).
 * Element nodes always emit — an empty `<div></div>` is meaningful (the palette
 * inserts attribute-only chart / barcode / band blocks) — so only blank text and
 * empty raw/comment payloads are skipped.
 */
function emitsOutput(node) {
  if (node.type === 'text') return !/^[\s\u00a0\u2028\u2029]*$/.test(node.text);
  if (node.type === 'comment' || node.type === 'raw') return node.text !== '';
  return node.type === 'element';
}

/**
 * Append `node` (formatted at `level`) to `sink.buf`.
 * `sink = { buf, map: Map | null }`; when `map` is present, each element path's
 * open-tag range is recorded into it. Every byte is written left-to-right, so a
 * recorded start is the true index of the open tag in the final string.
 */
function walkSerialize(node, level, path, sink) {
  if (node.type === 'text') {
    if (!emitsOutput(node)) return;
    const lead = /^\s/.test(node.text);
    const trail = /[\s\u2028\u2029]$/.test(node.text);
    let s = escapeText(node.text.replace(/[\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim());
    if (lead) s = ' ' + s;
    if (trail) s += ' ';
    sink.buf += s;
    return;
  }
  if (node.type === 'comment' || node.type === 'raw') {
    sink.buf += node.text;
    return;
  }
  if (node.type !== 'element') return;
  const open = openTag(node);
  const rec = { start: sink.buf.length, end: sink.buf.length + open.length };
  if (sink.map) sink.map.set(path.join(','), rec);
  sink.buf += open;
  if (VOID_TAGS.has(node.tag) || node.selfClosed === 'xml') { rec.fullEnd = sink.buf.length; return; }
  if (RAW_TEXT_TAGS.has(node.tag)) {
    sink.buf += node.children.map((c) => c.text ?? '').join('') + `</${node.tag}>`;
    rec.fullEnd = sink.buf.length;
    return;
  }
  const hasBlock = node.children.some((c) => c.type === 'element' && BLOCK_TAGS.has(c.tag));
  const pad = '\n' + '  '.repeat(level + 1);
  for (let k = 0; k < node.children.length; k += 1) {
    const child = node.children[k];
    const block = hasBlock && child.type === 'element' && BLOCK_TAGS.has(child.tag);
    if (block) {
      if (!emitsOutput(child)) continue;
      sink.buf += pad;
    }
    walkSerialize(child, level + 1, [...path, k], sink);
  }
  if (hasBlock) sink.buf += '\n' + '  '.repeat(level);
  sink.buf += `</${node.tag}>`;
  rec.fullEnd = sink.buf.length;
}

function walkRoot(root, sink) {
  for (let k = 0; k < root.children.length; k += 1) {
    const child = root.children[k];
    if (!emitsOutput(child)) continue;
    if (sink.buf.length > 0) sink.buf += '\n'; // top-level blocks start on a new line
    walkSerialize(child, 0, [k], sink);
  }
}

/** Pretty-print the tree root (2-space indent per block level). */
export function serializeHtml(root) {
  const sink = { buf: '', map: null };
  walkRoot(root, sink);
  return sink.buf;
}

/** Serialize and, in the same pass, record each element path's open-tag range. */
export function serializeWithOffsets(root) {
  const map = new Map();
  const sink = { buf: '', map };
  walkRoot(root, sink);
  return { src: sink.buf, offsets: { map } };
}

/** Compact plain serialization (for duplicate detection / canonical compare). */
export function plainSerialize(node) {
  if (node.type === 'text') return escapeText(node.text.replace(/\s+/g, ' ').trim());
  if (node.type === 'comment') return node.text;
  if (node.type !== 'element') return '';
  const open = openTag(node);
  if (VOID_TAGS.has(node.tag) || node.selfClosed === 'xml') return open + '>';
  if (RAW_TEXT_TAGS.has(node.tag)) return open + node.children.map((c) => c.text ?? '').join('') + `</${node.tag}>`;
  return open + node.children.map(plainSerialize).join('') + `</${node.tag}>`;
}

/**
 * Element that *contains* `offset`: its open tag holds the caret, or the caret
 * sits in the element's body (after its open tag, before anything that follows
 * it in source order). Depth wins over position so a caret between two
 * siblings resolves to their parent, not the element after it.
 */
export function enclosingElement(offsets, offset) {
  let tagBest = null;
  let bodyBest = null;
  for (const [key, range] of offsets.map) {
    const depth = key.split(',').length;
    if (offset >= range.start && offset <= range.end) {
      if (!tagBest || depth >= tagBest.depth) tagBest = { path: key.split(',').map(Number), depth, ...range };
    } else if (offset > range.end) {
      if (!bodyBest || depth > bodyBest.depth || (depth === bodyBest.depth && range.start > bodyBest.start)) {
        bodyBest = { path: key.split(',').map(Number), depth, ...range };
      }
    }
  }
  return tagBest || bodyBest;
}

export function findNode(root, path) {
  let node = root;
  for (const idx of path) {
    node = node.children?.[idx];
    if (!node) return null;
  }
  return node;
}

/** Remove the element at `path` from `root`. */
export function removeNode(root, path) {
  if (!path.length) return;
  const parent = findNode(root, path.slice(0, -1));
  if (!parent) return;
  parent.children.splice(path[path.length - 1], 1);
}

/** 1-based index of the node among its parent's same-tag element children. */
export function typeOrdinal(root, path) {
  const parent = findNode(root, path.slice(0, -1));
  const node = findNode(root, path);
  if (!parent || !node) return 1;
  let n = 0;
  for (const child of parent.children) {
    if (child.type === 'element' && child.tag === node.tag) {
      n += 1;
      if (child === node) return n;
    }
  }
  return 1;
}

/**
 * Re-locate a node in a freshly parsed tree by signature: tag + ordinal among
 * same-tag element children (document order). Stable across edits that do not
 * add or remove siblings before the node.
 */
export function locateBySignature(root, sig) {
  let n = 0;
  let found = null;
  walk(root, []);
  return found;

  function walk(node, path) {
    if (found) return;
    for (let k = 0; k < (node.children || []).length; k += 1) {
      const child = node.children[k];
      if (child.type !== 'element') continue;
      if (child.tag === sig.tag) {
        n += 1;
        if (n === sig.ordinal) { found = [...path, k]; return; }
      }
      walk(child, [...path, k]);
      if (found) return;
    }
  }
}

/** Count how many elements with `tags` exist (for palette duplicate naming). */
export function countBlocks(root, tags) {
  let n = 0;
  const want = new Set(tags);
  (function walk(node) {
    for (const child of node.children || []) {
      if (child.type === 'element') {
        if (want.has(child.tag)) n += 1;
        walk(child);
      }
    }
  })(root);
  return n;
}

// ---------------------------------------------------------------------------
// Syntax highlighting (overlay under the transparent textarea)
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap = (cls, text) => `<span class="tok-${cls}">${esc(text)}</span>`;

function textTokens(raw) {
  let out = '';
  let last = 0;
  const re = /&[#A-Za-z0-9]{1,10};/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out += esc(raw.slice(last, m.index)) + wrap('entity', m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(raw.slice(last));
}

function lex(raw, rules, fallback) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const rest = raw.slice(i);
    let hit = null;
    for (const [re, cls] of rules) {
      const m = re.exec(rest);
      if (m && m[0].length) { hit = { text: m[0], cls }; break; }
    }
    if (!hit) hit = { text: rest[0], cls: fallback };
    out += hit.cls ? wrap(hit.cls, hit.text) : esc(hit.text);
    i += hit.text.length;
  }
  return out;
}

const ATTR_RULES = [
  [/^\s+/, null],
  [/^"[^"]*"?|^'[^']*'?/, 'string'],
  [/^[A-Za-z_:@][-.:\w@]*/, 'attr'],
  [/^[=/>]/, 'punct'],
];

function tagTokens(raw) {
  const closing = raw.startsWith('</');
  let out = wrap('punct', closing ? '</' : '<');
  let rest = raw.slice(closing ? 2 : 1);
  const name = /^[A-Za-z][-.:\w]*/.exec(rest);
  if (name) { out += wrap('tag', name[0]); rest = rest.slice(name[0].length); }
  const tail = /\/?>$/.exec(rest);
  if (tail) return out + lex(rest.slice(0, tail.index), ATTR_RULES, 'punct') + wrap('punct', tail[0]);
  return out + lex(rest, ATTR_RULES, 'punct');
}

function cssTokens(src) {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inValue = false;
  const emit = (cls, text) => { out += cls ? wrap(cls, text) : esc(text); i += text.length; };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest))) emit('comment', m[0]);
    else if ((m = /^"[^"]*"?|^'[^']*'?/.exec(rest))) emit('string', m[0]);
    else if ((m = /^\s+/.exec(rest))) emit(null, m[0]);
    else if ((m = /^@[-\w]+/.exec(rest))) emit('attr', m[0]);
    else if ((m = /^[{}]/.exec(rest))) { inBlock = m[0] === '{'; inValue = false; emit('punct', m[0]); }
    else if ((m = /^;/.exec(rest))) { inValue = false; emit('punct', m[0]); }
    else if ((m = /^:/.exec(rest))) { if (inBlock) inValue = true; emit('punct', m[0]); }
    else if (inBlock && inValue && (m = /^#[0-9a-fA-F]{3,8}\b|^[-+]?\d[\d.]*[a-z%]*|^[-\w]+/i.exec(rest))) emit('value', m[0]);
    else if ((m = /^[-\w]+/.exec(rest))) emit(inBlock ? 'prop' : 'selector', m[0]);
    else emit('punct', rest[0]);
  }
  return out;
}

export function highlightHtml(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) return out + textTokens(src.slice(i));
    out += textTokens(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      const stop = end === -1 ? src.length : end + 3;
      out += wrap('comment', src.slice(lt, stop));
      i = stop;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      const stop = end === -1 ? src.length : end + 1;
      out += wrap('meta', src.slice(lt, stop));
      i = stop;
      continue;
    }
    let j = lt + 1;
    let quote = '';
    while (j < src.length) {
      const c = src[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j += 1;
    }
    const stop = j >= src.length ? src.length : j + 1;
    const raw = src.slice(lt, stop);
    out += tagTokens(raw);
    i = stop;
    const name = /^<\/?\s*([A-Za-z][-.:\w]*)/.exec(raw)?.[1]?.toLowerCase();
    if (name === 'style' && !raw.startsWith('</')) {
      const offset = src.slice(i).toLowerCase().indexOf('</style');
      const bodyEnd = offset === -1 ? src.length : i + offset;
      out += cssTokens(src.slice(i, bodyEnd));
      i = bodyEnd;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property schemas (supported subset: src/adapter/html.ts)
// ---------------------------------------------------------------------------

export const STYLE_PROPS = [
  { prop: 'font-family', label: 'Font family', type: 'text', hint: 'Inter, Roboto Slab, …', group: 'Text' },
  { prop: 'font-size', label: 'Font size', type: 'text', hint: '10pt', group: 'Text' },
  { prop: 'font-weight', label: 'Font weight', type: 'select', options: ['', 'normal', 'bold', '400', '500', '600', '700', '900'], group: 'Text' },
  { prop: 'font-style', label: 'Font style', type: 'select', options: ['', 'italic'], group: 'Text' },
  { prop: 'color', label: 'Text color', type: 'color', group: 'Text' },
  { prop: 'line-height', label: 'Line height', type: 'text', hint: '1.5 (unitless)', group: 'Text' },
  { prop: 'letter-spacing', label: 'Letter spacing', type: 'text', hint: '1pt', group: 'Text' },
  { prop: 'text-align', label: 'Text align', type: 'select', options: ['', 'left', 'center', 'right', 'justify'], group: 'Text' },
  { prop: 'text-decoration', label: 'Text decoration', type: 'select', options: ['', 'underline', 'line-through'], group: 'Text' },
  { prop: 'text-transform', label: 'Text transform', type: 'select', options: ['', 'uppercase', 'lowercase', 'capitalize'], group: 'Text' },
  { prop: 'white-space', label: 'White space', type: 'select', options: ['', 'normal', 'nowrap', 'pre-wrap'], group: 'Text' },
  { prop: 'background', label: 'Background', type: 'text', hint: '#f3f6fb or linear-gradient(…)', group: 'Box' },
  { prop: 'opacity', label: 'Opacity', type: 'text', hint: '0…1', group: 'Box' },
  { prop: 'width', label: 'Width', type: 'text', hint: '100%, 52pt', group: 'Box' },
  { prop: 'height', label: 'Height', type: 'text', hint: '140pt', group: 'Box' },
  { prop: 'min-height', label: 'Min height', type: 'text', group: 'Box' },
  { prop: 'border', label: 'Border', type: 'text', hint: '1pt solid #dbe6f4', group: 'Box' },
  { prop: 'border-top', label: 'Border top', type: 'text', group: 'Box' },
  { prop: 'border-bottom', label: 'Border bottom', type: 'text', group: 'Box' },
  { prop: 'border-radius', label: 'Border radius', type: 'text', hint: '6pt', group: 'Box' },
  { prop: 'box-shadow', label: 'Box shadow', type: 'text', hint: '0 2pt 8pt rgba(0,0,0,.18)', group: 'Box' },
  { prop: 'padding', label: 'Padding', type: 'text', hint: '8pt', group: 'Box' },
  { prop: 'padding-top', label: 'Padding top', type: 'text', group: 'Box' },
  { prop: 'padding-right', label: 'Padding right', type: 'text', group: 'Box' },
  { prop: 'padding-bottom', label: 'Padding bottom', type: 'text', group: 'Box' },
  { prop: 'padding-left', label: 'Padding left', type: 'text', group: 'Box' },
  { prop: 'margin', label: 'Margin', type: 'text', hint: '8pt 0', group: 'Box' },
  { prop: 'margin-top', label: 'Margin top', type: 'text', group: 'Box' },
  { prop: 'margin-right', label: 'Margin right', type: 'text', group: 'Box' },
  { prop: 'margin-bottom', label: 'Margin bottom', type: 'text', group: 'Box' },
  { prop: 'margin-left', label: 'Margin left', type: 'text', group: 'Box' },
  { prop: 'vertical-align', label: 'Vertical align', type: 'select', options: ['', 'top', 'middle', 'bottom'], group: 'Box' },
  { prop: 'transform', label: 'Rotate', type: 'text', hint: 'rotate(-35deg)', group: 'Box' },
  { prop: 'position', label: 'Position', type: 'select', options: ['', 'absolute', 'fixed'], group: 'Box' },
  { prop: 'left', label: 'Left', type: 'text', hint: '24pt', group: 'Box' },
  { prop: 'top', label: 'Top', type: 'text', hint: '24pt', group: 'Box' },
  { prop: 'z-index', label: 'Z index', type: 'text', group: 'Box' },
  { prop: 'break-before', label: 'Break before', type: 'select', options: ['', 'page', 'avoid'], group: 'Pagination' },
  { prop: 'break-after', label: 'Break after', type: 'select', options: ['', 'page', 'avoid'], group: 'Pagination' },
  { prop: 'break-inside', label: 'Break inside', type: 'select', options: ['', 'avoid'], group: 'Pagination' },
  { prop: 'display', label: 'Display', type: 'select', options: ['', 'flex', 'inline-flex'], group: 'Flex' },
  { prop: 'flex-direction', label: 'Flex direction', type: 'select', options: ['', 'row', 'row-reverse', 'column', 'column-reverse'], group: 'Flex' },
  { prop: 'flex-wrap', label: 'Flex wrap', type: 'select', options: ['', 'nowrap', 'wrap', 'wrap-reverse'], group: 'Flex' },
  { prop: 'justify-content', label: 'Justify', type: 'select', options: ['', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'], group: 'Flex' },
  { prop: 'align-items', label: 'Align items', type: 'select', options: ['', 'flex-start', 'flex-end', 'center', 'stretch'], group: 'Flex' },
  { prop: 'gap', label: 'Gap', type: 'text', hint: '10pt', group: 'Flex' },
  { prop: 'flex', label: 'Flex (child)', type: 'text', hint: '1 1 48%', group: 'Flex' },
  { prop: 'align-self', label: 'Align self', type: 'select', options: ['', 'auto', 'flex-start', 'flex-end', 'center', 'stretch'], group: 'Flex' },
  { prop: 'column-count', label: 'Column count', type: 'text', group: 'Layout' },
  { prop: 'column-gap', label: 'Column gap', type: 'text', group: 'Layout' },
];

/** Attribute descriptors; `match(tag, attrs)` decides which selection shows them. */
export const ATTR_SCHEMAS = [
  { attr: 'id', label: 'id', type: 'text', match: () => true },
  { attr: 'class', label: 'class', type: 'text', match: () => true },
  { attr: 'href', label: 'href', type: 'text', match: (t) => t === 'a' || t === 'link' },
  { attr: 'src', label: 'src', type: 'text', match: (t) => t === 'img' },
  { attr: 'width', label: 'width', type: 'text', match: (t) => t === 'img' || t === 'svg' },
  { attr: 'height', label: 'height', type: 'text', match: (t) => t === 'img' || t === 'svg' },
  { attr: 'viewBox', label: 'viewBox', type: 'text', match: (t) => t === 'svg' },
  { attr: 'data-chart', label: 'Chart kind', type: 'select', options: ['bar', 'line', 'area', 'pie', 'donut', 'combo', 'waterfall', 'scatter', 'bubble', 'radar', 'gauge', 'heatmap', 'gantt'], match: (t, a) => 'data-chart' in a },
  { attr: 'data-title', label: 'Title', type: 'text', match: (t, a) => 'data-chart' in a || 'data-toc' in a || 'data-barcode' in a },
  { attr: 'data-categories', label: 'Categories', type: 'text', hint: 'comma-separated', match: (t, a) => 'data-chart' in a },
  { attr: 'data-values', label: 'Values', type: 'text', hint: 'comma-separated', match: (t, a) => 'data-chart' in a },
  { attr: 'data-series', label: 'Series', type: 'text', hint: 'Name:1,2,3; Name2:4,5,6', match: (t, a) => 'data-chart' in a },
  { attr: 'data-series-x', label: 'Series X', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-series-low', label: 'Series low', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-series-high', label: 'Series high', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-series-types', label: 'Series types', type: 'text', hint: 'bar,line', match: (t, a) => 'data-chart' in a },
  { attr: 'data-series-axes', label: 'Series axes', type: 'text', hint: 'left,right', match: (t, a) => 'data-chart' in a },
  { attr: 'data-colors', label: 'Colors', type: 'text', hint: '#0f2f57,#1b7f4b', match: (t, a) => 'data-chart' in a },
  { attr: 'data-legend', label: 'Legend', type: 'select', options: ['none', 'top', 'bottom', 'right'], match: (t, a) => 'data-chart' in a },
  { attr: 'data-show-values', label: 'Show values', type: 'bool', match: (t, a) => 'data-chart' in a },
  { attr: 'data-stacked', label: 'Stacked', type: 'select', options: ['', 'false', 'true', '100%'], match: (t, a) => 'data-chart' in a },
  { attr: 'data-range', label: 'Range bars', type: 'bool', match: (t, a) => 'data-chart' in a },
  { attr: 'data-min', label: 'Min', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-max', label: 'Max', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-ticks', label: 'Ticks', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-value-format', label: 'Value format', type: 'text', hint: '#,##0.0', match: (t, a) => 'data-chart' in a },
  { attr: 'data-inner-radius', label: 'Inner radius', type: 'text', hint: '0.6', match: (t, a) => 'data-chart' in a },
  { attr: 'data-reference-lines', label: 'Reference lines', type: 'text', hint: '250:SLO,color=#c00', match: (t, a) => 'data-chart' in a },
  { attr: 'data-heatmap-colors', label: 'Heatmap colors', type: 'text', hint: 'from=#eef4ff;to=#1e3a8a', match: (t, a) => 'data-chart' in a },
  { attr: 'data-waterfall-colors', label: 'Waterfall colors', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-totals', label: 'Totals (idx)', type: 'text', hint: '0,4', match: (t, a) => 'data-chart' in a },
  { attr: 'data-gauge-value', label: 'Gauge value', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-gauge-max', label: 'Gauge max', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-right-min', label: 'Right axis min', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-right-max', label: 'Right axis max', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-right-format', label: 'Right axis format', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-gantt-unit', label: 'Gantt unit', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-gantt-start', label: 'Gantt start', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-gantt-end', label: 'Gantt end', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-gantt-tasks', label: 'Gantt tasks', type: 'text', hint: 'name:start:end[:color[:progress[:deps]]]', match: (t, a) => 'data-chart' in a },
  { attr: 'data-x-format', label: 'X format', type: 'text', match: (t, a) => 'data-chart' in a },
  { attr: 'data-category-labels', label: 'Category labels', type: 'bool', match: (t, a) => 'data-chart' in a },
  { attr: 'data-axis-labels', label: 'Axis labels', type: 'bool', match: (t, a) => 'data-chart' in a },
  { attr: 'data-grid-lines', label: 'Grid lines', type: 'bool', match: (t, a) => 'data-chart' in a },
  { attr: 'data-barcode', label: 'Barcode kind', type: 'select', options: ['qr', 'code128', 'ean13'], match: (t, a) => 'data-barcode' in a },
  { attr: 'data-value', label: 'Value', type: 'text', match: (t, a) => 'data-barcode' in a },
  { attr: 'data-module-size', label: 'Module size', type: 'text', match: (t, a) => 'data-barcode' in a },
  { attr: 'data-quiet-zone', label: 'Quiet zone', type: 'text', match: (t, a) => 'data-barcode' in a },
  { attr: 'data-error-correction', label: 'Error correction', type: 'select', options: ['L', 'M', 'Q', 'H'], match: (t, a) => 'data-barcode' in a },
  { attr: 'data-show-text', label: 'Show text', type: 'bool', match: (t, a) => 'data-barcode' in a },
  { attr: 'data-toc', label: 'Table of contents', type: 'bool', match: (t, a) => 'data-toc' in a },
  { attr: 'data-level', label: 'Max heading level', type: 'text', match: (t, a) => 'data-toc' in a },
  { attr: 'data-band', label: 'Band', type: 'select', options: ['pageHeader', 'pageFooter', 'title', 'summary'], match: (t, a) => 'data-band' in a },
  { attr: 'data-each', label: 'Each (loop)', type: 'text', hint: 'line in $data.ledger', match: (t, a) => 'data-each' in a },
  { attr: 'data-bind', label: 'Bind (expr)', type: 'text', match: (t, a) => 'data-bind' in a },
  { attr: 'data-format', label: 'Format', type: 'text', hint: '#,##0.0', match: (t, a) => 'data-bind' in a },
  { attr: 'data-if', label: 'Render if', type: 'text', match: (t, a) => 'data-if' in a },
  { attr: 'data-when', label: 'Style when', type: 'text', match: (t, a) => 'data-when' in a },
  { attr: 'data-when-style', label: '…then style', type: 'text', match: (t, a) => 'data-when' in a },
  { attr: 'data-color-scale', label: 'Color scale', type: 'text', hint: 'from=#eef4ff; to=#1e3a8a', match: (t, a) => 'data-color-scale' in a },
  { attr: 'data-diagonal', label: 'Diagonal corner', type: 'text', match: (t, a) => 'data-diagonal' in a },
  { attr: 'data-diagonal-top', label: 'Diagonal top', type: 'text', match: (t, a) => 'data-diagonal' in a },
  { attr: 'data-diagonal-bottom', label: 'Diagonal bottom', type: 'text', match: (t, a) => 'data-diagonal' in a },
  { attr: 'data-grid', label: 'Grid', type: 'text', hint: '0.5pt solid #e5eaf1', match: (t, a) => 'data-grid' in a },
  { attr: 'data-striped', label: 'Striped rows', type: 'bool', match: (t, a) => 'data-striped' in a },
  { attr: 'colspan', label: 'colspan', type: 'text', match: (t) => t === 'td' || t === 'th' },
  { attr: 'rowspan', label: 'rowspan', type: 'text', match: (t) => t === 'td' || t === 'th' },
  { attr: 'data-watermark', label: 'Watermark text', type: 'text', match: (t, a) => 'data-watermark' in a },
  { attr: 'data-watermark-rotate', label: 'Rotation', type: 'text', match: (t, a) => 'data-watermark' in a },
  { attr: 'data-watermark-size', label: 'Size', type: 'text', match: (t, a) => 'data-watermark' in a },
  { attr: 'data-watermark-color', label: 'Color', type: 'color', match: (t, a) => 'data-watermark' in a },
  { attr: 'data-watermark-opacity', label: 'Opacity', type: 'text', match: (t, a) => 'data-watermark' in a },
  { attr: 'data-watermark-layer', label: 'Layer', type: 'select', options: ['background', 'foreground'], match: (t, a) => 'data-watermark' in a },
];

// ---------------------------------------------------------------------------
// Block palette
// ---------------------------------------------------------------------------

export const GROUPS = ['Text', 'Layout', 'Table', 'Chart', 'Image & Code', 'Navigation', 'Branding', 'Data'];

export const BLOCKS = [
  // --- Text ---------------------------------------------------------------
  { group: 'Text', name: 'Title (h1)', tags: ['h1'], snippet: '<h1>Report title</h1>' },
  { group: 'Text', name: 'Heading (h2)', tags: ['h2'], snippet: '<h2>Section heading</h2>' },
  { group: 'Text', name: 'Heading (h3)', tags: ['h3'], snippet: '<h3>Sub heading</h3>' },
  { group: 'Text', name: 'Paragraph', tags: ['p'], snippet: '<p>Body text. Inline styling with <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <mark>highlight</mark>, <a href="https://example.com">links</a> and <span style="color:#1b7f4b">coloured runs</span>.</p>' },
  { group: 'Text', name: 'Bulleted list', tags: ['ul'], snippet: '<ul>\n  <li>First point</li>\n  <li>Second point</li>\n  <li>Third point</li>\n</ul>' },
  { group: 'Text', name: 'Numbered list', tags: ['ol'], snippet: '<ol>\n  <li>Collect the data</li>\n  <li>Bind it to a table</li>\n  <li>Render the PDF</li>\n</ol>' },
  { group: 'Text', name: 'Blockquote', tags: ['blockquote'], snippet: '<blockquote>"A vector PDF, rendered without a browser."</blockquote>' },
  { group: 'Text', name: 'Code line', tags: ['code'], snippet: '<code style="background-color:#fbe9ec; color:#a3133a; padding:1pt 4pt">renderToBuffer(report)</code>' },
  { group: 'Text', name: 'Horizontal rule', tags: ['hr'], snippet: '<hr>' },
  { group: 'Text', name: 'Page break', tags: [], hint: 'pushes the next block to a new page', snippet: '<div style="break-before:page"></div>' },

  // --- Layout -------------------------------------------------------------
  { group: 'Layout', name: 'Section', tags: ['section'], snippet: '<section>\n  <h3>New section</h3>\n  <p>Content goes here.</p>\n</section>' },
  { group: 'Layout', name: 'Flex row', tags: [], hint: 'side-by-side children', snippet: '<div style="display:flex; gap:10pt; align-items:stretch">\n  <div style="flex:1 1 48%; background:#f3f6fb; padding:8pt">Left</div>\n  <div style="flex:1 1 48%; background:#f3f6fb; padding:8pt">Right</div>\n</div>' },
  { group: 'Layout', name: 'Flex column', tags: [], snippet: '<div style="display:flex; flex-direction:column; gap:8pt">\n  <div style="background:#f3f6fb; padding:8pt">First</div>\n  <div style="background:#f3f6fb; padding:8pt">Second</div>\n</div>' },
  { group: 'Layout', name: 'Multi-column', tags: [], hint: 'newspaper-style columns', snippet: '<div style="column-count:2; column-gap:16pt">\n  <p>First column text — the engine splits children into equal-width columns.</p>\n  <p>More paragraphs keep filling column by column.</p>\n</div>' },
  { group: 'Layout', name: 'Card box', tags: [], hint: 'rounded, shadowed', snippet: '<div style="background:#ffffff; border:1pt solid #dbe6f4; border-radius:8pt; box-shadow:0 2pt 8pt rgba(16,24,40,.12); padding:12pt; margin:8pt 0">\n  <p style="margin:0"><strong>Card.</strong> Rounded corners, soft shadow and gradient fills are still crisp vector output.</p>\n</div>' },
  { group: 'Layout', name: 'KPI cards', tags: [], hint: 'borderless table of stat cells', snippet: '<table style="border:0; width:100%">\n  <tr>\n    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#0f2f57">$72.1M</span><br><span style="font-size:8pt; text-transform:uppercase; color:#64748b">Revenue</span></td>\n    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#1b7f4b">+18.4%</span><br><span style="font-size:8pt; text-transform:uppercase; color:#64748b">YoY Growth</span></td>\n    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#b45309">$28.3M</span><br><span style="font-size:8pt; text-transform:uppercase; color:#64748b">Net Profit</span></td>\n  </tr>\n</table>' },
  { group: 'Layout', name: 'Callout', tags: [], snippet: '<p style="background:#fff7e6; border-left:3pt solid #e08a1e; padding:6pt 8pt"><strong>Note.</strong> Emphasis that keeps the reader on track.</p>' },

  // --- Table --------------------------------------------------------------
  { group: 'Table', name: 'Simple table', tags: ['table'], snippet: '<table data-grid="0.5pt solid #e5eaf1">\n  <thead>\n    <tr style="background:#0f2f57; color:#ffffff">\n      <th style="padding:5pt">Name</th><th style="padding:5pt">Region</th><th style="padding:5pt; text-align:right">Revenue</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr><td style="padding:4pt">Northwind</td><td style="padding:4pt">EMEA</td><td style="padding:4pt; text-align:right">$1,284,000</td></tr>\n    <tr><td style="padding:4pt">Contoso</td><td style="padding:4pt">APAC</td><td style="padding:4pt; text-align:right">$964,000</td></tr>\n  </tbody>\n</table>' },
  { group: 'Table', name: 'Striped table', tags: ['table'], snippet: '<table data-grid="0.5pt solid #e5eaf1" data-striped>\n  <thead>\n    <tr style="background:#0f2f57; color:#ffffff"><th style="padding:5pt">Item</th><th style="padding:5pt; text-align:right">Qty</th></tr>\n  </thead>\n  <tbody>\n    <tr><td style="padding:4pt">Widget</td><td style="padding:4pt; text-align:right">12</td></tr>\n    <tr><td style="padding:4pt">Gadget</td><td style="padding:4pt; text-align:right">7</td></tr>\n  </tbody>\n</table>' },
  { group: 'Table', name: 'Merged cells', tags: ['table'], hint: 'colspan + rowspan', snippet: '<table data-grid="1px solid #b8c4d4">\n  <tr><th colspan="3" style="background:#dce6f2; color:#0f2f57; padding:6pt; text-align:center">A banner spanning three columns</th></tr>\n  <tr>\n    <td rowspan="2" style="padding:6pt; background:#f8fafc; font-weight:700">2026</td>\n    <td style="padding:6pt">January</td><td style="padding:6pt; text-align:right">$400</td>\n  </tr>\n  <tr><td style="padding:6pt">February</td><td style="padding:6pt; text-align:right">$600</td></tr>\n</table>' },
  { group: 'Table', name: 'Two-way table', tags: ['table'], hint: 'diagonal corner header', snippet: '<table data-grid="1.5px solid #1a1a1a" style="border-collapse:collapse">\n  <thead>\n    <tr>\n      <th data-diagonal data-diagonal-bottom="Gender" style="background:#e6efdc; padding:10pt 8pt; text-align:center">Preferred Pet</th>\n      <th style="background:#e6efdc; padding:10pt 8pt; text-align:center">Dog</th>\n      <th style="background:#e6efdc; padding:10pt 8pt; text-align:center">Cat</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">Girl</td><td style="padding:8pt; text-align:center">2</td><td style="padding:8pt; text-align:center">5</td></tr>\n    <tr><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">Boy</td><td style="padding:8pt; text-align:center">4</td><td style="padding:8pt; text-align:center">3</td></tr>\n  </tbody>\n</table>' },
  { group: 'Table', name: 'Rich cell', tags: ['td'], hint: 'a cell holding blocks', snippet: '<td style="padding:6pt"><img src="@@LOGO@@" style="width:52pt"><div data-barcode="qr" data-value="NW-001" data-module-size="1.2"></div></td>' },

  // --- Chart --------------------------------------------------------------
  { group: 'Chart', name: 'Bar chart', tags: [], snippet: '<div data-chart="bar" data-title="Revenue by quarter ($M)" data-categories="Q1,Q2,Q3,Q4" data-series="Revenue:58.2,61.4,63.1,66.8" data-show-values="true" data-value-format="#,##0.0" data-legend="none" style="height:140pt"></div>' },
  { group: 'Chart', name: 'Line chart', tags: [], snippet: '<div data-chart="line" data-title="Revenue vs. cost ($M)" data-categories="Q1,Q2,Q3,Q4" data-series="Revenue:58.2,61.4,63.1,66.8; Cost:41.0,42.6,43.4,45.1" data-legend="bottom" data-value-format="#,##0.0" style="height:140pt"></div>' },
  { group: 'Chart', name: 'Area chart (from a table)', tags: ['table'], hint: 'plotted from its own rows', snippet: '<table data-chart="area" data-title="Headcount by segment (stacked)" data-stacked="true" data-colors="#0f2f57,#1b7f4b,#e08a1e" style="height:130pt">\n  <thead><tr><th>Quarter</th><th>Platform</th><th>Analytics</th><th>Services</th></tr></thead>\n  <tbody>\n    <tr><td>Q3 25</td><td>420</td><td>310</td><td>280</td></tr>\n    <tr><td>Q4 25</td><td>445</td><td>330</td><td>295</td></tr>\n    <tr><td>Q1 26</td><td>470</td><td>352</td><td>300</td></tr>\n  </tbody>\n</table>' },
  { group: 'Chart', name: 'Pie chart', tags: [], snippet: '<div data-chart="pie" data-title="Channel mix" data-categories="Direct,Partner,Retail,Online" data-values="37,25,22,16" data-legend="right" style="height:130pt"></div>' },
  { group: 'Chart', name: 'Donut chart', tags: [], snippet: '<div data-chart="donut" data-title="Revenue mix" data-categories="Platform,Analytics,Services,Retail" data-values="38,26,19,17" data-legend="right" data-inner-radius="0.6" style="height:140pt"></div>' },
  { group: 'Chart', name: 'Combo chart', tags: [], hint: 'bars + line, dual axis', snippet: '<div data-chart="combo" data-title="Revenue (bars) vs. margin (line)" data-categories="Q1,Q2,Q3,Q4" data-series="Revenue:58.2,61.4,63.1,66.8; Margin:18.2,19.1,20.4,22.6" data-series-types="bar,line" data-series-axes="left,right" data-right-min="0" data-right-max="30" data-value-format="#,##0.0" data-legend="bottom" style="height:150pt"></div>' },
  { group: 'Chart', name: '100% stacked bars', tags: [], snippet: '<div data-chart="bar" data-title="Revenue mix by year (100% stacked)" data-categories="2023,2024,2025,2026" data-series="Platform:38,42,47,53; Analytics:24,26,28,29; Services:22,20,17,14" data-stacked="100%" data-show-values="true" data-colors="#0f2f57,#1b7f4b,#e08a1e" data-legend="bottom" style="height:150pt"></div>' },
  { group: 'Chart', name: 'Waterfall chart', tags: [], snippet: '<div data-chart="waterfall" data-title="Cash bridge ($M)" data-categories="Opening,Revenue,Costs,Tax,Closing" data-values="42,72,-38,-6,0" data-totals="0,4" data-show-values="true" data-waterfall-colors="increase=#15803d; decrease=#b91c1c; total=#0f2f57" data-value-format="#,##0.0" style="height:150pt"></div>' },
  { group: 'Chart', name: 'Scatter chart', tags: [], hint: 'with a reference line', snippet: '<div data-chart="scatter" data-title="Latency vs. load" data-x-format="#,##0" data-series="P95:120,180,240,210,300" data-series-x="10,20,30,40,50" data-reference-lines="250:SLO,color=#c00,dash=3:2" style="height:150pt"></div>' },
  { group: 'Chart', name: 'Radar chart', tags: [], snippet: '<div data-chart="radar" data-title="Vehicle comparison" data-categories="Speed,Power,Range,Grip,Comfort,Value" data-series="Car A:80,60,70,90,75,65; Car B:70,85,55,65,88,72" data-legend="right" style="height:150pt"></div>' },
  { group: 'Chart', name: 'Gauge chart', tags: [], snippet: '<div data-chart="gauge" data-title="SLA compliance" data-gauge-value="72" data-gauge-max="100" data-series="score:72" style="height:130pt"></div>' },
  { group: 'Chart', name: 'Heatmap chart', tags: [], snippet: '<div data-chart="heatmap" data-title="Weekly activity by shift" data-categories="Mon,Tue,Wed,Thu,Fri,Sat" data-series="Morning:3,5,8,4,2,6; Afternoon:6,7,4,9,5,3; Evening:2,3,5,7,8,4" data-heatmap-colors="from=#eef4ff;to=#1e3a8a" style="height:150pt"></div>' },
  { group: 'Chart', name: 'Gantt timeline', tags: [], snippet: '<div data-chart="gantt" data-title="Product launch plan (weeks)" data-gantt-unit="week" data-gantt-start="0" data-gantt-end="14" data-gantt-tasks="Discovery:0:2:#0f2f57:1;Design:2:5:#7c3aed:0.6;Backend:4:9:#1b7f4b:0.35:1;Frontend:5:10:#e08a1e:0.4:1;Launch:13:14:#0f2f57:0:2,3" style="height:220pt"></div>' },

  // --- Image & Code -------------------------------------------------------
  { group: 'Image & Code', name: 'Image', tags: ['img'], hint: 'data URI, file path or URL', snippet: '<img src="@@LOGO@@" width="150" style="text-align:left">' },
  { group: 'Image & Code', name: 'Inline SVG', tags: ['svg'], hint: 'drawn as real PDF paths', snippet: '<svg viewBox="0 0 24 24" width="52" height="52">\n  <circle cx="12" cy="12" r="11" fill="#0f2f57"/>\n  <path d="M7 12.5l3 3 7-7" stroke="#ffffff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>\n</svg>' },
  { group: 'Image & Code', name: 'QR code', tags: ['barcode'], hint: 'matrix symbol from any value', snippet: '<div data-barcode="qr" data-value="https://example.com/reports" data-module-size="2" data-error-correction="Q" style="margin-top:8pt"></div>' },
  { group: 'Image & Code', name: 'Code 128', tags: ['barcode'], hint: 'linear barcode', snippet: '<div data-barcode="code128" data-value="RPT-2026-Q3-0042" data-color="#0f2f57" style="height:34pt"></div>' },
  { group: 'Image & Code', name: 'EAN-13', tags: ['barcode'], hint: 'retail linear barcode', snippet: '<div data-barcode="ean13" data-value="590123412345"></div>' },

  // --- Navigation ---------------------------------------------------------
  { group: 'Navigation', name: 'Table of contents', tags: [], hint: 'auto page numbers', snippet: '<div data-toc data-title="Contents" data-level="2" style="margin:16pt 0"></div>' },
  { group: 'Navigation', name: 'Internal link', tags: ['a'], hint: 'jumps to an element id', snippet: '<a href="#section-2">Jump to section 2</a>' },
  { group: 'Navigation', name: 'External link', tags: ['a'], snippet: '<a href="https://example.com">Open example.com</a>' },
  { group: 'Navigation', name: 'Page header band', tags: ['header'], hint: 'repeated on every page', snippet: '<header data-band="pageHeader" style="font-size:8pt; color:#94a3b8; text-transform:uppercase; border-bottom:1pt solid #e2e8f0; padding-bottom:3pt">Northwind Group · Quarterly Report</header>' },
  { group: 'Navigation', name: 'Page footer band', tags: ['footer'], hint: 'running {PAGE}/{TOTAL}', snippet: '<footer data-band="pageFooter" style="font-size:8pt; color:#94a3b8">\n  <table style="border:0; width:100%">\n    <tr>\n      <td style="text-align:left">pdf-report-engine</td>\n      <td style="text-align:right">Page {PAGE} of {TOTAL}</td>\n    </tr>\n  </table>\n</footer>' },
  { group: 'Navigation', name: 'Title band', tags: ['section'], hint: 'once, on page 1', snippet: '<section data-band="title">\n  <p style="font-size:23pt; font-weight:700; color:#0f2f57; margin:0">Quarterly Snapshot</p>\n  <p style="font-size:10.5pt; color:#64748b; margin-top:6pt">A cover band that appears once, at the top of page 1.</p>\n</section>' },
  { group: 'Navigation', name: 'Summary band', tags: ['section'], hint: 'once, on the last page', snippet: '<section data-band="summary" style="border-top:2pt solid #0f2f57; padding-top:8pt; font-weight:700; color:#0f2f57">Grand total revenue: $72.1M.</section>' },

  // --- Branding -----------------------------------------------------------
  { group: 'Branding', name: 'Watermark (body attrs)', tags: ['body'], hint: 'click the <body> tag to edit it', snippet: '<body data-watermark="SAMPLE" data-watermark-rotate="-35" data-watermark-size="72" data-watermark-color="#c0c0c0" data-watermark-opacity="0.22" data-watermark-layer="foreground" style="font-family:Inter; font-size:10pt; color:#24303f">\n  <p>Watermark applied — edit the attributes on this &lt;body&gt;, or remove them to drop it.</p>\n</body>' },

  // --- Data ---------------------------------------------------------------
  { group: 'Data', name: 'Data-bound table', tags: ['table'], hint: 'data-each + data-bind', snippet: '<table data-each="line in $data.ledger" data-grid="0.5pt solid #e5eaf1" data-striped>\n  <thead>\n    <tr style="background:#0f2f57; color:#ffffff"><th style="padding:5pt">Segment</th><th style="padding:5pt">Region</th><th style="padding:5pt; text-align:right">Revenue</th></tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td style="padding:4pt" data-bind="segment"></td>\n      <td style="padding:4pt" data-bind="region"></td>\n      <td style="padding:4pt; text-align:right" data-bind="revenue" data-format="#,##0.0"></td>\n    </tr>\n  </tbody>\n</table>' },
  { group: 'Data', name: 'Conditional row', tags: ['tr'], hint: 'data-when + data-when-style', snippet: '<tr data-when="$row.revenue &lt; 5" data-when-style="color:#b91c1c">\n  <td style="padding:4pt" data-bind="segment"></td>\n  <td style="padding:4pt; text-align:right" data-bind="revenue" data-format="#,##0.0"></td>\n</tr>' },
  { group: 'Data', name: 'Render-if block', tags: [], hint: 'data-if hides it when false', snippet: '<p data-if="$data.ledger.length &gt; 0">This paragraph only renders when the dataset is not empty.</p>' },
  { group: 'Data', name: 'Color-scale cell', tags: ['td'], hint: 'heatmap shading', snippet: '<td style="padding:4pt; text-align:right" data-bind="revenue" data-format="#,##0.0" data-color-scale="from=#eef4ff; to=#1e3a8a"></td>' },
];

// A tiny inline logo so image blocks work offline (same one the demo uses).
export const LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAAwCAIAAAA3jserAAAAu0lEQVR42u3SQQ2AMBREwe8AB1hATj1hAitI4YSOGuBCSpu2TPIU7E5c+zpcy5bUoCBDk+BwGBxkwEEGHGTAQQYcZMBBhoIMDYbDMXCQAQcZcJABBxlwkAEHGeoXhw/gIAMOMuAgAw4y4CBDPeCwOBxkwEEGHGTAQYba4jAxHGTAQQYcZKgWDrPCQQYcZMBBhmrhMCUcZMBBhuJxWBCO547z1sQFGfoYh+HgIAMOMlSOw15wkKE3OCz1wzKtiMUHl/QIoAAAAABJRU5ErkJggg==';

/** Substitute palette placeholders (kept out of the snippets' own syntax). */
export function materialize(snippet) {
  return snippet.split('@@LOGO@@').join(LOGO_DATA_URI);
}

// A blank document for "New": empty source the user builds up from the palette.
export const BLANK_HTML = '';

// Starter document shown on first visit (the palette appends to it).
export const STARTER_HTML = `<!-- Welcome to the visual editor.
     · Click a block on the left to insert it at the cursor.
     · Move the caret onto a tag to edit its properties on the right.
     · Press "Generate PDF" to render the report entirely in your browser. -->
<style>
  .section-title { color: #ad1439; border-bottom: 2pt solid #fbbf24; padding-bottom: 4pt; }
</style>

<h1>Untitled report</h1>
<p class="section-title">Getting started</p>
<p>Insert blocks from the palette, place the caret on any tag and edit its properties here in the right panel. The source stays plain constrained HTML — the same dialect the CLI and the Node API consume.</p>

<table data-grid="0.5pt solid #e5eaf1">
  <thead>
    <tr style="background:#ad1439; color:#ffffff"><th style="padding:5pt">Block</th><th style="padding:5pt">Notes</th></tr>
  </thead>
  <tbody>
    <tr><td style="padding:4pt">Palette</td><td style="padding:4pt">click to insert at the caret</td></tr>
    <tr><td style="padding:4pt">Properties</td><td style="padding:4pt">follows the caret element</td></tr>
  </tbody>
</table>`;
