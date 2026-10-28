// Online report editor for pdf-report-engine.
//
// Three panes: a block palette (click to insert at the caret), the
// constrained-HTML source editor (the same transparent-textarea-over-
// highlighted-`<pre>` technique as the browser demo), and a properties panel
// bound to the element under the caret. "Generate PDF" renders with the same
// pre-bundled engine as the demo, fully client-side.
// The element model, offset mapping and schemas live in editor-defs.js.
import { htmlToReportDoc, renderToBuffer } from './browser/pdf-report-engine.js';
import {
  parseHtml, serializeHtml, serializeWithOffsets, plainSerialize,
  findNode, removeNode, typeOrdinal, locateBySignature, countBlocks,
  enclosingElement, highlightHtml, materialize, STARTER_HTML, BLANK_HTML,
  STYLE_PROPS, ATTR_SCHEMAS, BLOCKS, GROUPS, VOID_TAGS, BLOCK_TAGS,
} from './editor-defs.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const gutter = $('gutter');
const highlightEl = $('highlight');
const highlightCode = highlightEl.querySelector('code');
const paletteEl = $('palette-groups');
const propsEl = $('props');
const statusEl = $('status');
const downloadEl = $('download');
const pagecountEl = $('pagecount');

// ---- shared model ----------------------------------------------------------
let tree = null;      // parsed tree of the current serialized source
let offsets = null;   // open-tag ranges keyed by child-index path strings
let selPath = null;   // path of the selected element (into `tree`)
const undoStack = [];

const STORAGE_KEY = 'pdf-report-engine:editor:html';

/**
 * Re-parse the textarea; with `reformat`, pretty-print in place (only when the
 * caret stays within one tag of its old position, so typing is never shoved
 * around). The parser/serializer round-trips well-formed text exactly, so the
 * model can always be re-derived from `editor.value`.
 */
function syncEditor({ reformat = false } = {}) {
  const caret = editor.selectionStart;
  let src = editor.value;
  let parsed = parseHtml(src);
  if (reformat) {
    const pretty = serializeHtml(parsed);
    if (pretty !== src) {
      const so = serializeWithOffsets(parsed);
      const el = enclosingElement(so.offsets, caret);
      const d = el ? Math.min(Math.abs(caret - el.start), Math.abs(caret - el.end)) : Math.abs(caret - src.length);
      if (d <= 1) {
        src = pretty;
        parsed = parseHtml(src);
      }
    }
  }
  const so = serializeWithOffsets(parsed);
  tree = parsed;
  offsets = so.offsets;
  if (src !== editor.value) editor.value = src;
  clampCaretToSelection();
  refreshChrome();
  updateSelectionFromCaret();
}

/** Keep the caret anchored inside the selected element after a re-serialize. */
function clampCaretToSelection() {
  const el = enclosingElement(offsets, editor.selectionStart);
  if (!el) return;
  const pos = Math.min(Math.max(editor.selectionStart, el.start), el.end);
  editor.setSelectionRange(pos, pos);
}

function refreshChrome() {
  highlightCode.innerHTML = highlightHtml(editor.value);
  const lines = editor.value.split('\n').length;
  gutter.textContent = Array.from({ length: lines }, (_, n) => n + 1).join('\n');
  syncScroll();
  try { localStorage.setItem(STORAGE_KEY, editor.value); } catch { /* ignore */ }
}

