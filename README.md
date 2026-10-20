# pdf-report-engine

A pure-JavaScript **paginated PDF report engine**. It turns a report *IR* (intermediate
representation) — or a small subset of authoring **HTML** — into a **real vector PDF with
selectable, searchable text** and **Jasper-Reports-style pagination**.

No Chromium. No headless browser. No screenshots. Layout, line-breaking, pagination and
glyph embedding all happen in-process via [`pdfkit`](https://pdfkit.org) +
[`fontkit`](https://github.com/foliojs/fontkit).

> **Documentation site:** <https://kenc90.github.io/pdf-report-engine/> ·
> **Source:** <https://github.com/kenc90/pdf-report-engine>

## Features

- **Vector, text-selectable output** — fonts are embedded as `/Type0` → `/CIDFontType2`
  composites with a `/ToUnicode` CMap, so viewers and text extractors map glyphs back to
  characters (including CJK).
- **Band-based pagination** (Jasper-style): `title`, `pageHeader`, `detail`,
  `groupHeader`, `groupFooter`, `pageFooter`, `summary`.
- **Repeated table column headers** on every page a table spills onto.
- **Group breaks** with per-group subtotal footers, plus **keep rules** and
  **widow/orphan** control.
- **Running tokens** `{PAGE}` / `{TOTAL}` / `{TOP}` (and `$page.number` / `$page.total` /
  `$page.top` in expressions) resolved per page.
- **Sandboxed expression evaluator** — data bindings run inside a `Proxy`-whitelisted
  scope with a small function library; there is no raw `eval` of globals.
- **HTML-subset adapter** so you can author with plain markup.
- **CSS stylesheet subset** — `<style>` rules with tag, class, id, descendant (` `) and
  child (`>`) selectors, resolved by CSS specificity; inline `style` still wins.
- **Vector charts** — data-bound `bar`, `line`, `area`, `pie` and `donut` charts with
  axes, grid lines, legends, stacked modes and value labels. Every mark is a real PDF
  path/rectangle, so charts stay crisp at any zoom.
- **Table of contents, PDF bookmarks and hyperlinks** — a `toc` block with dot leaders
  and *real* page numbers (fixed-point pagination), a nested PDF outline generated from
  headings, external `http(s)` links and internal `#anchor` destinations.
- **QR / Code 128 / EAN-13** barcode blocks — dependency-free encoders, emitted as
  merged vector rectangles with optional human-readable captions.
- **`@page` control from HTML** — a `<style>@page { size: A4 landscape; margin: 15mm }</style>`
  rule (or a `<meta name="pdf-page" content="size=letter; margin=0.5in">`) sets the page size,
  orientation and margins; a JS-provided `page` option still wins.
- **Measurement == rendering oracle** — text widths are measured through the exact code
  path pdfkit paints with, so wrapped lines never overflow their box.

## Requirements

- **Node.js ≥ 18** (the package is ESM-only: `"type": "module"`).

## Installation

Install directly from GitHub (the `prepare` script builds `dist/` on install):

```bash
npm install kenc90/pdf-report-engine
# pin a version:  npm install kenc90/pdf-report-engine#v0.1.0
```

To work on the library itself, clone the repo and install dev dependencies:

```bash
npm install
```

Runtime dependencies: `pdfkit` and `fontkit`. Everything else is a dev dependency.

## Build & scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` (`tsc -p tsconfig.build.json`). Emits JS + `.d.ts`. |
| `npm run typecheck` | Type-check the whole project without emitting (`tsc --noEmit`). |
| `npm run test` | Run the Vitest suite once. |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run demo` | Build the sample multi-page report and write `output/demo.pdf`. |
| `npm run html:pdf -- <args>` | CLI that converts authoring HTML files to PDF (see below). |

```bash
npm run build      # -> dist/index.js, dist/index.d.ts, ...
npm run test       # -> full suite (layout, linebreak, typeset, integration, html-adapter)
npm run demo       # -> output/demo.pdf
```

The build output is what the package's `exports` map points at, so after `npm run build`
you can consume it from another ESM project with `import { renderToBuffer } from 'pdf-report-engine'`.

## Usage

There are two entry points, both funnelled through the same pipeline:

```
authoring (IR or HTML)  ->  ReportDoc IR  ->  layout  ->  pagination  ->  pdfkit writer  ->  PDF bytes
```

The main functions are:

- `renderToBuffer(report, options?) → Promise<Buffer>` — one-shot: IR in, PDF bytes out.
- `createReport(report, options?) → { doc, pages, registry }` — gives you the live `pdfkit`
  `doc` (to pipe/stream yourself) and the paginated `pages` model.

### A. From the report IR

```ts
import { renderToBuffer, readFontFiles, type ReportDoc } from 'pdf-report-engine';

const report: ReportDoc = {
  info: { title: 'Quarterly Sales Report' },
  page: { size: 'a4', margin: 51 },                 // margin in points
  style: { fontFamily: ['Arial', 'Helvetica'], fontSize: 10 },
  data: {
    rows: [
      { region: 'North', product: 'Widget', qty: 3, amount: 120.5 },
      // ...
    ],
  },
  bands: {
    pageHeader: { height: 34, text: 'Quarterly Sales Report' },
    pageFooter: {
      height: 22,
      blocks: [
        { type: 'paragraph', align: 'right',
          content: ['Page ', { bind: '$page.number' }, ' of ', { bind: '$page.total' }] },
      ],
    },
  },
  body: [
    {
      type: 'table',
      dataSource: { bind: '$data.rows' },           // bound table driven by data
      repeatHeader: true,
      showGrid: true,
      striped: true,
      columns: [
        { key: 'region', grow: 1 },
        { key: 'product', grow: 2 },
        { key: 'qty', width: 46, align: 'right' },
        { key: 'amount', width: 90, align: 'right' },
      ],
      headerRows: [
        { kind: 'header', cells: ['Region', 'Product', 'Qty', 'Amount'].map((label) => ({ content: label })) },
      ],
      groups: [
        { by: '$row.region',
          footer: [{ bind: "concat('Subtotal: ', money($group.amount_sum))" }] },
      ],
      detail: {
        cells: [
          { bind: 'region' },
          { bind: 'product' },
          { bind: 'qty' },
          { bind: 'amount', format: '#,##0.00' },
        ],
      },
    },
  ],
};

const fonts = await readFontFiles([
  { family: 'Arial', path: 'C:/Windows/Fonts/arial.ttf', weight: 400 },
]);
const pdf = await renderToBuffer(report, { fonts });
// `pdf` is a Buffer of the complete PDF; write it or stream it.
```

Images — offline sources are handled by `createReport`; online `http(s)` sources are fetched by
`renderToBuffer`'s pre-pass (control it with the `images` option, or inject your own loader):

```ts
const report: ReportDoc = {
  body: [
    { type: 'image', src: 'assets/logo.png' },                 // local path (relative to baseDir)
    { type: 'image', src: 'data:image/png;base64,iVBORw0...' }, // inline bytes
    { type: 'image', src: 'https://cdn.example.com/chart.png', width: 300 }, // online
  ],
};

// Downloads each URL once, then lays out offline. Disable with fetchRemote:false,
// or route through a proxy/auth with resolveImage(url).
const pdf = await renderToBuffer(report, {
  images: { timeoutMs: 10_000, maxBytes: 5_000_000, onError: 'skip' },
});
```

Charts, barcodes, a table of contents and links are ordinary IR blocks. Give headings an
`id` so TOC rows and `#anchor` links have a destination:

```ts
const report: ReportDoc = {
  body: [
    { type: 'heading', level: 1, id: 'top', content: 'Quarterly report' },
    { type: 'toc', title: 'Contents', maxLevel: 3 },       // real page numbers + dot leaders

    {
      type: 'chart', kind: 'bar', title: 'Revenue (millions)', height: 170,
      categories: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [
        { name: 'Actual', values: [12, 18, 15, 22] },
        { name: 'Plan', values: [10, 14, 16, 20] },
      ],
      legend: 'bottom', showValues: true, valueAxis: { format: '#,##0' },
    },
    { type: 'chart', kind: 'donut', categories: ['North', 'South'],
      series: [{ values: [62, 38] }] },

    { type: 'barcode', symbology: 'qr', value: 'https://example.com/report/2026-Q3' },
    { type: 'barcode', symbology: 'code128', value: 'RPT-2026-Q3-0042' },
    { type: 'barcode', symbology: 'ean13', value: '590123412345' }, // checksum appended

    { type: 'paragraph', content: [
      'Read the ', { text: 'live report', link: 'https://example.com' },
      ' or jump to the ', { text: 'appendix', link: '#appendix' }, '.',
    ] },
    { type: 'heading', level: 2, id: 'appendix', content: 'Appendix' },
  ],
};
```

Chart values/categories also accept CSV strings (`'12,18,15'`) or bindings
(`'$data.revenue'`); barcode `value` accepts a binding too, so codes can be data-driven.
`bar`/`line`/`area` read one value per category per series; `pie`/`donut` read
`series[0].values` and label the slices from `categories`.

See `src/cli/demo.ts` for a complete, runnable example (grouping, subtotals, running
tokens, embedded fonts with a base-14 fallback).

### Runnable JS-library examples

Plain `.mjs` scripts under [`examples/`](./examples) show the package the way a JS caller uses it
(`import { … } from 'pdf-report-engine'`). Build once, then run any file:

```bash
npm run build
node examples/01-basic.mjs                 # minimal IR: heading, paragraph, static table
node examples/02-data-table.mjs            # dataSource + grouping + subtotals + running footer
node examples/03-from-html.mjs             # author with HTML via htmlToReportDoc
node examples/04-create-report-stream.mjs  # createReport -> pipe the stream + read pages
node examples/05-images.mjs                # images from bytes / path / online (resolveImage hook)
```

Each writes a PDF to `output/examples/`. They need no fonts (base-14 fallback) and no network.

### B. From the HTML subset

```ts
import { htmlToReportDoc, renderToBuffer } from 'pdf-report-engine';

const html = `
  <body style="font-family: Arial; font-size: 11pt">
    <h1>Invoice</h1>
    <p>Client: <strong>Acme Co</strong></p>
    <table>
      <tr><th>Item</th><th>Amount</th></tr>
      <tr><td>Widget</td><td>1,200.00</td></tr>
      <tr><td>Service</td><td>450.50</td></tr>
    </table>
    <p style="text-align:right">Page {PAGE} of {TOTAL}</p>
  </body>`;

const report = htmlToReportDoc(html, { style: { fontFamily: 'Arial' } });
const pdf = await renderToBuffer(report, { fonts: await readFontFiles([
  { family: 'Arial', path: 'C:/Windows/Fonts/arial.ttf', weight: 400 },
]) });
```

**What the HTML adapter understands** (deliberately narrow — anything outside this is ignored):

- **Blocks:** `h1..h6`, `p`, `div`/`section`/`article`/`header`/`footer`/`main`,
  `table` (`thead`/`tbody`/`tfoot`/`tr`/`th`/`td`), `ul`/`ol`/`li`, `hr`, `br`.
- **Inline:** `b`/`strong`, `i`/`em`, `u`/`ins`, `span`, `font`, `a`, `mark`.
- **Stylesheets:** `<style>` contents are parsed into a small cascade supporting tag
  (`p`), class (`.kpi`), id (`#note`) and compound (`p.kpi`, `#note strong`) selectors,
  comma lists, and descendant (` `) / child (`>`) combinators. Specificity follows CSS
  (id > class > tag), source order breaks ties, and an inline `style` wins. At-rules
  such as `@media` and `@font-face` are skipped; `@page` is handled separately.
- **Links:** `<a href="https://…">` becomes a real PDF link annotation; `href="#id"`
  jumps to any block/heading carrying that `id` (a named destination). Anchors are
  clipped to the text runs, and TOC rows link to their heading automatically.
- **Highlights:** `<mark>` paints the browser-style `#fff2a8` run background unless the
  element sets its own `background-color`.
- **Running tokens:** `{PAGE}`, `{TOTAL}`, `{TOP}` are rewritten into `$page.*` bindings. They
  resolve to real per-page values inside a `data-band` header/footer; in plain body flow they
  show the measure-time value.
- **Inline `style` subset:** `font-size` (px → pt), `font-family`, `font-weight`,
  `font-style`, `color`, `background(-color)`, `opacity`, `text-align`, `text-decoration`,
  unitless `line-height`, `letter-spacing`, `white-space`, `text-transform`,
  `width`/`height`/`min-height`, `vertical-align`, `margin`/`padding` (shorthand + sides),
  `border` (top/bottom/full shorthand), and `break-*` / `page-break-*` → break rules.
- **Table styling:** per-cell `background-color`, `border` and `padding` on a `<td>`/`<th>`
  render as real fills and ruled grid lines. Whole-table attributes: `border` or
  `data-grid="1px solid #ccc"` draw a uniform cell grid; `data-striped` (optionally with
  `data-striped-color="#f3f6fb"`) shades alternating rows. Literal `<table>` rows keep their
  own per-cell colors (heatmap / status styling); authored via `TableBlock.staticRows`.
- **Merged cells:** `colspan` (horizontal) and `rowspan` (vertical) are supported on `<td>`/`<th>`.
  A horizontal span sums the widths of the columns it covers. A vertical span is laid out as a
  single merged grid: rows that a `rowspan` links are grouped into one block, the merged cell's
  height is distributed across the rows it covers, and covered cells below are skipped. Vertical
  merging is honored in **authored rows** — headers, footers and literal/static body rows
  (`staticRows`); it is intentionally ignored in data-expanded (`data-each`) detail rows, which
  share one template. A merged block is kept atomic (it won't split across a page break).
- **Data binding:** `data-each="item in $data.list"`, `data-bind="<expr>"`,
  `data-format="<pattern>"` turn a `<table>` into a bound data region; `data-bind` on any
  leaf binds that node's text to an expression instead of its literal content.
- **Declarative chart / TOC / barcode blocks:** a `div` (or `table`) carrying a
  `data-chart` attribute becomes a `ChartBlock`:
  `data-chart="bar|line|area|pie|donut"`, `data-title`, `data-categories="Q1,Q2"`,
  `data-series="Actual:1,2;Plan:3,4"` (or `data-values` for a single series),
  `data-colors`, `data-stacked`, `data-show-values`, `data-legend="none|top|bottom|right"`,
  `data-min`/`data-max`/`data-ticks`/`data-value-format`/`data-axis-labels`/`data-grid-lines`,
  `data-inner-radius`, `data-plot-height`. A `<table data-chart="line">` reads its header
  row as series names and its first column as categories, so an authored table can be
  shown as a chart without a second data source.
  A `div data-toc` becomes a TOC (`data-title`, `data-level`/`data-max-level`,
  `data-leaders`, `data-page-numbers`, `data-indent`, `data-gap`), and a
  `div data-barcode="qr|code128|ean13"` becomes a barcode (`data-value`, `data-bind`,
  `data-error-correction`, `data-module-size`, `data-quiet-zone`, `data-show-text`,
  `data-color`).
- **Bands:** an element with `data-band="pageHeader | pageFooter | title | summary | background"`
  is lifted out of the body flow into a **repeated page band**, painted on every page.
  Band styles inherit into its blocks, so `opacity:0.05` on a `background` band produces a
  translucent watermark/letterhead on every page.
- **Images:** a block-level `<img src="..." width="..." height="...">` embeds a real PDF image
  object (PNG / JPEG / GIF / BMP). `src` may be a **local file path**, a **`data:` URI**, raw
  **bytes** (`Uint8Array`), or an **online `http(s)` URL** — all supported. Relative local paths
  are resolved against the adapter's `baseDir` (the CLI passes the HTML file's folder). Give both
  dimensions, or just one and the engine fills in the other from the image's intrinsic aspect
  ratio. Images align via `text-align`, can carry a `border`/`padding`, never split across a page,
  and work inside repeated bands (e.g. a letterhead logo).
  - **Offline** (path / `data:` / bytes): handled synchronously by `createReport`.
  - **Online** (`http(s)`): fetched by the async `renderToBuffer`, which runs a pre-pass
    (`resolveRemoteImages`) that downloads each remote image once (per-render cache), converts it
    to bytes and infers its size — then layout/pagination stay offline. Tune with `images`:
    `{ fetchRemote, timeoutMs, maxBytes, resolveImage, onError }`. Set `fetchRemote: false` for
    air-gapped builds, or supply `resolveImage(url)` to inject a proxy/auth/custom loader. The CLI
    fetches remote images by default. In the IR, use `ImageBlock`
    (`{ type: 'image', src, width?, height?, intrinsic?, alt? }`).

You can also parse without converting: `parseHtml(html)` returns the element tree.

### C. Command-line converter (`html-to-pdf`)

A ready-made CLI lives in `src/cli/html-to-pdf.ts` and turns HTML files into PDFs. It is
wired up as an npm script (pass arguments after `--`):

```bash
# One file, PDF written next to the input:
npm run html:pdf -- samples/invoice.html

# Choose the output file:
npm run html:pdf -- samples/report.html -o output/report.pdf

# A data-bound table (see samples/roster.html): supply its JSON data root:
npm run html:pdf -- samples/roster.html --data samples/roster.data.json -o output/

# Convert every *.html in a folder into an output directory:
npm run html:pdf -- samples/ -o output/

# Embed specific fonts (repeatable). These ADD to the auto-detected system fonts,
# so the CJK face stays available even when you specify your own:
npm run html:pdf -- samples/invoice.html -f "Arial=C:/Windows/Fonts/arialbd.ttf:700"

# The testimonial sample renders out-of-the-box — Times New Roman (lining figures)
# and a CJK face are auto-detected on Windows / macOS / Linux, no flags required:
npm run html:pdf -- samples/testimonial.html -o output/testimonial.pdf

# Force a specific font file (override/additive). Paths below are Linux examples:
npm run html:pdf -- samples/testimonial.html \
  -f "Times New Roman=/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf:400"

# Select a face inside a TrueType collection (.ttc) with a `#PostScriptName`:
npm run html:pdf -- samples/testimonial.html -f "PMingLiU=C:/Windows/Fonts/mingliu.ttc#PMingLiU"
```

Options:

| Flag | Meaning |
| --- | --- |
| `-o, --out <path>` | Output `.pdf` path (single input) or directory (default: alongside each input). |
| `-d, --data <file>` | JSON object made available as the report `data` root for `data-each` / `data-bind`. Defaults to an adjacent `<name>.data.json` when present. |
| `-f, --font <spec>` | Embed a font: `<path>` or `<family>=<path>[:weight][#PostScriptName]`. Repeatable. Added on top of (and overrides per family+weight) the auto-loaded fonts. Use `#…` to pick a face inside a `.ttc` collection. |
| `--page <pt>` | Base font size in points (default `11`). |
| `--no-auto-fonts` | Skip automatic system-font detection entirely (then only `--font` entries load; falls back to base-14 if none). |
| `-h, --help` | Show usage. |

By default it auto-detects fonts **for the current platform** and registers them under the
authoring family names samples use:

- **Windows** — Arial / Georgia / Times New Roman from `C:/Windows/Fonts`, plus Microsoft YaHei (CJK).
- **macOS** — Arial / Georgia / Times New Roman from `/System/Library/Fonts/Supplemental`, plus Arial Unicode / PingFang (CJK).
- **Linux** — via fontconfig (`fc-match` / `fc-list`), falling back to scanning common font
  dirs for DejaVu / Liberation / Noto, with a `:lang=zh` font registered under CJK aliases.

Explicit `--font` entries are merged **with** these, so you can add a family (e.g. Times New
Roman) without losing the CJK font. If no fonts are found (or with `--no-auto-fonts` and no
`--font`), it renders with the standard PDF base-14 fonts (Latin-1 only — CJK will not render).

#### Sample HTML

The `samples/` folder demonstrates the supported subset:

- `invoice.html` — headings, a two-column address table, a line-item table with styled
  headers, and `{PAGE}` / `{TOTAL}` running tokens.
- `report.html` — Georgia body text, inline emphasis, a bulleted list, a bordered data
  table, and an explicit `break-before: page` that paginates onto a second page.
- `roster.html` + `roster.data.json` — a **data-bound** table using `data-each` /
  `data-bind` / `data-format`, populated from the JSON via `--data`.
- `table-colors.html` — a focused styling showcase: a full cell **grid** with striped rows and
  a dark colored header, a **status table** whose body cells are individually colored, and a
  value **heatmap** — all with real per-cell borders and background fills.
- `merge-cells.html` — **merged cells**: a `rowspan` table (a label centered over several rows),
  a `colspan` table (a subtotal spanning columns plus a full-width banner), and a third table
  that **combines** both merges in one grid.
- `image.html` (+ `assets/logo.png`) — **images**: intrinsic-size placement, width-only
  aspect scaling, alignment, a bordered box, and a letterhead logo repeated in a `pageHeader`
  band. `assets/logo.png` is a generated placeholder — regenerate it with
  `node scripts/gen-logo.mjs`, or drop in your own `assets/logo.png`.
- `image-online.html` — **online images**: the same layout features, but every `src` is an
  `https` URL (from `picsum.photos`) that the engine downloads at render time. Requires an
  internet connection: run `html-to-pdf samples/image-online.html` on a connected machine. It
  also reuses one URL twice to show the per-render fetch cache.
- `annual-report.html` + `annual-report.data.json` — the flagship **multi-page** report: a
  colored cover band, KPI "cards", a pull-quote, a regional **heatmap** (value-shaded
  cells), a data-bound 36-row ledger whose **column header repeats on every page**, and
  **`data-band` page header/footer** with correctly-resolved `Page N of M` numbering.
  `npm run html:pdf -- samples/annual-report.html -o output/` (data auto-pairs).
- `dashboard.html` — the **new-features tour**: `<style>` tag/class/id/descendant
  selectors, a translucent `background` watermark, a clickable `data-toc` with real page
  numbers, **every chart kind** (grouped bar, stacked bar, line, `<table data-chart="area">`,
  pie, donut), QR / Code 128 / EAN-13
  codes, `<mark>` highlights, external and `#anchor` links, and a nested PDF outline.
  `npm run html:pdf -- samples/dashboard.html -o output/`.
- `testimonial.html` — a **formal certificate / Jasper-style testimonial** replica: a repeating
  `data-band` header (institution crest slot + title) and footer (`Page N of M` + a reference
  number), serif body text, and label/value section tables. It renders **out of the box** — the
  CLI auto-detects Times New Roman (lining figures, so digits align with capitals) and, via
  per-glyph fallback, a CJK face for the Chinese name — with no `-f` flags required.

## Fonts

`renderToBuffer` works without any supplied fonts (it falls back to the standard PDF base-14
fonts, e.g. `Helvetica`), but those are Latin-1 only and are **not** embedded, so text may
not be portable across viewers. For guaranteed fidelity and CJK support, embed font programs:

```ts
import { readFontFiles } from 'pdf-report-engine';

// From files on disk:
const fonts = await readFontFiles([
  { family: 'Arial',         path: 'C:/Windows/Fonts/arial.ttf',  weight: 400 },
  { family: 'Arial',         path: 'C:/Windows/Fonts/arialbd.ttf', weight: 700 },
  { family: 'Microsoft YaHei', path: 'C:/Windows/Fonts/msyh.ttc',  postscriptName: 'MicrosoftYaHei' },
]);

// Or pass bytes you already have (fetch, assets, etc.):
const fonts2 = await readFontFiles([{ family: 'Inter', weight: 400, buffer: myBytes }]);

const pdf = await renderToBuffer(report, { fonts });
```

- `family` is matched against `style.fontFamily`; `weight` (default `400`) and `style`
  (default `'normal'`) select the face.
- `.ttc` collections require `postscriptName` to pick the face inside the collection.
- Give each weight/style you want to use (regular, bold, italic) its own entry.

### Per-glyph font fallback

Like a browser or Java2D, the engine falls back **per character**: within a single run, any
code point the resolved face has no glyph for is re-resolved against the other *registered*
faces, and the run is split so each segment is measured and painted in the font that covers
it. The substitution keeps the nearest `weight`/`style`, and text that genuinely has no
covering face renders as `.notdef` rather than vanishing.

This means **mixed-script text "just works"** — e.g. `陳大文 test` in an `Arial` paragraph
renders the CJK via a registered CJK face and the Latin via Arial, with no explicit
`font-family` on the Chinese. The one requirement (as with any engine) is that a font
covering the script is *registered*: the CLI auto-loads a CJK face per platform, and in the
library you add one via `readFontFiles`. Fallback only reaches registered faces, so output
stays deterministic across machines rather than dipping into whatever the OS happens to have.

## Running in the browser

> A live, no-build demo is on the docs site: **`docs/browser-demo.html`** (edit HTML → Generate PDF,
> with an optional local font picker). The bundle it loads is produced by `npm run build:browser`
> (esbuild, with `pdfkit` routed to its self-contained browser build so no Node polyfill config is needed).

The core engine (IR/HTML → paginated PDF) is pure JavaScript and runs in a browser bundle.
It uses **no top-level `node:*` imports** in the library graph, so Vite / webpack / esbuild
can bundle it without a Node polyfill *for our code*. Two things are still required, however,
because of `pdfkit` itself:

1. **A bundler with Node polyfills.** `pdfkit` relies on `Buffer` and streams, so enable
   `vite-plugin-node-polyfills` (Vite) or `resolve.fallback = { buffer: 'buffer/', stream: 'stream-browserify', … }`
   (webpack). There is no meaningful "no-build-step" browser use — that is a pdfkit constraint,
   not an engine one.
2. **You supply the font bytes** (unless you use [web-font auto-resolution](#web-fonts--google-fonts)).
   A browser cannot read installed system fonts, so `fetch` TTF/OTF/TTC bytes yourself and pass
   them in. The font engine embeds TTF/OTF/TTC directly; **WOFF2 is auto-decoded** for you when it
   arrives via a Google Fonts link or an `@font-face` (see below), but if you hand it bytes
   directly, give it raw TTF/OTF:

```ts
import { renderToBuffer, type ReportDoc, type FontSource } from 'pdf-report-engine';

async function font(url: string, family: string, weight?: number): Promise<FontSource> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return { family, weight, buffer: bytes };
}

const fonts = await Promise.all([
  font('/fonts/Inter-Regular.ttf', 'Inter', 400),
  font('/fonts/Inter-Bold.ttf',    'Inter', 700),
  font('/fonts/NotoSansSC.ttf',    'Microsoft YaHei'), // a registered CJK face enables fallback
]);

const pdf = await renderToBuffer(report, { fonts });            // Uint8Array/Buffer
await document.body.append(makeBlobPreview(pdf));               // wrap in a Blob(url, 'application/pdf')
```

Browser-specific rules:

- Use `renderToBuffer(report, { fonts })` with **bytes**; do **not** call `readFontFiles` with a
  `path` (that lazily imports `node:fs/promises`). Bytes-only `readFontFiles` entries are fine.
- **Images** must be raw bytes, a `data:` URI, or an `http(s)` URL (resolved via `fetch`). A
  filesystem path returns `null` for intrinsic size, so give path-less bytes or set explicit
  `width`/`height`. `setImageFileReader` exists for Node hosts; ignore it in the browser.
- Heavy reports block the UI — run `renderToBuffer` in a **Web Worker** and transfer the bytes.

## Web fonts & Google Fonts

You don't have to fetch font bytes yourself. If the HTML references a web font, the engine
resolves and embeds it during `renderToBuffer` — **in Node and in the browser, identically**:

```html
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap" rel="stylesheet">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap');
  @font-face { font-family: 'Brand'; src: url('https://cdn.example/brand.woff2'); }
</style>
<h1 style="font-family: 'Roboto'">Quarterly Report</h1>   <!-- embedded, selectable -->
```

`htmlToReportDoc` collects those references into `report.fonts`, and an async pre-pass —
`resolveRemoteFonts`, mirroring the remote-image one — fetches the CSS, parses every
`@font-face`, downloads the files and registers them under their family name. Just write
`font-family: 'Roboto'` and it embeds.

**How it copes with formats.** Google's CSS endpoint is User-Agent driven: a Node `fetch`
(non-browser UA) is served **TTF** and embedded directly; a browser (UA cannot be overridden) is
served **WOFF2**, which fontkit/pdfkit cannot read — so we decode WOFF2 → TTF in-process. That
needs the optional [`wawoff2`](https://www.npmjs.com/package/wawoff2) WebAssembly module (already a
dependency here): if it's missing, WOFF2 references are skipped (or throw with `onError: 'throw'`)
while TTF/OTF paths keep working. Google ships one file per script (`unicode-range`: latin,
latin-ext, cyrillic, …); each subset becomes its own face and per-glyph fallback picks the one
covering each code point — the same mechanism used for CJK.

`report.fonts` is also settable directly (no HTML), and `renderToBuffer(report, { resolveFonts })`
takes controls (`fetchRemote`, `timeoutMs`, `onError: 'throw' | 'skip'`, `resolveFont` /
`resolveText` for a proxy or cache, `decodeWoff2`). Failed fonts are **skipped by default** so a
flaky CDN never kills a render:

```ts
const report = htmlToReportDoc(html);                 // report.fonts populated from <link>/@font-face
const pdf = await renderToBuffer(report, {
  resolveFonts: { onError: 'throw', timeoutMs: 8000 }, // strict, for CI
});
```

> Auto-fetched fonts touch the network, so pin/cache them (`resolveFont`) if you need byte-exact
> reproducible PDFs — the same caveat as relying on any remote asset.

## Expressions & running tokens

Bindings are small expressions evaluated in a sandbox. They can be a plain field path
(`'region'`, `'$data.rows'`) or a function call (`"money($group.amount_sum)"`).

Scope roots available inside expressions:

| Root | Meaning |
| --- | --- |
| `$row` | current detail row |
| `$group` | current group aggregate (e.g. `$group.amount_sum`) |
| `$report` | report-level values |
| `$page` | `{ number, total, top }` — running page tokens |
| `$data` | the document's `data` object |
| `$vars` | JS-precomputed report variables |
| `$index` | current row index |

The evaluator exposes a whitelisted function library (e.g. `money`, `concat`, ...) rather
than the global scope; there is no access to `eval`, `globalThis`, `process`, etc. For a
whole-report total the simplest approach is a `variables` entry referenced via `$vars`
(see the demo), while per-group subtotals come from `$group.<key>_sum`.

## Pagination model

`createReport` runs a three-pass paginator:

1. **Pass A** — measure fixed bands (headers/footers) with a placeholder page number.
2. **Pass B** — flow the body, honouring `breakBefore`/`breakAfter`/`breakInside`,
   keep-with-next runs, repeated table headers, group breaks and page resets.
3. **Pass C** — re-flow headers/footers on each page with the real `$page` values, so
   `{PAGE}`/`{TOTAL}` are correct.

When the body contains a `toc` block, `createReport` wraps the passes in a fixed-point loop:
lay out → paginate → collect the heading outline entries → rebuild the TOC with their real
page numbers → repeat until the entry set is stable (at most four iterations). That is how
the TOC can show page numbers that depend on the TOC's own height.

`paginate(...)` is also exported if you want to drive the paginator directly against your
own fragments.

## Public API

From the package root (`pdf-report-engine`):

| Export | Purpose |
| --- | --- |
| `createReport(report, options?)` | Build the `pdfkit` doc + paginated `pages`; returns `{ doc, pages, registry }`. |
| `renderToBuffer(report, options?)` | `createReport` + collect to a `Buffer`. |
| `RenderOptions` | `{ fonts?: FontSource[], now?: () => Date, baseStyle?: Partial<StyleProps>, images?: ImageResolveOptions }`. |
| `htmlToReportDoc(html, options?)` | HTML subset → `ReportDoc`. |
| `parseHtml(html)` | HTML subset → element tree (`HElement`). |
| `readFontFiles(entries)` | Load `FontFileEntry[]` (paths or bytes) → `FontSource[]`. |
| `FontRegistry` | Lower-level face registration / measurement. |
| `resolvePage`, `toPt`, `expandBox`, `MM_TO_PT`, `CM_TO_PT`, `IN_TO_PT`, `PX_TO_PT` | Page-size & length helpers. |
| `paginate` | Run the pagination engine directly. |
| IR types | `ReportDoc`, `Block`, `TableBlock`, `ParagraphBlock`, `HeadingBlock`, `SpacerBlock`, `PageBreakBlock`, `ImageBlock`, `ChartBlock`, `ChartKind`, `ChartSeries`, `ValueAxisOptions`, `TocBlock`, `BarcodeBlock`, `BarcodeSymbology`, `BandContent`, `BandType`, `StyleProps`, `BoxProps`, `Content`, `ContentSpan`, `ColumnNode`, `RowNode`, `CellNode`, `GroupNode`, `DataSource`, `Expr`. |

`RenderOptions.now` is an injectable clock (for deterministic `now()` in expressions and
PDF timestamps) — useful in tests.

## Project layout

```
src/
  ir/          ReportDoc IR schema (the contract everything targets)
  core/        page sizes + unit conversion (px/mm/cm/in -> pt)
  fonts/       font registry + metrics (measurement/render oracle)
  text/        style resolution + line breaking / typesetting
  barcode/     QR (versions 1-40), Code 128 and EAN-13 encoders
  layout/      block/chart/toc/barcode & table layout, column sizing, fragments
  pagination/  three-pass band paginator
  expr/        sandboxed expression evaluator + function library
  writer/      pdfkit writer (draws fragments, embeds fonts)
  adapter/     HTML-subset -> IR adapter
  render.ts    createReport / renderToBuffer orchestration
  cli/demo.ts  runnable sample report
test/          Vitest suites (unit + integration + html-adapter)
```

## Testing

```bash
npm run test          # all suites
npm run test:watch    # watch mode
```

The integration test verifies multi-page pagination, per-page running tokens, and that the
bytes contain a real `/Type0` + `/CIDFontType2` + `/ToUnicode` embedded-font structure.
`test/features.test.ts` additionally covers the barcode encoders, chart geometry, the CSS
cascade, declarative HTML blocks, TOC page numbers, PDF outline/link structures and inline
background fills. Font-dependent assertions self-skip when the reference font
(e.g. `arial.ttf`) is absent, so the model-level checks always run.

## License

[MIT](./LICENSE) — free to use, modify and redistribute, including commercially, as long as
the copyright and license notice are retained.
