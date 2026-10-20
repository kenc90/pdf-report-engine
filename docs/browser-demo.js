// Browser demo for pdf-report-engine.
// Loads the pre-bundled engine (pdfkit's standalone browser build included) and renders
// edited constrained-HTML into a real vector PDF, entirely client-side.
import { htmlToReportDoc, renderToBuffer } from './browser/pdf-report-engine.js';

const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const statusEl = document.getElementById('status');
const downloadEl = document.getElementById('download');
const fontInput = document.getElementById('fonts');
const fontListEl = document.getElementById('fontlist');
const pagecountEl = document.getElementById('pagecount');

// Tabs: the editor and the preview share one large panel; flip between them.
const tabEditor = document.getElementById('tab-editor');
const tabPreview = document.getElementById('tab-preview');
const panelEditor = document.getElementById('panel-editor');
const panelPreview = document.getElementById('panel-preview');

function showTab(which) {
  const isEditor = which !== 'preview';
  tabEditor.classList.toggle('active', isEditor);
  tabPreview.classList.toggle('active', !isEditor);
  tabEditor.setAttribute('aria-selected', String(isEditor));
  tabPreview.setAttribute('aria-selected', String(!isEditor));
  panelEditor.classList.toggle('active', isEditor);
  panelPreview.classList.toggle('active', !isEditor);
}
tabEditor.addEventListener('click', () => showTab('editor'));
tabPreview.addEventListener('click', () => showTab('preview'));

// A tiny inline logo so the images feature works with no network / no file access.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAAwCAIAAAA3jserAAAAu0lEQVR42u3SQQ2AMBREwe8AB1hATj1hAitI4YSOGuBCSpu2TPIU7E5c+zpcy5bUoCBDk+BwGBxkwEEGHGTAQQYcZMBBhoIMDYbDMXCQAQcZcJABBxlwkAEHGeoXhw/gIAMOMuAgAw4y4CBDPeCwOBxkwEEGHGTAQYba4jAxHGTAQQYcZKgWDrPCQQYcZMBBhmrhMCUcZMBBhspxWBCO547z1sQFGfoYh+HgIAMOMlSOw15wkKE3OCz1wzKtiMUHl/QIoAAAAABJRU5ErkJggg==';

// Sample dataset that powers the data-bound table below (see data-each/data-bind).
const DEMO_DATA = {
  ledger: [
    { segment: 'Platform', region: 'North America', q: 'Q1', revenue: 8.1, profit: 3.9 },
    { segment: 'Platform', region: 'North America', q: 'Q2', revenue: 9.0, profit: 4.4 },
    { segment: 'Platform', region: 'EMEA', q: 'Q3', revenue: 10.2, profit: 5.1 },
    { segment: 'Analytics', region: 'North America', q: 'Q1', revenue: 6.4, profit: 2.8 },
    { segment: 'Analytics', region: 'APAC', q: 'Q2', revenue: 4.1, profit: 1.3 },
    { segment: 'Services', region: 'EMEA', q: 'Q3', revenue: 7.2, profit: 3.0 },
    { segment: 'Services', region: 'APAC', q: 'Q4', revenue: 3.9, profit: 1.1 },
    { segment: 'Retail', region: 'North America', q: 'Q4', revenue: 11.6, profit: 6.2 },
    { segment: 'Retail', region: 'EMEA', q: 'Q4', revenue: 6.8, profit: 3.2 },
    { segment: 'Retail', region: 'APAC', q: 'Q3', revenue: 4.8, profit: 2.0 },
  ],
};