function syncScroll() {
  highlightEl.scrollTop = editor.scrollTop;
  highlightEl.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

function pushUndo() {
  undoStack.push(editor.value);
  if (undoStack.length > 80) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return status('Nothing to undo.');
  editor.value = undoStack.pop();
  selPath = null;
  syncEditor();
  editor.focus();
  status('Undid the last palette/panel action.');
}

/** Scroll so the caret line sits near the middle of the viewport. */
function scrollToCaret() {
  const line = editor.value.slice(0, editor.selectionStart).split('\n').length - 1;
  const lineH = 20;
  const top = line * lineH;
  if (top < editor.scrollTop || top > editor.scrollTop + editor.clientHeight - lineH * 2) {
    editor.scrollTop = Math.max(0, top - editor.clientHeight / 2);
  }
  syncScroll();
}

// ---- selection -------------------------------------------------------------
function selSignature(path = selPath) {
  if (!path || !tree) return null;
  const node = findNode(tree, path);
  if (!node || node.type !== 'element' || node.tag === '#root') return null;
  return { tag: node.tag, ordinal: typeOrdinal(tree, path) };
}

function updateSelectionFromCaret() {
  if (!offsets) return;
  const el = enclosingElement(offsets, editor.selectionStart);
  const path = el ? el.path : null;
  const changed = JSON.stringify(path) !== JSON.stringify(selPath);
  selPath = path;
  if (changed) renderProps();
}

function selectPath(path) {
  selPath = path;
  renderProps();
}

// ---- palette ---------------------------------------------------------------
function buildPalette(filter = '') {
  const q = filter.trim().toLowerCase();
  paletteEl.textContent = '';
  for (const group of GROUPS) {
    // match within the group only, and let the group name itself be searchable
    // (so "barcode", "chart", "table" find the blocks filed under them)
    const blocks = BLOCKS.filter((b) => b.group === group && (!q
      || group.toLowerCase().includes(q)
      || b.name.toLowerCase().includes(q)
      || (b.hint || '').toLowerCase().includes(q)
      || b.tags.some((t) => t.includes(q))));
    if (!blocks.length) continue;
    const head = document.createElement('p');
    head.className = 'pgroup';
    head.textContent = group;
    paletteEl.appendChild(head);
    for (const block of blocks) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pitem';
      btn.dataset.group = block.group;
      const name = document.createElement('span');
      name.className = 'pitem-name';
      name.textContent = block.name;
      btn.appendChild(name);
      if (block.tags.length) {
        const tag = document.createElement('span');
        tag.className = 'pitem-tag';
        tag.textContent = `<${block.tags[0]}>`;
        btn.appendChild(tag);
      }
      if (block.hint) btn.title = block.hint;
      // Stop the button from stealing focus: pressing it would blur the
      // textarea, whose reformat+caret-clamp handler drags the caret off the
      // user's real cursor position (so the block wouldn't land at the cursor).
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => insertBlock(block));
      paletteEl.appendChild(btn);
    }
  }
  if (!paletteEl.children.length) {
    const p = document.createElement('p');
    p.className = 'pempty';
    p.textContent = 'No blocks match that search.';
    paletteEl.appendChild(p);
  }
}

function insertBlock(block) {
  pushUndo();
  let snippet = materialize(block.snippet);
  // repeated inserts get numbered: "Section heading", "Section heading 2", …
  const n = block.tags.length && tree ? countBlocks(tree, block.tags) + 1 : 1;
  if (n > 1) {
    const probe = parseHtml(snippet);
    if (probe.children[0] && renumberText(probe.children[0], n)) snippet = plainSerialize(probe.children[0]);
  }

  // insertion point: snap the caret out of any `<…>` tag (so we never splice
  // into the middle of a tag), then insert exactly there. A caret inside an open
  // tag therefore resolves to just after its `>` (the block becomes a child);
  // a caret in body text or between blocks inserts right at the caret.
  const value = editor.value;
  const pos = snapOutOfTag(value, editor.selectionStart);

  // a temporary marker attribute lets us find the inserted element again after
  // re-parsing + re-indenting (raw caret offsets shift once serialised)
  const marker = 'i' + Math.random().toString(36).slice(2, 9);
  const src = value.slice(0, pos) + '\n' + markSnippet(snippet, marker) + '\n' + value.slice(pos);
  const parsed = parseHtml(src);
  normalizeParsed(parsed);
  const path = findMarked(parsed, marker);
  if (path) delete findNode(parsed, path).attrs['data-ins'];
  const so = serializeWithOffsets(parsed);
  tree = parsed;
  offsets = so.offsets;
  selPath = path;
  editor.value = so.src;
  const r = path && so.offsets.map.get(path.join(','));
  // place the caret just after the whole inserted element (past its close tag),
  // so the user can keep typing right below the new block
  const caretNew = r ? (r.fullEnd ?? r.end) : 0;
  editor.setSelectionRange(caretNew, caretNew);
  refreshChrome();
  renderProps();
  scrollToCaret();
  editor.focus();
  showSourceTab();
}

