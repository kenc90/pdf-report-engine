/**
 * Minimal dependency-free static server for the docs site in `docs/`.
 *
 *   node scripts/serve-site.mjs        # http://localhost:5173
 *   node scripts/serve-site.mjs 8080   # custom port
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('docs');
const port = Number(process.argv[2]) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));

  // Contain within docs/ (compare against root + separator so a sibling like
  // `docs-evil` can't slip past the prefix check) — and only serve real files.
  const inside = filePath === root || filePath.startsWith(root + path.sep);
  if (!inside || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, () => console.log(`[serve-site] http://localhost:${port}  (root: ${root})`));
