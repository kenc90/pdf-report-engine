import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { create as createEsm } from 'fontkit';

const bytes = new Uint8Array(readFileSync('C:/Windows/Fonts/arial.ttf'));

// What does the CJS pdfkit entry resolve to vs the ESM one?
const cjsFontkit = await import('module').then(async (m) => {
  const { createRequire } = m;
  const require = createRequire(import.meta.url);
  return require('fontkit');
});
console.log('same create fn as ESM?', cjsFontkit.create === createEsm);

const doc = new PDFDocument({ margin: 0 });
try {
  doc.registerFont('probe-cjs', Buffer.from(bytes));
  doc.font('probe-cjs');
  console.log('OK via register with explicit family omitted');
} catch (e) {
  console.log('FAIL', (e as Error).message);
}

// Which pdfkit file did we get?
console.log('pdfkit resolved:', import.meta.resolve('pdfkit'));
console.log('fontkit resolved:', import.meta.resolve('fontkit'));