/** Move an offset that falls inside a `<…>` tag to just after its closing `>`. */
function snapOutOfTag(value, offset) {
  const lt = value.lastIndexOf('<', offset - 1);
  if (lt === -1) return offset;
  const gt = value.indexOf('>', lt);
  return gt !== -1 && gt >= offset ? gt + 1 : offset;
}

/** Add `data-ins="marker"` to a snippet's root open tag (single-root snippets). */
function markSnippet(snippet, marker) {
  return snippet.replace(/^<([A-Za-z][-.:\w]*)/, (_m, tag) => `<${tag} data-ins="${marker}"`);
}

/** Path of the element carrying `data-ins="marker"`, or null. */
function findMarked(root, marker) {
  let found = null;
  (function walk(node, path) {
    if (found) return;
    for (let k = 0; k < (node.children || []).length; k += 1) {
      const c = node.children[k];
      if (c.type !== 'element') continue;
      if (c.attrs && c.attrs['data-ins'] === marker) { found = [...path, k]; return; }
      walk(c, [...path, k]);
      if (found) return;
    }
  })(root, []);
  return found;
}

/** Collapse whitespace-only text nodes so the snippet re-indents cleanly. */
function normalizeParsed(root) {
  (function walk(node) {
    if (node.type !== 'element') return;
    const hasBlock = node.children.some((c) => c.type === 'element' && BLOCK_TAGS.has(c.tag));
    if (hasBlock) {
      node.children = node.children.filter((c) => !(c.type === 'text' && /^[\s]+$/.test(c.text)));
    }
    for (const child of node.children) {
      if (child.type === 'text') child.text = child.text.replace(/^\s+/, '').replace(/[\s\u2028\u2029]+$/, '');
      else walk(child);
    }
  })(root);
}

/** Append " N" to the first short text run of a subtree (duplicate naming). */
function renumberText(node, n) {
  for (const child of node.children || []) {
    if (child.type === 'text') {
      const t = child.text.trim();
      if (t && t.length < 60) {
        child.text = child.text.replace(/\s+$/, '') + ' ' + String(n);
        return true;
      }
    } else if (child.type === 'element') {
      if (renumberText(child, n)) return true;
    }
  }
  return false;
}

// ---- properties panel ------------------------------------------------------
function textOnlyContent(node) {
  if (!node.children.length) return null;
  if (node.children.some((c) => c.type !== 'text')) return null;
  return node.children.map((c) => c.text).join('');
}

