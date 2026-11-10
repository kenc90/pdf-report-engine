import fs from 'node:fs';
import path from 'node:path';

const docsDir = 'docs';
fs.mkdirSync(docsDir, { recursive: true });

for (const file of ['llms.txt', 'llms-full.txt']) {
  const source = path.resolve(file);
  const destination = path.join(docsDir, file);
  if (!fs.existsSync(source)) throw new Error(`Missing AI reference source: ${source}`);
  fs.copyFileSync(source, destination);
  console.log(`[sync-llms] ${source} -> ${destination}`);
}
