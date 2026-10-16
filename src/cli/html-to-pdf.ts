/**
 * `html-to-pdf` CLI: convert constrained authoring HTML into a real, paginated,
 * selectable-text PDF using the pdf-report-engine.
 *
 * Usage:
 *   html-to-pdf <input...> [options]
 *
 * Inputs are HTML files and/or directories (a directory contributes its top-level
 * `*.html`). Each input file is written as a same-named `.pdf` (see `-o`).
 *
 * Options:
 *   -o, --out <path>    Output path. A directory (or no -o) keeps the input's base
 *                       name; a `.pdf` path is used verbatim (single input only).
 *                       Default: alongside each input file.
 *   -d, --data <file>   JSON file whose object becomes the report `data` root,
 *                       available to `data-each` / `data-bind` expressions.
 *   -f, --font <spec>   Register an embeddable font. Repeatable. Accepts either
 *                       `<path>` (family inferred from the filename) or
 *                       `<family>=<path>` with an optional `:weight` suffix,
 *                       e.g. `--font Arial=C:/Windows/Fonts/arialbd.ttf:700`.
 *                       For TrueType collections (.ttc) append `#<PostScriptName>`
 *                       to select a face, e.g.
 *                       `--font "PMingLiU=C:/Windows/Fonts/mingliu.ttc#PMingLiU"`.
 *                       Explicit fonts are added to (and override per family+weight)
 *                       the auto-loaded system fonts unless `--no-auto-fonts` is set,
 *                       so adding e.g. Times New Roman keeps the CJK face available.
 *   --no-auto-fonts     Do not try to load common system fonts automatically.
 *   --page <spec>       Base font size in points for the document (default 11).
 *   -h, --help          Show this help.
 *
 * With no `--font` and auto-fonts enabled, it opportunistically loads Arial /
 * Georgia / Microsoft YaHei from the Windows font folder when present; otherwise
 * it falls back to the standard PDF base-14 fonts (Latin-1, not embedded).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { htmlToReportDoc, renderToBuffer, readFontFiles, type FontFileEntry } from '../index.js';

const FONT_DIR = 'C:/Windows/Fonts';
const AUTO_FONTS: FontFileEntry[] = [
  { family: 'Arial', path: path.join(FONT_DIR, 'arial.ttf'), weight: 400 },
  { family: 'Arial', path: path.join(FONT_DIR, 'arialbd.ttf'), weight: 700 },
  { family: 'Arial', path: path.join(FONT_DIR, 'ariali.ttf'), weight: 400, style: 'italic' },
  { family: 'Georgia', path: path.join(FONT_DIR, 'georgia.ttf'), weight: 400 },
  { family: 'Microsoft YaHei', path: path.join(FONT_DIR, 'msyh.ttc'), postscriptName: 'MicrosoftYaHei' },
];

const HELP = `html-to-pdf — convert authoring HTML to a paginated PDF

Usage: html-to-pdf <input...> [options]

  -o, --out <path>    Output file or directory (default: alongside each input)
  -d, --data <file>   JSON data root for data-each / data-bind tables
                      (default: an adjacent <name>.data.json, if present)
  -f, --font <spec>    Embed a font: <path> or <family>=<path>[:weight][#psName]
                      (repeatable; added to auto-fonts unless --no-auto-fonts)
      --page <pt>     Base font size in points (default 11)
      --no-auto-fonts Skip automatic system-font loading
  -h, --help          Show this help

Examples:
  html-to-pdf samples/invoice.html
  html-to-pdf samples/report.html -o out/report.pdf
  html-to-pdf samples/roster.html --data samples/roster.data.json
  html-to-pdf samples/                       # every *.html in the folder
`;

interface CliOptions {
  inputs: string[];
  out?: string;
  dataFile?: string;
  fontSpecs: string[];
  autoFonts: boolean;
  baseFontSize: number;
}

function parseArgs(argv: string[]): CliOptions | 'help' {
  const opts: CliOptions = { inputs: [], fontSpecs: [], autoFonts: true, baseFontSize: 11 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Option ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '-o':
      case '--out':
        opts.out = next();
        break;
      case '-d':
      case '--data':
        opts.dataFile = next();
        break;
      case '-f':
      case '--font':
        opts.fontSpecs.push(next());
        break;
      case '--page':
        opts.baseFontSize = Number(next());
        if (!Number.isFinite(opts.baseFontSize) || opts.baseFontSize <= 0) throw new Error('--page must be a positive number (points)');
        break;
      case '--no-auto-fonts':
        opts.autoFonts = false;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        opts.inputs.push(arg);
    }
  }
  if (opts.inputs.length === 0) return 'help';
  return opts;
}

/** Expand file/dir inputs into the concrete list of HTML files to process. */
function collectHtmlFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(input)) {
        if (entry.toLowerCase().endsWith('.html') || entry.toLowerCase().endsWith('.htm')) {
          files.push(path.join(input, entry));
        }
      }
    } else if (stat.isFile()) {
      files.push(input);
    } else {
      throw new Error(`Input is not a file or directory: ${input}`);
    }
  }
  return files;
}

