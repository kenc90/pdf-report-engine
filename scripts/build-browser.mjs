/**
 * Browser bundle build.
 *
 * Produces two artifacts in docs/browser/:
 *   1. pdf-report-engine.js — the bundled ESM library. `wawoff2` is externalized
 *      (see remote.ts's `ensureBrowserWawoff2Ready`) so the browser build does
 *      not inline the broken Emscripten-CJS interop.
 *   2. wawoff2-decoder.js — a verbatim copy of wawoff2's decompress_binding.
 *      Loaded via <script> at runtime, its top-level `var Module` binds to
 *      `window.Module`, which our engine then hooks into. This avoids the
 *      bundler issue where `module.exports = Module` (assigned only in the
 *      ENVIRONMENT_IS_NODE branch of the Emscripten code) is stripped, leaving
 *      the browser path unable to receive the `onRuntimeInitialized` callback.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const outDir = 'docs/browser';
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  alias: { pdfkit: './node_modules/pdfkit/js/pdfkit.standalone.js' },
  external: ['node:fs/promises', 'fs', 'path', 'wawoff2'],
  minify: true,
  outfile: path.join(outDir, 'pdf-report-engine.js'),
});

// Copy wawoff2's decompress binding next to the bundle so it can be loaded
// as a classic (non-module) script at runtime.
const src = 'node_modules/wawoff2/build/decompress_binding.js';
const dst = path.join(outDir, 'wawoff2-decoder.js');
fs.copyFileSync(src, dst);
console.log(`[build-browser] wrote ${path.join(outDir, 'pdf-report-engine.js')} and ${dst}`);