// Default report — deliberately exercises most of the library's authoring features:
// Google Fonts, page bands + running tokens, a title/summary band, KPI cards (borderless
// tables), rich inline formatting, an embedded image, a data-bound striped/gridded table,
// merged cells, a page break, and base-14 fallback.
const DEFAULT_HTML = `<!-- ══ Web fonts straight from the HTML: the engine collects the charset from
     the IR, passes it as text= to Google's CSS API, fetches only the needed glyphs (tiny subset),
     and embeds them. In Node a bot UA yields TTF directly; in a browser WOFF2 is decoded. ══ -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto+Slab:wght@400;700&family=Noto+Sans+SC:wght@400&display=swap" rel="stylesheet">

<body style="font-family:Inter; font-size:10pt; color:#24303f">

<!-- ══ Page bands: repeated on every page; {PAGE}/{TOTAL} resolve per page. ══ -->
<header data-band="pageHeader" style="font-size:8pt; color:#94a3b8; letter-spacing:2pt; text-transform:uppercase; border-bottom:1pt solid #e2e8f0; padding-bottom:3pt">Northwind Group &middot; Quarterly Report</header>
<footer data-band="pageFooter" style="font-size:8pt; color:#94a3b8">
  <table style="border:0; width:100%">
    <tr>
      <td style="text-align:left">pdf-report-engine &middot; vector &amp; selectable text</td>
      <td style="text-align:right">Page {PAGE} of {TOTAL}</td>
    </tr>
  </table>
</footer>

<!-- ══ Cover: a "title" band (once, on page 1) with an embedded image + two Google families. ══ -->
<section data-band="title">
  <img src="${LOGO}" width="150" style="text-align:left">
  <table style="border:0; width:100%">
    <tr>
      <td style="background:#0f2f57; color:#ffffff; padding:16pt">
        <p style="font-family:'Roboto Slab'; font-size:23pt; font-weight:700; margin:0">Quarterly Snapshot</p>
        <p style="font-size:10.5pt; color:#9fc0e6; letter-spacing:1pt; margin-top:6pt">Revenue, growth and highlights — rendered as a real, paginated PDF entirely in your browser.</p>
      </td>
    </tr>
    <tr><td style="background:#e08a1e; height:4pt"></td></tr>
  </table>
</section>

<!-- ══ KPI cards: a borderless table of coloured cells (no CSS grid/float — tables do layout). ══ -->
<p style="font-size:8pt; letter-spacing:2pt; text-transform:uppercase; color:#94a3b8; margin-top:14pt">At a glance</p>
<table style="border:0; width:100%">
  <tr>
    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#0f2f57">$72.1M</span><br><span style="font-size:8pt; letter-spacing:1pt; text-transform:uppercase; color:#64748b">Revenue</span></td>
    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#1b7f4b">+18.4%</span><br><span style="font-size:8pt; letter-spacing:1pt; text-transform:uppercase; color:#64748b">YoY Growth</span></td>
    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#b45309">$28.3M</span><br><span style="font-size:8pt; letter-spacing:1pt; text-transform:uppercase; color:#64748b">Net Profit</span></td>
    <td style="background:#f3f6fb; border:1pt solid #dbe6f4; padding:10pt; text-align:center"><span style="font-size:17pt; font-weight:700; color:#7c2d12">1,240</span><br><span style="font-size:8pt; letter-spacing:1pt; text-transform:uppercase; color:#64748b">Headcount</span></td>
  </tr>
</table>

<!-- ══ Rich inline formatting + base-14 Latin-1 coverage. ══ -->
<h2 style="font-family:'Roboto Slab'; color:#0f2f57; border-bottom:2pt solid #e08a1e; padding-bottom:4pt">Highlights</h2>
<p style="line-height:1.5; color:#334155">
  Every glyph is <strong>vector and selectable</strong>. Inline styling covers <em>italics</em>,
  <u>underline</u>, <span style="color:#1b7f4b; font-weight:700">coloured emphasis</span>, and a
  <a href="#">link</a>. With no web font in play, the base-14 face still renders Latin-1 &amp; symbols:
  é ñ ü ß · ± × ½ © ° § ¶ —. Headings use <strong>Roboto Slab</strong>, fetched from Google Fonts on the client.
</p>

<!-- ══ CJK / Chinese: rendered via charset-aware subsetting — the engine collects the CJK
     characters from the IR, passes them as text= to Google Fonts, and receives a tiny subset
     containing only those glyphs. Mixed CJK + Latin with no manual font switching. ══ -->
<h2 style="font-family:'Noto Sans SC'; color:#0f2f57; border-bottom:2pt solid #e08a1e; padding-bottom:4pt">中文示例 - Chinese</h2>
<p style="font-family:'Noto Sans SC'; line-height:1.6; color:#334155">
  本报告完全在浏览器端以纯 JavaScript 渲染成真实的矢量 PDF，文字可选取、可搜索，并支持中日韩字形与逐字符字体回退。
</p>

<!-- ══ Data-bound table: rows generated from a JSON dataset (data-each), each cell filled by
     data-bind, numbers via data-format. Striped + gridded. Provided to the demo harness. ══ -->
<h2 style="font-family:'Roboto Slab'; color:#0f2f57; border-bottom:2pt solid #e08a1e; padding-bottom:4pt">Ledger by segment</h2>
<p style="font-size:8.5pt; color:#94a3b8">Bound from an in-memory dataset (values in $M). Edit <code>DEMO_DATA</code> in <code>browser-demo.js</code> to change the rows.</p>
<table data-each="line in $data.ledger" data-grid="0.5pt solid #e5eaf1" data-striped>
  <thead>
    <tr style="background:#0f2f57; color:#ffffff; text-transform:uppercase; font-size:8pt; letter-spacing:1pt">
      <th style="padding:5pt; text-align:left">Segment</th>
      <th style="padding:5pt; text-align:left">Region</th>
      <th style="padding:5pt; text-align:center">Q</th>
      <th style="padding:5pt; text-align:right">Revenue&nbsp;$M</th>
      <th style="padding:5pt; text-align:right">Profit&nbsp;$M</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:4pt" data-bind="segment"></td>
      <td style="padding:4pt" data-bind="region"></td>
      <td style="padding:4pt; text-align:center" data-bind="q"></td>
      <td style="padding:4pt; text-align:right" data-bind="revenue" data-format="#,##0.0"></td>
      <td style="padding:4pt; text-align:right; color:#1b7f4b; font-weight:700" data-bind="profit" data-format="#,##0.0"></td>
    </tr>
  </tbody>
</table>

<!-- ══ Merged cells: colspan + rowspan render as a single aligned grid. ══ -->
<h2 style="font-family:'Roboto Slab'; color:#0f2f57; border-bottom:2pt solid #e08a1e; padding-bottom:4pt">Merged cells</h2>
<table data-grid="1px solid #b8c4d4">
  <tr><th colspan="3" style="background:#dce6f2; color:#0f2f57; padding:6pt; text-align:center">A banner spanning three columns</th></tr>
  <tr>
    <td rowspan="2" style="padding:6pt; background:#f8fafc; font-weight:700">2026</td>
    <td style="padding:6pt">January</td><td style="padding:6pt; text-align:right">$400</td>
  </tr>
  <tr><td style="padding:6pt">February</td><td style="padding:6pt; text-align:right">$600</td></tr>
</table>

<hr>

<!-- ══ A forced page break — the footer now reads "Page 2 of 2". ══ -->
<h2 style="break-before:page; font-family:'Roboto Slab'; color:#0f2f57; border-bottom:2pt solid #e08a1e; padding-bottom:4pt">On the second page</h2>
<p style="color:#334155; line-height:1.5">
  This heading began a new page via <code>break-before: page</code>, proving real pagination.
  The repeating <strong>pageHeader</strong>/<strong>pageFooter</strong> bands and the running
  <code>{PAGE}</code>/<code>{TOTAL}</code> tokens resolve per page. Want CJK? Load a Latin
  <em>and</em> a CJK font above — then mixed text like <strong>陳大文 test</strong> falls back
  glyph-by-glyph to whichever registered face covers each character, no <code>font-family</code> needed.
</p>

<!-- ══ Summary band: painted once at the bottom of the last page. ══ -->
<section data-band="summary" style="border-top:2pt solid #0f2f57; padding-top:8pt; font-weight:700; color:#0f2f57">
  Grand total revenue: $72.1M — produced by pdf-report-engine (no server, no Chromium).
</section>

</body>`;

