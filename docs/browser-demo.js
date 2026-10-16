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

const DEFAULT_HTML = [
  '<!-- The engine understands a small, deliberate slice of HTML: headings, paragraphs,',
  '     inline styles, tables, and data-band page headers/footers. Edit freely. -->',
  '<header data-band="pageHeader">',
  '  <p style="color:#5b6b8c; font-size:9pt">pdf-report-engine &middot; rendered in your browser</p>',
  '</header>',
  '',
  '<h1>Quarterly Snapshot</h1>',
  '<p style="color:#5b6b8c">Revenue, growth and highlights &mdash; no server, no Chromium.</p>',
  '',
  '<h2>Highlights</h2>',
  '<p>',
  '  Revenue reached <strong>$1.24M</strong> this quarter, up <em>18%</em> year over year.',
  '  Every word in the exported PDF is <u>selectable and searchable</u>, because the text',
  '  is laid out as vector glyphs with a real ToUnicode map &mdash; not a screenshot.',
  '</p>',
  '',
  '<h2>Regional performance</h2>',
  '<table style="border-collapse:collapse; width:100%">',
  '  <thead>',
  '    <tr style="background:#eef2f8">',
  '      <th style="text-align:left; padding:4pt 6pt">Region</th>',
  '      <th style="text-align:right; padding:4pt 6pt">Revenue</th>',
  '      <th style="text-align:right; padding:4pt 6pt">Growth</th>',
  '    </tr>',
  '  </thead>',
  '  <tbody>',
  '    <tr><td style="padding:4pt 6pt">North America</td><td style="text-align:right">$640,200</td><td style="text-align:right">+21%</td></tr>',
  '    <tr><td style="padding:4pt 6pt">EMEA</td><td style="text-align:right">$402,150</td><td style="text-align:right">+14%</td></tr>',
  '    <tr><td style="padding:4pt 6pt">APAC</td><td style="text-align:right">$197,650</td><td style="text-align:right">+9%</td></tr>',
  '  </tbody>',
  '</table>',
  '',
  '<h2>Try per-glyph font fallback</h2>',
  '<p>',
  '  Load a Latin font <em>and</em> a CJK font from your machine above, then type mixed',
  '  text such as <strong>\u4f55\u5c0f\u982c test</strong>. Characters the Latin face lacks will',
  '  automatically fall back to the CJK face &mdash; no <code>font-family</code> needed.',
  '</p>',
  '',
  '<footer data-band="pageFooter">',
  '  <p style="text-align:center; color:#5b6b8c; font-size:9pt">Page {PAGE} of {TOTAL}</p>',
  '</footer>',
].join('\n');

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

async function loadSelectedFonts() {
  const files = Array.from(fontInput.files ?? []);
  if (!files.length) {
    selectedFonts = [];
    fontListEl.textContent = 'No fonts selected — using base-14 (Latin-1).';
    return;
  }
  status('Reading font files…');
  try {
    selectedFonts = await Promise.all(files.map(parseFontFile));
    fontListEl.textContent = '';
    fontListEl.append(document.createTextNode('Registered: '));
    selectedFonts.forEach((f, i) => {
      const code = document.createElement('code');
      code.textContent = `${f.family} ${f.weight}${f.style === 'italic' ? ' i' : ''}`;
      if (i) fontListEl.append(document.createTextNode(' '));
      fontListEl.append(code);
    });
    status('');
  } catch (err) {
    selectedFonts = [];
    fontListEl.textContent = 'No fonts selected — using base-14 (Latin-1).';
    status('Could not read fonts: ' + err.message, true);
  }
}

fontInput.addEventListener('change', loadSelectedFonts);
document.getElementById('clearfonts').addEventListener('click', () => {
  fontInput.value = '';
  selectedFonts = [];
  fontListEl.textContent = 'No fonts selected — using base-14 (Latin-1).';
});

// ---- generate ------------------------------------------------------------
let lastUrl = null;

async function generate() {
  status('Rendering PDF…');
  downloadEl.hidden = true;
  try {
    const report = htmlToReportDoc(editor.value);
    const bytes = await renderToBuffer(report, { fonts: selectedFonts });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    lastUrl = URL.createObjectURL(blob);
    preview.src = lastUrl;
    downloadEl.href = lastUrl;
    downloadEl.hidden = false;
    status(`Done — ${bytes.byteLength.toLocaleString()} bytes (${(bytes.byteLength / 1024).toFixed(1)} KB).`);
  } catch (err) {
    status('Error: ' + (err && err.message ? err.message : String(err)), true);
    console.error(err);
  }
}

document.getElementById('generate').addEventListener('click', generate);
document.getElementById('reset').addEventListener('click', () => {
  editor.value = DEFAULT_HTML;
  status('HTML reset to the sample report.');
});

function status(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

// Render once on load so the preview is populated immediately.
generate();