/** Parse a `--font` spec into a FontFileEntry. */
function parseFontSpec(spec: string): FontFileEntry {
  const eq = spec.indexOf('=');
  const family = eq >= 0 ? spec.slice(0, eq) : '';
  let rest = eq >= 0 ? spec.slice(eq + 1) : spec;
  let weight: number | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    const maybeWeight = Number(rest.slice(colon + 1));
    if (Number.isFinite(maybeWeight)) {
      weight = maybeWeight;
      rest = rest.slice(0, colon);
    }
  }
  // TrueType collections (.ttc) hold several faces; select one by its PostScript
  // name with a `#` suffix, e.g. `mingliu.ttc#PMingLiU`.
  let postscriptName: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    postscriptName = rest.slice(hash + 1).trim() || undefined;
    rest = rest.slice(0, hash);
  }
  const fontPath = rest;
  if (!fs.existsSync(fontPath)) throw new Error(`Font file not found: ${fontPath}`);
  const inferredFamily = family || path.basename(fontPath).replace(/\.[^.]+$/, '');
  return { family: inferredFamily, path: fontPath, weight, postscriptName };
}

function resolveFonts(opts: CliOptions): FontFileEntry[] {
  const explicit = opts.fontSpecs.map(parseFontSpec);
  const entries: FontFileEntry[] = [...explicit];
  // Auto-loaded system fonts are additive: they fill in families the user did not
  // override (notably the CJK face), so `--font Times…` still keeps YaHei available.
  if (opts.autoFonts) {
    for (const auto of AUTO_FONTS) {
      if (!auto.path || !fs.existsSync(auto.path)) continue;
      const overridden = explicit.some(
        (e) => e.family.toLowerCase() === auto.family.toLowerCase() && (e.weight ?? 400) === (auto.weight ?? 400),
      );
      if (!overridden) entries.push(auto);
    }
  }
  return entries;
}

/** Decide the output `.pdf` path for a given input file. */
function outputPathFor(input: string, opts: CliOptions, single: boolean): string {
  const base = path.basename(input).replace(/\.(html?|htm)$/i, '') + '.pdf';
  // No -o: write next to the input.
  if (!opts.out) return path.join(path.dirname(input), base);
  // Single input + an explicit `.pdf` path: use it verbatim.
  if (single && /\.pdf$/i.test(opts.out)) {
    const dir = path.dirname(opts.out);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    return opts.out;
  }
  // Otherwise treat -o as a directory.
  fs.mkdirSync(opts.out, { recursive: true });
  return path.join(opts.out, base);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(HELP);
    return;
  }
  const opts = parsed;

  const files = collectHtmlFiles(opts.inputs);

  const fontEntries = resolveFonts(opts);
  const fonts = fontEntries.length ? await readFontFiles(fontEntries) : [];

  console.log(`[html-to-pdf] fonts: ${fonts.length ? fonts.map((f) => `${f.family}(${f.weight})`).join(', ') : 'base-14 fallback (Latin-1)'}`);

  // Resolve the JSON data root for one input: explicit `--data`, else an adjacent
  // `<name>.data.json` (auto-paired) so directory runs populate bound tables.
  const dataFor = (file: string): Record<string, unknown> | undefined => {
    const src = opts.dataFile ?? file.replace(/\.html?$/i, '') + '.data.json';
    if (!fs.existsSync(src)) {
      if (opts.dataFile) throw new Error(`Data file not found: ${src}`);
      return undefined;
    }
    return JSON.parse(fs.readFileSync(src, 'utf8')) as Record<string, unknown>;
  };

  const single = files.length === 1;
  let failed = 0;
  for (const file of files) {
    try {
      const html = fs.readFileSync(file, 'utf8');
      const report = htmlToReportDoc(html, {
        data: dataFor(file),
        style: { fontSize: opts.baseFontSize },
        baseDir: path.dirname(path.resolve(file)),
      });
      const buffer = await renderToBuffer(report, { fonts });
      const out = outputPathFor(file, opts, single);
      fs.writeFileSync(out, buffer);
      const pages = (buffer.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
      console.log(`[html-to-pdf] ${path.relative(process.cwd(), file)} -> ${path.relative(process.cwd(), out)}  (${buffer.length} bytes, ~${pages || '?'} pages)`);
    } catch (err) {
      failed += 1;
      console.error(`[html-to-pdf] FAILED ${file}: ${(err as Error).message}`);
    }
  }

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[html-to-pdf] error:', (err as Error).message);
  process.exitCode = 1;
});