editor.value = DEFAULT_HTML;

// ---- font selection ------------------------------------------------------
const WEIGHTS = {
  thin: 100, hairline: 100, light: 300, regular: 400, normal: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, black: 900, heavy: 900,
};
let selectedFonts = [];

function parseFontFile(file) {
  const stem = file.name.replace(/\.(ttf|otf|ttc)$/i, '');
  let family = stem;
  let weight = 400;
  let style = 'normal';
  const m = /[-_ ](Regular|Book|Normal|Light|Thin|Hairline|Medium|SemiBold|Demibold|Bold|Black|Heavy|Italic|Oblique)\b/i.exec(stem);
  if (m) {
    family = stem.slice(0, m.index).replace(/[-_ ]$/, '');
    const tok = m[1].toLowerCase();
    if (tok === 'italic' || tok === 'oblique') style = 'italic';
    else weight = WEIGHTS[tok] ?? 400;
  }
  return file.arrayBuffer().then((buf) => ({ family, weight, style, buffer: new Uint8Array(buf) }));
}

function renderFontList() {
  if (!selectedFonts.length) {
    fontListEl.textContent = 'No fonts selected — using base-14 (Latin-1) plus any Google Fonts in the HTML.';
    return;
  }
  fontListEl.textContent = '';
  fontListEl.append(document.createTextNode('Registered: '));
  selectedFonts.forEach((f, i) => {
    const code = document.createElement('code');
    code.textContent = `${f.family} ${f.weight}${f.style === 'italic' ? ' i' : ''}`;
    if (i) fontListEl.append(document.createTextNode(' '));
    fontListEl.append(code);
  });
}