function parseDecls(styleStr) {
  const decls = [];
  for (const part of String(styleStr || '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i < 0) { decls.push({ prop: t.toLowerCase(), value: '' }); continue; }
    decls.push({ prop: t.slice(0, i).trim().toLowerCase(), value: t.slice(i + 1).trim() });
  }
  return decls;
}

function declsToStr(decls) {
  return decls.filter((d) => d.value !== '').map((d) => `${d.prop}: ${d.value}`).join('; ');
}

function ancestorsOf(path) {
  const out = [];
  for (let k = 0; k <= path.length; k += 1) {
    const node = findNode(tree, path.slice(0, k));
    if (node && node.type === 'element') out.push({ path: path.slice(0, k), node });
  }
  return out;
}

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const normalizeHex = (h) => {
  let s = String(h);
  if (s.length === 4) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#000000';
};

// Style props shown as rows even when unset, so common knobs are one click away.
const STYLE_ALWAYS = ['font-family', 'font-size', 'font-weight', 'color', 'background', 'text-align', 'border', 'padding', 'margin', 'width', 'height', 'display'];
// data-* attributes offered with a "set" affordance when absent.
const ATTR_ALWAYS = ['data-if', 'data-when', 'data-color-scale', 'data-each', 'data-bind', 'data-toc', 'data-band', 'data-title', 'data-diagonal', 'data-diagonal-bottom'];

// Focus is stolen by the panel rebuild after each keystroke; re-arm it on the
// same logical field (identified by a stable key) so typing feels native.
const focusRestore = {
  key: null,
  target: null,
  arm(key) { this.key = key; this.target = null; },
  register(key, el) { if (key === this.key) this.target = el; },
  done() {
    if (this.key && this.target && document.contains(this.target)) {
      this.target.focus();
      const len = (this.target.value ?? '').length;
      this.target.setSelectionRange?.(len, len);
    }
    this.key = null;
    this.target = null;
  },
};

function renderProps() {
  propsEl.textContent = '';
  const node = selPath && tree ? findNode(tree, selPath) : null;
  if (!node || node.tag === '#root') {
    const p = document.createElement('p');
    p.className = 'props-hint';
    p.innerHTML = 'No element selected.<br>Click a <strong>block</strong> on the left to insert one, or move the caret onto a tag in the editor — its properties appear here.';
    propsEl.appendChild(p);
    return;
  }

  // breadcrumb: click any ancestor to select it
  const crumbs = document.createElement('div');
  crumbs.className = 'crumbs';
  ancestorsOf(selPath).forEach(({ path, node: a }, i, arr) => {
    if (i > 0) crumbs.append(' › ');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb' + (i === arr.length - 1 ? ' active' : '');
    btn.textContent = a.tag === '#root' ? 'doc' : a.tag;
    btn.addEventListener('click', () => selectByAncestor(path));
    crumbs.appendChild(btn);
  });
  propsEl.appendChild(crumbs);

  // header: tag + element actions
  const head = document.createElement('div');
  head.className = 'props-head';
  const tagLabel = document.createElement('strong');
  tagLabel.textContent = `<${node.tag}>`;
  head.appendChild(tagLabel);
  const actions = document.createElement('span');
  actions.className = 'props-actions';
  if (!VOID_TAGS.has(node.tag)) actions.appendChild(actionBtn('Dup', 'duplicate this element', duplicateSelected));
  if (selPath.length) {
    actions.appendChild(actionBtn('↑', 'move up (swap with previous sibling)', () => moveSelected(-1)));
    actions.appendChild(actionBtn('↓', 'move down (swap with next sibling)', () => moveSelected(1)));
    actions.appendChild(actionBtn('Del', 'delete this element', deleteSelected));
  }
  head.appendChild(actions);
  propsEl.appendChild(head);

  // content: only for elements whose children are pure text
  const text = textOnlyContent(node);
  if (text !== null) {
    propsEl.appendChild(section('Content', () => {
      const row = fieldRow('Text');
      const inp = document.createElement('textarea');
      inp.rows = 2;
      inp.value = text;
      const key = 'text';
      inp.addEventListener('focus', () => focusRestore.arm(key));
      inp.addEventListener('input', () => {
        focusRestore.arm(key);
        applyEdit((t) => { t.children = [{ type: 'text', text: inp.value || ' ' }]; }, key);
      });
      row.appendChild(inp);
      focusRestore.register(key, inp);
      return row;
    }));
  }

  // attributes: schema-matched rows first, then anything else verbatim
  propsEl.appendChild(section('Attributes', () => {
    const wrap = document.createElement('div');
    const present = Object.keys(node.attrs);
    const covered = new Set();
    const isBareAttr = (name) => schemaFor(name)?.type === 'bool' || node.attrs[name] === '';
    for (const schema of ATTR_SCHEMAS) {
      const isPresent = present.includes(schema.attr);
      if (isPresent) {
        covered.add(schema.attr);
      } else {
        // absent attributes only appear as quick-add rows when both the always-
        // list and the element-type match allow it
        if (!ATTR_ALWAYS.includes(schema.attr) || !schema.match(node.tag, node.attrs)) continue;
      }
      wrap.appendChild(attrRow(node, schema));
    }
    for (const name of present) {
      if (covered.has(name) || name === 'style') continue;
      wrap.appendChild(attrRow(node, { attr: name, label: name, type: isBareAttr(name) ? 'bool' : 'text' }));
    }
    const add = document.createElement('div');
    add.className = 'prow addattr';
    const nameInp = document.createElement('input');
    nameInp.placeholder = 'attribute name';
    const go = actionBtn('Add', 'add this attribute', () => {
      const name = nameInp.value.trim();
      if (!/^[-\w:@.]+$/.test(name)) return status('Attribute name is not valid.', true);
      applyEdit((t) => { if (!(name in t.attrs)) t.attrs[name] = ''; });
      nameInp.value = '';
      status(`Added ${name}.`);
    });
    add.append(nameInp, go);
    wrap.appendChild(add);
    return wrap;
  }));

  // style properties
  propsEl.appendChild(section('Style', () => {
    const wrap = document.createElement('div');
    const decls = parseDecls(node.attrs['style'] ?? '');
    const byProp = new Map();
    for (const d of decls) if (!byProp.has(d.prop)) byProp.set(d.prop, d);
    const shown = new Set();
    for (const schema of STYLE_PROPS) {
      const d = byProp.get(schema.prop);
      if (!d && !STYLE_ALWAYS.includes(schema.prop)) continue;
      shown.add(schema.prop);
      wrap.appendChild(styleRow(schema, d ? d.value : ''));
    }
    for (const d of decls) {
      if (shown.has(d.prop)) continue;
      wrap.appendChild(styleRow({ prop: d.prop, label: d.prop, type: 'text' }, d.value));
    }
    return wrap;
  }));

  focusRestore.done();
}

function section(title, build) {
  const details = document.createElement('details');
  details.open = true;
  const sum = document.createElement('summary');
  sum.textContent = title;
  details.appendChild(sum);
  const body = build();
  if (body) details.appendChild(body);
  return details;
}

function fieldRow(label, hint) {
  const row = document.createElement('div');
  row.className = 'prow';
  const lab = document.createElement('label');
  lab.textContent = label;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  return row;
}

function actionBtn(text, title, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mini';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', fn);
  return b;
}

