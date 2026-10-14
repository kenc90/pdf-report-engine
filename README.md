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
- **Inline:** `b`/`strong`, `i`/`em`, `u`/`ins`, `span`, `font`, `a`.
- **Running tokens:** `{PAGE}`, `{TOTAL}`, `{TOP}` are rewritten into `$page.*` bindings. They
  resolve to real per-page values inside a `data-band` header/footer; in plain body flow they
  show the measure-time value.
- **Inline `style` subset:** `font-size` (px → pt), `font-family`, `font-weight`,
  `font-style`, `color`, `background(-color)`, `text-align`, `text-decoration`,
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
- **Bands:** an element with `data-band="pageHeader | pageFooter | title | summary | background"`
  is lifted out of the body flow into a **repeated page band**, painted on every page.
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

# Embed a specific font (repeatable), instead of the auto-detected system fonts:
npm run html:pdf -- samples/invoice.html -f "Arial=C:/Windows/Fonts/arialbd.ttf:700"
```

Options:

| Flag | Meaning |
| --- | --- |
| `-o, --out <path>` | Output `.pdf` path (single input) or directory (default: alongside each input). |
| `-d, --data <file>` | JSON object made available as the report `data` root for `data-each` / `data-bind`. Defaults to an adjacent `<name>.data.json` when present. |
| `-f, --font <spec>` | Embed a font: `<path>` or `<family>=<path>[:weight]`. Repeatable. |
| `--page <pt>` | Base font size in points (default `11`). |
| `--no-auto-fonts` | Skip automatic system-font detection (falls back to base-14). |
| `-h, --help` | Show usage. |

With no `--font` it opportunistically loads Arial / Georgia / Microsoft YaHei from
`C:/Windows/Fonts` when present; otherwise it renders with the standard PDF base-14 fonts.

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
| IR types | `ReportDoc`, `Block`, `TableBlock`, `ParagraphBlock`, `HeadingBlock`, `SpacerBlock`, `PageBreakBlock`, `BandContent`, `BandType`, `StyleProps`, `BoxProps`, `Content`, `ContentSpan`, `ColumnNode`, `RowNode`, `CellNode`, `GroupNode`, `DataSource`, `Expr`. |

`RenderOptions.now` is an injectable clock (for deterministic `now()` in expressions and
PDF timestamps) — useful in tests.

## Project layout

```
src/
  ir/          ReportDoc IR schema (the contract everything targets)
  core/        page sizes + unit conversion (px/mm/cm/in -> pt)
  fonts/       font registry + metrics (measurement/render oracle)
  text/        style resolution + line breaking / typesetting
  layout/      block & table layout, column sizing, fragments
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
Font-dependent assertions self-skip when the reference font (e.g. `arial.ttf`) is absent,
so the model-level checks always run.

## License

[MIT](./LICENSE) — free to use, modify and redistribute, including commercially, as long as
the copyright and license notice are retained.