async function loadSelectedFonts() {
  const files = Array.from(fontInput.files ?? []);
  if (!files.length) {
    selectedFonts = [];
    renderFontList();
    return;
  }
  status('Reading font files…');
  try {
    selectedFonts = await Promise.all(files.map(parseFontFile));
    renderFontList();
    status('');
  } catch (err) {
    selectedFonts = [];
    renderFontList();
    status('Could not read fonts: ' + err.message, true);
  }
}

fontInput.addEventListener('change', loadSelectedFonts);
document.getElementById('clearfonts').addEventListener('click', () => {
  fontInput.value = '';
  selectedFonts = [];
  renderFontList();
});

// ---- generate ------------------------------------------------------------
let lastUrl = null;

/** Count page objects in the produced PDF (for the preview tab badge). */
function countPages(bytes) {
  let latin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) latin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return (latin.match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

async function generate() {
  status('Rendering PDF…');
  downloadEl.hidden = true;
  pagecountEl.hidden = true;
  try {
    const report = htmlToReportDoc(editor.value, { data: DEMO_DATA });
    // Charset-aware fetching: the engine scans the IR, passes the needed glyphs as text=
    // to Google's CSS API, and receives only a tiny subset. No manual font subsetting
    // or safety-net inline fonts required — remote WOFF2 is decoded via wawoff2.
    const bytes = await renderToBuffer(report, {
      fonts: [...selectedFonts],
      resolveFonts: { decodeTimeoutMs: 6000 },
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    lastUrl = URL.createObjectURL(blob);
    preview.src = lastUrl;
    downloadEl.href = lastUrl;
    downloadEl.hidden = false;
    const pages = countPages(bytes);
    if (pages) {
      pagecountEl.textContent = `${pages}p`;
      pagecountEl.hidden = false;
    }
    status(`Done — ${pages} page(s), ${(bytes.byteLength / 1024).toFixed(1)} KB. Showing the PDF preview tab.`);
    showTab('preview');
  } catch (err) {
    status('Error: ' + (err && err.message ? err.message : String(err)), true);
    console.error(err);
  }
}

document.getElementById('generate').addEventListener('click', generate);
document.getElementById('reset').addEventListener('click', () => {
  editor.value = DEFAULT_HTML;
  showTab('editor');
  status('HTML reset to the sample report.');
});

function status(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

// Render once on load so the preview tab is populated immediately.
generate();