function schemaFor(name) {
  return ATTR_SCHEMAS.find((s) => s.attr === name) || null;
}

function attrRow(node, schema) {
  const { attr: name } = schema;
  const present = name in node.attrs;
  const row = fieldRow(schema.label || name, schema.hint);
  row.classList.add('attr');
  const key = 'a:' + name;
  if (!present) {
    const lab = document.createElement('span');
    lab.className = 'not-set';
    lab.textContent = 'not set';
    row.appendChild(lab);
    row.appendChild(actionBtn('＋ set', `add ${name}`, () => {
      focusRestore.arm(key);
      applyEdit((t) => { t.attrs[name] = ''; }, key);
    }));
    return row;
  }
  const value = node.attrs[name];
  if (schema.type === 'bool') {
    const lab = document.createElement('label');
    lab.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => {
      focusRestore.arm(key);
      applyEdit((t) => { if (cb.checked) t.attrs[name] = value; else delete t.attrs[name]; }, key);
    });
    lab.append(cb, document.createTextNode(value === '' ? '(bare)' : value));
    row.appendChild(lab);
    row.appendChild(actionBtn('×', `remove ${name}`, () => {
      focusRestore.arm(key);
      applyEdit((t) => { delete t.attrs[name]; }, key);
    }));
    return row;
  }
  inputOrSelect(row, schema, value, (v) => {
    focusRestore.arm(key);
    applyEdit((t) => { t.attrs[name] = v; }, key);
  }, key);
  row.appendChild(actionBtn('×', `remove ${name}`, () => {
    focusRestore.arm(key);
    applyEdit((t) => { delete t.attrs[name]; }, key);
  }));
  return row;
}

function styleRow(schema, value) {
  const key = 's:' + schema.prop;
  const row = fieldRow(schema.label || schema.prop, schema.hint);
  row.classList.add('style');
  const setStyle = (mutate) => {
    focusRestore.arm(key);
    applyEdit((t) => {
      const ds = parseDecls(t.attrs['style'] ?? '');
      const d = ds.find((x) => x.prop === schema.prop);
      mutate(ds, d);
      const str = declsToStr(ds);
      if (str) t.attrs['style'] = str;
      else delete t.attrs['style'];
    }, key);
  };
  inputOrSelect(row, schema, value, (v) => {
    setStyle((ds, d) => {
      if (v === '' || v == null) { if (d) ds.splice(ds.indexOf(d), 1); }
      else if (d) d.value = v;
      else ds.push({ prop: schema.prop, value: v });
    });
  }, key);
  if (value !== '') {
    row.appendChild(actionBtn('−', `remove ${schema.prop}`, () => setStyle((ds, d) => { if (d) ds.splice(ds.indexOf(d), 1); })));
  } else {
    row.appendChild(actionBtn('＋', `add ${schema.prop} (empty)`, () => setStyle((ds, d) => { if (!d) ds.push({ prop: schema.prop, value: '' }); })));
  }
  return row;
}

