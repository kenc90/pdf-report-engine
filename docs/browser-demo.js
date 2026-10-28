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
  // The overlay/gutter cannot scroll while hidden, so re-sync on reveal.
  if (isEditor) syncScroll();
}
tabEditor.addEventListener('click', () => showTab('editor'));
tabPreview.addEventListener('click', () => { showTab('preview'); generate(); });

// Detach / attach: expand the workbench so the active panel fills the whole
// viewport (still one tab at a time — no split), or collapse it back to the inline
// height. The `.detached` CSS (browser-demo.html) drives the layout; this flips state.
const workbenchSection = document.getElementById('workbench');
const detachBtn = document.getElementById('detach');
const detachLabel = document.getElementById('detach-label');
let detached = false;

function setDetached(on) {
  detached = on;
  workbenchSection.classList.toggle('detached', on);
  document.body.classList.toggle('detached', on);
  detachBtn.setAttribute('aria-pressed', String(on));
  detachLabel.textContent = on ? 'Attach' : 'Detach';
  detachBtn.title = on
    ? 'Attach back into the page (Esc)'
    : 'Detach to fill the page with the editor / preview (Esc to re-attach)';
  // The panels' height changed — realign the colour overlay and gutter with the textarea.
  syncScroll();
}
detachBtn.addEventListener('click', () => setDetached(!detached));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detached) setDetached(false); });

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
// Google Fonts, a <style> sheet with tag/class/id selectors, page bands + running tokens,
// a title/summary band, a generated TOC, KPI cards (borderless tables), vector charts
// (bar/line/area/pie/donut, combo, 100% stacked, waterfall, plus the new
// scatter/bubble/radar/gauge/heatmap kinds with range bars and reference lines laid out
// in display:flex rows), SVG vector images (inline <svg> and an even-odd ring),
// rich inline formatting (highlights +
// links), an embedded image, a data-bound table with conditional formatting and
// colour-scale heatmaps, rich block cells (image / QR / sparkline / nested table),
// merged cells, a diagonal corner-header two-way (cross-tab) table, QR/Code 128/EAN-13
// barcodes, a page break, and base-14 fallback; plus the six new features: hyperlinks,
// rich inline text, a rotated page watermark (rendered as non-selectable vector outlines
// on the foreground layer), multi-column layout, a Gantt timeline chart,
// absolute positioning with z-index (a page-1 stamp, a behind-body wash, and a fixed
// per-page badge), and streaming output (see renderToStream in the API docs).
const DEFAULT_HTML = `<!-- ══ Web fonts straight from the HTML: the engine collects the charset from
     the IR, passes it as text= to Google's CSS API, fetches only the needed glyphs (tiny subset),
     and embeds them. In Node a bot UA yields TTF directly; in a browser WOFF2 is decoded. ══ -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto+Slab:wght@400;700&family=Noto+Sans+SC:wght@400&display=swap" rel="stylesheet">

<!-- ══ A real stylesheet: tag / class / id selectors with CSS specificity.
     Inline style still wins over these rules. ══ -->
<style>
  .section-title { font-family: 'Roboto Slab'; color: #0f2f57; border-bottom: 2pt solid #e08a1e; padding-bottom: 4pt; }
  #ledger { color: #1b4d3e; }                 /* id beats class */
  .callout { background-color: #fff7e6; padding: 6pt; }
  mark { background-color: #ffe08a; }          /* tag selector */

  /* Absolute positioning & z-index: position:absolute/fixed lift an element out of the flow and
     place it at page coordinates (top/left in pt|mm|%, origin = page top-left). z-index < 0 paints
     behind the body text, >= 0 in front. 'absolute' targets one page (data-page, default 1);
     'fixed' repeats on every page. rotate (degrees, about the block's own centre) is set either with
     CSS transform: rotate() or the data-rotate attribute. These overlays take no flow space. */
  .pos-wash  { position:absolute; left:146mm; top:278mm; width:56mm; height:15mm; background:#fff2cc; z-index:-1; }
  .pos-stamp { position:absolute; left:149mm; top:279mm; width:50mm; text-align:center;
               transform:rotate(-12deg); border:2pt solid #b45309; color:#b45309; background:#ffffffd9;
               padding:2pt 0; font-weight:700; font-size:10pt; letter-spacing:2pt; z-index:5; }
  .pos-tab   { position:fixed; left:8mm; top:278mm; width:70mm; text-align:left;
               background:#0f2f57; color:#ffffff; font-size:7pt; letter-spacing:1pt; padding:2pt 5pt; z-index:2; }
</style>

<body data-watermark="SAMPLE" data-watermark-rotate="-35" data-watermark-size="72" data-watermark-color="#c0c0c0" data-watermark-opacity="0.22" data-watermark-layer="foreground" style="font-family:Inter; font-size:10pt; color:#24303f">

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

<!-- ══ Absolute positioning & z-index: a tinted wash painted BEHIND the body (z-index:-1, tilted
     via the data-rotate attribute), an APPROVED stamp in FRONT on page 1 only (z-index:5, tilted via
     CSS transform: rotate), and a fixed badge that repeats in the bottom margin of every page. All
     three are lifted out of the flow — no space is reserved. ══ -->
<div class="pos-wash" data-rotate="-12"></div>
<div class="pos-stamp">APPROVED</div>
<div class="pos-tab">pdf-report-engine &middot; pure JS</div>

<!-- ══ Generated TOC: dot leaders, real page numbers and clickable rows. Headings
     carry ids so every row has a destination. ══ -->
<div data-toc data-title="Contents" data-level="2" style="margin-top:16pt; margin-bottom:2pt"></div>

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

<!-- ══ Vector charts from plain attributes — no canvas, no images. ══ -->
<h2 id="charts" class="section-title">Charts</h2>
<div data-chart="bar" data-title="Revenue by quarter ($M)" data-categories="Q1 25,Q2 25,Q3 25,Q4 25,Q1 26,Q2 26"
     data-series="Revenue:58.2,61.4,63.1,66.8,69.5,72.1" data-legend="none" data-show-values="true"
     data-value-format="#,##0.0" style="height:140pt; margin-top:12pt"></div>

<div data-chart="line" data-title="Revenue vs. cost ($M)" data-categories="Q1 25,Q2 25,Q3 25,Q4 25,Q1 26,Q2 26"
     data-series="Revenue:58.2,61.4,63.1,66.8,69.5,72.1; Cost:41.0,42.6,43.4,45.1,46.2,43.8"
     data-legend="bottom" data-min="35" data-max="80" data-ticks="5" data-value-format="#,##0.0"
     style="height:140pt; margin-top:10pt"></div>

<!-- A <table data-chart> is plotted straight from its own rows: header = series, first column = categories. -->
<table data-chart="area" data-title="Headcount by segment (stacked)" data-stacked="true"
       data-colors="#0f2f57,#1b7f4b,#e08a1e" style="height:130pt; margin-top:10pt">
  <thead><tr><th>Quarter</th><th>Platform</th><th>Analytics</th><th>Services</th></tr></thead>
  <tbody>
    <tr><td>Q3 25</td><td>420</td><td>310</td><td>280</td></tr>
    <tr><td>Q4 25</td><td>445</td><td>330</td><td>295</td></tr>
    <tr><td>Q1 26</td><td>470</td><td>352</td><td>300</td></tr>
    <tr><td>Q2 26</td><td>505</td><td>378</td><td>357</td></tr>
  </tbody>
</table>

<div data-chart="pie" data-title="Channel mix" data-categories="Direct,Partner,Retail,Online"
     data-values="37,25,22,16" data-legend="right" style="height:130pt; margin-top:10pt"></div>

<div data-chart="donut" data-title="Revenue mix" data-categories="Platform,Analytics,Services,Retail"
     data-values="38,26,19,17" data-legend="right" data-inner-radius="0.6" style="height:140pt; margin-top:10pt"></div>

<!-- ══ Chart depth: combo with a right-hand axis, 100% stacking, and a waterfall. ══ -->
<div data-chart="combo" data-title="Revenue (bars) vs. margin (line)" data-categories="Q1 25,Q2 25,Q3 25,Q4 25,Q1 26,Q2 26"
     data-series="Revenue:58.2,61.4,63.1,66.8,69.5,72.1; Margin:18.2,19.1,20.4,22.6,23.8,24.9"
     data-series-types="bar,line" data-series-axes="left,right"
     data-right-min="0" data-right-max="30" data-right-format='0"%"'
     data-value-format="#,##0.0" data-legend="bottom" style="height:150pt; margin-top:10pt"></div>

<div data-chart="bar" data-title="Revenue mix by year (100% stacked)" data-categories="2023,2024,2025,2026"
     data-series="Platform:38,42,47,53; Analytics:24,26,28,29; Services:22,20,17,14; Retail:16,12,8,4"
     data-stacked="100%" data-show-values="true" data-value-format='0"%"'
     data-colors="#0f2f57,#1b7f4b,#e08a1e,#7c2d12" data-legend="bottom" style="height:150pt; margin-top:10pt"></div>

<div data-chart="waterfall" data-title="Cash bridge: FY26 ($M)" data-categories="Opening,Revenue,Costs,Tax,Closing"
     data-values="42,72,-38,-6,0" data-totals="0,4" data-show-values="true"
     data-waterfall-colors="increase=#15803d; decrease=#b91c1c; total=#0f2f57"
     data-value-format="#,##0.0" style="height:150pt; margin-top:10pt"></div>

<!-- ══ New chart kinds: scatter (with a reference line), radar, gauge and a heatmap. ══ -->
<h2 id="newcharts" class="section-title">New chart kinds</h2>
<div style="display:flex; gap:10pt; align-items:stretch; margin-top:10pt">
  <div data-chart="scatter" data-title="Latency vs. load" data-x-format="#,##0"
       data-series="P95:120,180,240,210,300" data-series-x="10,20,30,40,50"
       data-reference-lines="250:SLO,color=#c00,dash=3:2"
       style="height:150pt; flex:1 1 48%"></div>
  <div data-chart="radar" data-title="Vehicle comparison"
       data-categories="Speed,Power,Range,Grip,Comfort,Value"
       data-series="Car A:80,60,70,90,75,65; Car B:70,85,55,65,88,72"
       data-legend="right" style="height:150pt; flex:1 1 48%"></div>
</div>
<div style="display:flex; gap:10pt; align-items:stretch; margin-top:10pt">
  <div data-chart="gauge" data-title="SLA compliance" data-gauge-value="72" data-gauge-max="100"
       data-series="score:72" style="height:130pt; flex:1 1 32%"></div>
  <div data-chart="gauge" data-title="Uptime %" data-gauge-value="99.2" data-gauge-max="100"
       data-series="up:99.2" style="height:130pt; flex:1 1 32%"></div>
  <div data-chart="bar" data-title="Daily range (&deg;C)" data-range="true"
       data-categories="Mon,Tue,Wed,Thu" data-series-low="12,14,10,15" data-series-high="24,26,20,23"
       data-reference-lines="22:warning,color=#c00" style="height:130pt; flex:1 1 32%"></div>
</div>
<div data-chart="heatmap" data-title="Weekly activity by shift" data-categories="Mon,Tue,Wed,Thu,Fri,Sat"
     data-series="Morning:3,5,8,4,2,6; Afternoon:6,7,4,9,5,3; Evening:2,3,5,7,8,4"
     data-heatmap-colors="from=#eef4ff;to=#1e3a8a" style="height:150pt; margin-top:10pt"></div>

<!-- ══ Gantt timeline: task bars on a time axis, L-shaped dependency arrows, progress fills. ══ -->
<h2 id="gantt" class="section-title">Gantt timeline</h2>
<p style="font-size:8.5pt; color:#94a3b8">A <code>data-chart="gantt"</code> block plots project tasks with dependencies and progress. Format: <code>name:start:end[:color][:progress][:deps]</code>.</p>
<div data-chart="gantt" data-title="Product launch plan (weeks)" data-gantt-unit="week"
     data-gantt-start="0" data-gantt-end="14"
     data-gantt-tasks="Discovery:0:2:#0f2f57:1;Design:2:5:#7c3aed:0.6;Backend:4:9:#1b7f4b:0.35:1;Frontend:5:10:#e08a1e:0.4:1;Integration:9:12:#06b6d4:0.1:2,3;UAT:11:13:#b91c1c:0:5;Launch:13:14:#0f2f57:0:4,5,6"
     style="height:220pt; margin-top:10pt"></div>

<!-- ══ Multi-column layout: column-count splits children into N equal-width columns with
     optional rules between them. ══ -->
<h2 id="columns" class="section-title">Multi-column layout</h2>
<p style="font-size:8.5pt; color:#94a3b8">A plain <code>&lt;div style="column-count:2"&gt;</code> becomes a <code>ColumnBlock</code> — the same IR node the JS API uses.</p>
<div style="column-count:2; column-gap:16pt; border-left:0; margin-top:8pt">
  <h3 style="font-size:11pt; color:#0f2f57; margin:0 0 4pt 0">Why columns?</h3>
  <p style="font-size:9pt; line-height:1.5; margin:0 0 6pt 0">Reports often need narrow measure text — think newspaper columns, methodology notes paired with headline findings, or side-by-side commentary.</p>
  <p style="font-size:9pt; line-height:1.5; margin:0">The engine distributes fragments across N equal-width sub-columns by height, keeping the block atomic so pagination can push the whole thing to a new page.</p>
</div>
<div style="column-count:3; column-gap:10pt; margin-top:12pt">
  <p style="font-size:8.5pt; margin:0"><strong>Q1</strong><br>Revenue up 18.4% YoY, driven by platform renewals.</p>
  <p style="font-size:8.5pt; margin:0"><strong>Q2</strong><br>Analytics ARR crossed $18M with 24% net retention.</p>
  <p style="font-size:8.5pt; margin:0"><strong>Q3</strong><br>Services margin expanded after the delivery-tooling push.</p>
</div>

<!-- ══ SVG vector images: inline <svg> drawn as real PDF paths, no rasterisation. ══ -->
<h2 id="vectors" class="section-title">SVG &amp; flexbox</h2>
<p style="font-size:8.5pt; color:#94a3b8">This row is a <code>display:flex</code> container; each icon below is inline <code>&lt;svg&gt;</code> emitting true vector paths.</p>
<div style="display:flex; justify-content:space-around; align-items:center; gap:12pt; margin-top:8pt">
  <svg viewBox="0 0 24 24" width="52" height="52">
    <circle cx="12" cy="12" r="11" fill="#0f2f57"/>
    <path d="M7 12.5l3 3 7-7" stroke="#ffffff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <svg viewBox="0 0 24 24" width="52" height="52">
    <path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.7 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z" fill="#e08a1e"/>
  </svg>
  <!-- fill-rule="evenodd": the inner circle subpath punches a real hole. -->
  <svg viewBox="0 0 24 24" width="52" height="52">
    <path fill-rule="evenodd" fill="#1b7f4b"
          d="M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22z M12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/>
  </svg>
  <svg viewBox="0 0 24 24" width="52" height="52">
    <g transform="rotate(45 12 12)"><rect x="6" y="6" width="12" height="12" rx="2" fill="#7c2d12" opacity="0.85"/></g>
  </svg>
</div>

<!-- ══ Rich inline formatting + base-14 Latin-1 coverage. ══ -->
<h2 id="highlights" class="section-title">Highlights</h2>
<p style="line-height:1.5; color:#334155">
  Every glyph is <strong>vector and selectable</strong>. Inline styling covers <em>italics</em>,
  <u>underline</u>, <span style="color:#1b7f4b; font-weight:700">coloured emphasis</span>,
  <mark>highlighted runs</mark>, an <a href="https://example.com">external link</a>, and an
  <a href="#ledger">internal jump</a>. With no web font in play, the base-14 face still renders Latin-1 &amp; symbols:
  é ñ ü ß · ± × ½ © ° § ¶ —. Headings use <strong>Roboto Slab</strong>, fetched from Google Fonts on the client.
</p>

<!-- ══ CJK / Chinese: rendered via charset-aware subsetting — the engine collects the CJK
     characters from the IR, passes them as text= to Google Fonts, and receives a tiny subset
     containing only those glyphs. Mixed CJK + Latin with no manual font switching. ══ -->
<h2 id="chinese" class="section-title">中文示例 - Chinese</h2>
<p style="font-family:'Noto Sans SC'; line-height:1.6; color:#334155">
  本报告完全在浏览器端以纯 JavaScript 渲染成真实的矢量 PDF，文字可选取、可搜索，并支持中日韩字形与逐字符字体回退。
</p>

<!-- ══ Data-bound table with conditional formatting: rows under $5M revenue turn red
     (data-when on the <tr>), while revenue/profit cells paint data-color-scale heatmaps. ══ -->
<h2 id="ledger" class="section-title">Ledger by segment</h2>
<p class="callout" style="font-size:8.5pt; margin:6pt 0"
   data-if="$data.ledger.length &gt; 0"
   data-when="$data.ledger.length &gt;= 10"
   data-when-style="border-left:3pt solid #e08a1e; padding-left:8pt">
  <strong>Conditional formatting.</strong> Rows below $5M revenue turn red; the money columns are
  <code>data-color-scale</code> heatmaps that switch their text to white on dark fills. Rows come from
  <code>DEMO_DATA</code> in <code>browser-demo.js</code> (values in $M).
</p>
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
    <tr data-when="$row.revenue &lt; 5" data-when-style="color:#b91c1c">
      <td style="padding:4pt" data-bind="segment"></td>
      <td style="padding:4pt" data-bind="region"></td>
      <td style="padding:4pt; text-align:center" data-bind="q"></td>
      <td style="padding:4pt; text-align:right" data-bind="revenue" data-format="#,##0.0"
          data-color-scale="from=#eef4ff; to=#1e3a8a"></td>
      <td style="padding:4pt; text-align:right; font-weight:700" data-bind="profit" data-format="#,##0.0"
          data-color-scale="min=0; max=12; from=#fee2e2; to=#15803d"></td>
    </tr>
  </tbody>
</table>

<!-- ══ Merged cells: colspan + rowspan render as a single aligned grid. ══ -->
<h2 id="merged" class="section-title">Merged cells</h2>
<table data-grid="1px solid #b8c4d4">
  <tr><th colspan="3" style="background:#dce6f2; color:#0f2f57; padding:6pt; text-align:center">A banner spanning three columns</th></tr>
  <tr>
    <td rowspan="2" style="padding:6pt; background:#f8fafc; font-weight:700">2026</td>
    <td style="padding:6pt">January</td><td style="padding:6pt; text-align:right">$400</td>
  </tr>
  <tr><td style="padding:6pt">February</td><td style="padding:6pt; text-align:right">$600</td></tr>
</table>

<!-- ══ Diagonal corner header: a two-way (cross-tabulation) table. The corner cell
     splits into two triangles with a slash — the column axis names the upper one
     (the cell's own text) and data-diagonal-bottom names the row axis. ══ -->
<h2 id="twoway" class="section-title">Two-way table</h2>
<p style="font-size:8.5pt; color:#94a3b8">A <code>data-diagonal</code> corner cell: one label per triangle, split by a corner-to-corner slash.</p>
<table data-grid="1.5px solid #1a1a1a" style="border-collapse:collapse">
  <thead>
    <tr>
      <th data-diagonal data-diagonal-bottom="Gender" style="background:#e6efdc; font-weight:bold; padding:10pt 8pt; text-align:center">Preferred Pet</th>
      <th style="background:#e6efdc; font-weight:bold; padding:10pt 8pt; text-align:center">Dog</th>
      <th style="background:#e6efdc; font-weight:bold; padding:10pt 8pt; text-align:center">Cat</th>
      <th style="background:#e6efdc; font-weight:bold; padding:10pt 8pt; text-align:center">Other</th>
      <th style="background:#e6efdc; font-weight:bold; padding:10pt 8pt; text-align:center">TOTAL</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">Girl</td>
      <td style="padding:8pt; text-align:center">2</td><td style="padding:8pt; text-align:center">5</td><td style="padding:8pt; text-align:center">1</td><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">8</td>
    </tr>
    <tr>
      <td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">Boy</td>
      <td style="padding:8pt; text-align:center">4</td><td style="padding:8pt; text-align:center">3</td><td style="padding:8pt; text-align:center">2</td><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">9</td>
    </tr>
    <tr>
      <td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">Total</td>
      <td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">6</td><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">8</td><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">3</td><td style="background:#e6efdc; font-weight:bold; padding:8pt; text-align:center">17</td>
    </tr>
  </tbody>
</table>

<!-- ══ Rich cells: a <td> holds flow blocks — embedded image, vector QR, a 40pt sparkline
     chart or a nested table. The row grows to whichever cell is tallest. ══ -->
<h2 id="rich" class="section-title">Rich table cells</h2>
<p style="font-size:8.5pt; color:#94a3b8">Any cell can stack blocks; rows stay atomic. Brand = embedded image, Scan = vector QR/EAN, H1 trend = a chart, Packages = a nested table.</p>
<table style="border:1px solid #dbe6f4">
  <thead>
    <tr style="background:#0f2f57; color:#ffffff; font-size:8pt; text-transform:uppercase; letter-spacing:1pt">
      <th style="padding:5pt; text-align:left">Account</th>
      <th style="padding:5pt; text-align:center">Brand</th>
      <th style="padding:5pt; text-align:center">Scan</th>
      <th style="padding:5pt; text-align:center">H1 trend</th>
      <th style="padding:5pt; text-align:left">Packages</th>
      <th style="padding:5pt; text-align:right">Revenue</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:6pt"><strong>Northwind Retail</strong><br><span style="font-size:8pt; color:#94a3b8">Enterprise &middot; EMEA</span></td>
      <td style="padding:4pt; text-align:center"><img src="${LOGO}" style="width:52pt"></td>
      <td style="padding:4pt; text-align:center"><div data-barcode="qr" data-value="NW-RETAIL-001" data-module-size="1.2" data-quiet-zone="1"></div></td>
      <td style="padding:4pt"><div data-chart="bar" data-values="4,6,5,8,9,12" data-categories="Jan,Feb,Mar,Apr,May,Jun" data-category-labels="false" data-axis-labels="false" data-grid-lines="false" data-legend="none" data-colors="#0f2f57,#7fb2e5" style="height:40pt"></div></td>
      <td style="padding:6pt"><table style="border:0; font-size:8pt"><tr><td style="padding:0; color:#64748b">Core</td><td style="padding:0; text-align:right; font-weight:700">14</td></tr><tr><td style="padding:0; color:#64748b">Add-ons</td><td style="padding:0; text-align:right; font-weight:700">6</td></tr></table></td>
      <td style="padding:6pt; text-align:right; font-weight:700">$1,284,000</td>
    </tr>
    <tr>
      <td style="padding:6pt"><strong>Contoso Health</strong><br><span style="font-size:8pt; color:#94a3b8">Mid-market &middot; APAC</span></td>
      <td style="padding:4pt; text-align:center"><img src="${LOGO}" style="width:52pt"></td>
      <td style="padding:4pt; text-align:center"><div data-barcode="ean13" data-value="400638133393" data-module-size="0.9" data-show-text="false"></div></td>
      <td style="padding:4pt"><div data-chart="line" data-values="5,6,7,7,9,11" data-categories="Jan,Feb,Mar,Apr,May,Jun" data-category-labels="false" data-axis-labels="false" data-grid-lines="false" data-legend="none" data-colors="#1b7f4b" style="height:40pt"></div></td>
      <td style="padding:6pt"><table style="border:0; font-size:8pt"><tr><td style="padding:0; color:#64748b">Core</td><td style="padding:0; text-align:right; font-weight:700">9</td></tr><tr><td style="padding:0; color:#64748b">Add-ons</td><td style="padding:0; text-align:right; font-weight:700">2</td></tr></table></td>
      <td style="padding:6pt; text-align:right; font-weight:700">$964,000</td>
    </tr>
  </tbody>
</table>

<!-- ══ Vector QR / barcodes: every module is a real rectangle — no image, no canvas. ══ -->
<h2 id="codes" class="section-title">Machine-readable codes</h2>
<p class="callout">Scan the QR code to open the live report, or read the serial and product code.</p>
<div data-barcode="qr" data-value="https://example.com/reports/2026-Q3"
     data-module-size="2" data-error-correction="Q" style="margin-top:8pt"></div>
<div data-barcode="code128" data-value="RPT-2026-Q3-0042" data-color="#0f2f57" style="height:34pt"></div>
<div data-barcode="ean13" data-value="590123412345"></div>

<hr>

<!-- ══ A forced page break — the heading starts a new page and the footer total updates. ══ -->
<h2 id="second" class="section-title" style="break-before:page">After the forced page break</h2>
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

// Remember the user's HTML between visits; fall back to the sample report.
const STORAGE_KEY = 'pdf-report-engine:browser-demo:html';
function restoreEditor() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved;
  } catch {}
  return DEFAULT_HTML;
}
function persistEditor() {
  try { localStorage.setItem(STORAGE_KEY, editor.value); } catch {}
}
editor.value = restoreEditor();

// ---- editor chrome: line numbers + HTML/CSS colours -----------------------
// The textarea keeps the real text (native editing, undo, selection, a11y). A
// colourised <pre> sits underneath it and the textarea's own text is transparent,
// so the page reads like an editor without a third-party component. Gutter,
// overlay and textarea scroll in lockstep.
const highlightEl = document.getElementById('highlight');
const highlightCode = highlightEl.querySelector('code');
const gutterEl = document.getElementById('gutter');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrap = (cls, text) => `<span class="tok-${cls}">${esc(text)}</span>`;

/** Colour `&amp;` / `&nbsp;` style entities inside a plain-text run. */
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

/** First matching rule wins; characters no rule accepts take `fallback`. */
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
  [/^\s+/, null],                          // whitespace between attributes
  [/^"[^"]*"?|^'[^']*'?/, 'string'],       // attribute value (even while typing)
  [/^[A-Za-z_:@][-.:\w@]*/, 'attr'],       // attribute name
  [/^[=/>]/, 'punct'],                     // `=`, the `/` of `/>`, `>`
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

/** Small CSS lexer for `<style>` bodies: comments, at-rules, props, values, selectors. */
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

function htmlTokens(src) {
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
    // Tag: walk to the closing `>`, ignoring `>` inside quoted attribute values.
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
    // `<style>` bodies get their own pass; everything else stays HTML.
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

function syncScroll() {
  highlightEl.scrollTop = editor.scrollTop;
  highlightEl.scrollLeft = editor.scrollLeft;
  gutterEl.scrollTop = editor.scrollTop;
}

function syncEditor() {
  highlightCode.innerHTML = htmlTokens(editor.value);
  const lines = editor.value.split('\n').length;
  gutterEl.textContent = Array.from({ length: lines }, (_, n) => n + 1).join('\n');
  syncScroll();
  persistEditor();
}

editor.addEventListener('input', syncEditor);
editor.addEventListener('scroll', syncScroll);
syncEditor();

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
let generating = false;

/** Count page objects in the produced PDF (for the preview tab badge). */
function countPages(bytes) {
  let latin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) latin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return (latin.match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

async function generate() {
  if (generating) return;
  generating = true;
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
  } finally {
    generating = false;
  }
}

document.getElementById('generate').addEventListener('click', generate);
document.getElementById('reset').addEventListener('click', () => {
  editor.value = DEFAULT_HTML;
  syncEditor();
  showTab('editor');
  status('HTML reset to the sample report.');
});

function status(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

// No PDF is rendered on load — edit freely, then press "Generate PDF" or open the
// "PDF preview" tab (switching to it renders on demand).
status('Edit the HTML, then open the “PDF preview” tab or press “Generate PDF”.');
