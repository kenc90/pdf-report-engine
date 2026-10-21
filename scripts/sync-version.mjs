/**
 * Keep the human-visible version in sync with package.json.
 *
 * Run automatically by the `npm version` lifecycle (see package.json "version"
 * script), or manually with:  node scripts/sync-version.mjs
 *
 * It stamps the version into two places so there is exactly one source of
 * truth (package.json):
 *   1. docs/assets/site.js  -> the `var VERSION = '…'` constant, which site.js
 *      stamps into every `[data-version]` placeholder across the docs pages.
 *   2. README.md            -> the shields.io version badge URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function stamp(file, re, make) {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, 'utf8');
  if (!re.test(src)) {
    console.error(`[sync-version] could not find the version marker in ${file}`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(p, src.replace(re, make));
  console.log(`[sync-version] ${file} -> v${version}`);
}

stamp(
  path.join('docs', 'assets', 'site.js').replace(/\\/g, '/'),
  /var VERSION = '[^']*';/,
  `var VERSION = '${version}';`,
);

stamp(
  'README.md',
  /version-.+-brightgreen/,
  `version-${version}-brightgreen`,
);