function inputOrSelect(row, schema, value, onInput, key) {
  if (schema.type === 'select') {
    const sel = document.createElement('select');
    const opts = schema.options ?? [];
    for (const o of ['', ...opts]) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o === '' ? '(none)' : o;
      sel.appendChild(opt);
    }
    if (!opts.includes(value) && value !== '') {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onInput(sel.value));
    row.appendChild(sel);
    focusRestore.register(key, sel);
    return;
  }
  if (schema.type === 'color' && HEX_RE.test(value || '')) {
    const sw = document.createElement('input');
    sw.type = 'color';
    sw.value = normalizeHex(value);
    sw.addEventListener('input', () => onInput(sw.value));
    row.appendChild(sw);
  }
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value ?? '';
  if (schema.hint) inp.placeholder = schema.hint;
  inp.addEventListener('input', () => onInput(inp.value));
  row.appendChild(inp);
  focusRestore.register(key, inp);
}

// ---- edit pipeline -----------------------------------------------------------
/**
 * Apply `mutate` to the selected element: re-parse the current text, locate the
 * element by signature (tag + ordinal), mutate, re-serialize, restore caret
 * and panel focus. Every call is one undo step.
 */
function applyEdit(mutate, focusKey = null) {
  const sig = selSignature();
  if (!sig) return;
  pushUndo();
  if (focusKey) focusRestore.arm(focusKey);
  const parsed = parseHtml(editor.value);
  const path = locateBySignature(parsed, sig);
  if (!path) return status('Could not find the edited element any more — adjust the source manually.', true);
  mutate(findNode(parsed, path));
  const so = serializeWithOffsets(parsed);
  const caret = editor.selectionStart;
  tree = parsed;
  offsets = so.offsets;
  selPath = path;
  editor.value = so.src;
  const range = so.offsets.map.get(path.join(','));
  const newPos = range ? Math.min(Math.max(caret, range.start), range.end) : Math.min(caret, so.src.length);
  editor.setSelectionRange(newPos, newPos);
  refreshChrome();
  renderProps();
}

function replaceSource(parsed, focusPath) {
  const so = serializeWithOffsets(parsed);
  tree = parsed;
  offsets = so.offsets;
  editor.value = so.src;
  const r = focusPath && so.offsets.map.get(focusPath.join(','));
  editor.setSelectionRange(r ? r.start : 0, r ? r.start : 0);
  refreshChrome();
}

function deleteSelected() {
  const sig = selSignature();
  if (!sig) return;
  pushUndo();
  const parsed = parseHtml(editor.value);
  const path = locateBySignature(parsed, sig);
  if (!path) return;
  selPath = null;
  removeNode(parsed, path);
  replaceSource(parsed, path.slice(0, -1));
  updateSelectionFromCaret();
  editor.focus();
}

function duplicateSelected() {
  const sig = selSignature();
  if (!sig) return;
  pushUndo();
  const parsed = parseHtml(editor.value);
  const path = locateBySignature(parsed, sig);
  if (!path) return;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length ? findNode(parsed, parentPath) : parsed;
  const node = findNode(parsed, path);
  parent.children.splice(path[path.length - 1] + 1, 0, JSON.parse(JSON.stringify(node)));
  const newPath = [...parentPath, path[path.length - 1] + 1];
  selPath = newPath;
  replaceSource(parsed, newPath);
  renderProps();
  scrollToCaret();
}

function moveSelected(dir) {
  const sig = selSignature();
  if (!sig) return;
  pushUndo();
  const parsed = parseHtml(editor.value);
  const path = locateBySignature(parsed, sig);
  if (!path) return;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length ? findNode(parsed, parentPath) : parsed;
  const kids = parent.children;
  const idx = path[path.length - 1];
  let j = idx + dir;
  while (j >= 0 && j < kids.length && kids[j].type !== 'element') j += dir;
  if (j < 0 || j >= kids.length) return status('Already first/last among its siblings.');
  [kids[idx], kids[j]] = [kids[j], kids[idx]];
  const newPath = [...parentPath, j];
  selPath = newPath;
  replaceSource(parsed, newPath);
  renderProps();
  scrollToCaret();
}

