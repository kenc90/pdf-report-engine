/**
 * Build the docs site's client-side search index.
 *
 * Walks every HTML page under `docs/`, extracts each top-level `<section id>`
 * (and any `<h3 id>` / `<h4 id>` inside it) into a compact entry — page, anchor,
 * title, and a short body snippet — and writes `docs/search-index.json`. The
 * runtime in `assets/site.js` fetches that file once and filters it in the
 * browser, so no server or third-party search service is required.
 *
 * Deliberately dependency-free: a small regex tokenizer is enough for our
 * hand-authored docs (no nested `<section>`s, headings always have text). If
 * the site ever outgrows this, swap for Pagefind without touching the UI.
 */
import fs from 'node:fs';
import path from 'node:path';

const docsDir = 'docs';
const outPath = path.join(docsDir, 'search-index.json');

/** Pages to index. Order is preserved in the JSON so results can be weighted. */
const PAGES = [
  'index.html',
  'getting-started.html',
  'examples.html',
  'api.html',
  'browser-demo.html',
];

/** Character budget for the snippet stored per entry. */
const SNIPPET_CHARS = 280;

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&');
}

/** Strip tags + collapse whitespace to plain searchable text. */
function textOf(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Find each top-level `<section id="…">…</section>` inside `<main>` (or the whole
 * body if there's no `<main>`). Splits on `<section` / `</section>` and tracks
 * depth so nested sections stay grouped with their parent. Returns the section
 * body text directly (not offsets) to avoid the substring-vs-source offset trap.
 */
function topLevelSections(html) {
  const scope = /<main\b[\s\S]*?<\/main>/i.exec(html);
  const src = scope ? scope[0] : html;
  const out = [];
  const tagRe = /<section\b([^>]*)>|<\/section>/gi;
  let depth = 0;
  let current = null;
  let m;
  while ((m = tagRe.exec(src))) {
    if (m[0][1] === '/') {
      depth -= 1;
      if (depth === 0 && current) {
        current.body = src.slice(current.start, m.index);
        out.push(current);
        current = null;
      }
    } else {
      if (depth === 0) {
        const attrs = m[1] || '';
        const idMatch = /\bid="([^"]+)"/i.exec(attrs);
        current = { id: idMatch ? idMatch[1] : '', start: tagRe.lastIndex };
      }
      depth += 1;
    }
  }
  if (current && current.body === undefined) current.body = src.slice(current.start);
  if (current && current.body) out.push(current);
  return out;
}

/** Grab the first heading (h1–h4) inside a section body as the section's title. */
function sectionTitle(body) {
  const m = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(body);
  return m ? { level: +m[1], title: textOf(m[2]), htmlStart: m.index, htmlEnd: m.index + m[0].length } : null;
}

/** Sub-headings (h3/h4) with an id — used to give long sections finer anchors. */
function subHeadings(body) {
  const out = [];
  const re = /<h([34])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(body))) {
    const attrs = m[2] || '';
    const idMatch = /\bid="([^"]+)"/i.exec(attrs);
    if (!idMatch) continue;
    out.push({ level: +m[1], id: idMatch[1], title: textOf(m[3]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Extract plain text from a body slice, dropping code samples so snippets stay prose-y. */
function snippet(body, from, to) {
  const slice = body.slice(from, to);
  const cleaned = slice
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const text = textOf(cleaned);
  return text.length > SNIPPET_CHARS ? text.slice(0, SNIPPET_CHARS).trimEnd() + '…' : text;
}

function pageLabel(file, html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return file;
  const t = textOf(m[1]);
  return t.split(/[—|]/)[0].trim() || file;
}

function build() {
  const entries = [];
  for (const file of PAGES) {
    const full = path.join(docsDir, file);
    if (!fs.existsSync(full)) continue;
    const html = fs.readFileSync(full, 'utf8');
    const page = pageLabel(file, html);
    for (const sec of topLevelSections(html)) {
      const body = sec.body || '';
      const title = sectionTitle(body);
      const anchor = sec.id || (title && slugify(title.title)) || '';
      if (!anchor) continue;
      // A section may bundle several `<h3 id>`/`<h4 id>` subsections (a feature
      // family). Emit one entry for the section's own intro, then one per
      // subsection, so every family member stays individually searchable and
      // deep-linkable — which lets related features share a home instead of
      // each grabbing its own top-level section.
      const subs = subHeadings(body);
      const introEnd = subs.length ? subs[0].start : body.length;
      entries.push({
        page: file,
        pageLabel: page,
        anchor,
        title: title ? title.title : anchor,
        kind: subs.length ? 'group' : 'section',
        text: snippet(body, title ? title.htmlEnd : 0, introEnd),
      });
      for (let s = 0; s < subs.length; s += 1) {
        const sub = subs[s];
        if (!sub.id) continue;
        const nextStart = s + 1 < subs.length ? subs[s + 1].start : body.length;
        entries.push({
          page: file,
          pageLabel: page,
          anchor: sub.id,
          title: sub.title,
          kind: 'section',
          text: snippet(body, sub.end, nextStart),
        });
      }
    }
  }
  return { generatedAt: new Date().toISOString(), entries };
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const index = build();
fs.writeFileSync(outPath, JSON.stringify(index) + '\n');
console.log(`[build-search-index] ${index.entries.length} entries -> ${outPath}`);