function selectByAncestor(path) {
  const r = offsets && offsets.map.get(path.join(','));
  if (!r) return;
  editor.setSelectionRange(r.start, r.start);
  selPath = path;
  renderProps();
  scrollToCaret();
  editor.focus();
}

// ---- tabs (source / PDF preview) --------------------------------------------
const tabSource = $('tab-source');
const tabPreview = $('tab-preview');
const panelSource = $('panel-source');
const panelPreview = $('panel-preview');

function showTab(which) {
  const isSource = which !== 'preview';
  tabSource.classList.toggle('active', isSource);
  tabPreview.classList.toggle('active', !isSource);
  tabSource.setAttribute('aria-selected', String(isSource));
  tabPreview.setAttribute('aria-selected', String(!isSource));
  panelSource.classList.toggle('active', isSource);
  panelPreview.classList.toggle('active', !isSource);
  if (isSource) syncScroll(); else generate();
}
const showSourceTab = () => showTab('source');
tabSource.addEventListener('click', () => showTab('source'));
tabPreview.addEventListener('click', () => showTab('preview'));

// ---- generate ----------------------------------------------------------------
let lastUrl = null;
let generating = false;

function countPages(bytes) {
  let latin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) latin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return (latin.match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

function status(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

async function generate() {
  if (generating) return;
  generating = true;
  status('Rendering PDF…');
  downloadEl.hidden = true;
  pagecountEl.hidden = true;
  try {
    const report = htmlToReportDoc(editor.value);
    // charset-aware Google Fonts fetching works here exactly as in the demo;
    // text with no font falls back to the base-14 faces.
    const bytes = await renderToBuffer(report, { resolveFonts: { decodeTimeoutMs: 6000 } });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    lastUrl = URL.createObjectURL(blob);
    $('preview').src = lastUrl;
    downloadEl.href = lastUrl;
    downloadEl.hidden = false;
    const pages = countPages(bytes);
    if (pages) { pagecountEl.textContent = `${pages}p`; pagecountEl.hidden = false; }
    status(`Done — ${pages} page(s), ${(bytes.byteLength / 1024).toFixed(1)} KB.`);
  } catch (err) {
    status('Error: ' + (err && err.message ? err.message : String(err)), true);
    console.error(err);
  } finally {
    generating = false;
  }
}

$('generate').addEventListener('click', generate);
$('undo').addEventListener('click', undo);
$('new').addEventListener('click', () => {
  pushUndo();
  editor.value = BLANK_HTML;
  syncEditor({ reformat: true });
  // reset the caret + selection *after* syncEditor, whose clamp would otherwise
  // re-derive a selection from wherever the caret ended up
  editor.setSelectionRange(0, 0);
  selPath = null;
  renderProps();
  showTab('source');
  status('New blank document — click a block to start building.');
});
$('reset').addEventListener('click', () => {
  pushUndo();
  editor.value = STARTER_HTML;
  syncEditor({ reformat: true });
  editor.setSelectionRange(0, 0);
  selPath = null;
  renderProps();
  showTab('source');
  status('Reset to the starter document.');
});

// ---- wiring ------------------------------------------------------------------
editor.addEventListener('input', () => {
  // typing: just refresh chrome + selection; the text itself stays untouched
  const caret = editor.selectionStart;
  const parsed = parseHtml(editor.value);
  const so = serializeWithOffsets(parsed);
  tree = parsed;
  offsets = so.offsets;
  void caret;
  refreshChrome();
  updateSelectionFromCaret();
});
editor.addEventListener('scroll', syncScroll);
['click', 'keyup', 'select', 'focus'].forEach((ev) => editor.addEventListener(ev, updateSelectionFromCaret));
editor.addEventListener('blur', () => syncEditor({ reformat: true }));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && document.activeElement !== editor) {
    e.preventDefault();
    undo();
  }
});
$('palette-search').addEventListener('input', (e) => buildPalette(e.target.value));

// ---- boot --------------------------------------------------------------------
(function boot() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  editor.value = saved !== null && saved !== '' ? saved : STARTER_HTML;
  buildPalette();
  syncEditor();
  renderProps();
  status('Click a block to insert it · caret on a tag to edit its properties · Generate PDF to render.');
})();
