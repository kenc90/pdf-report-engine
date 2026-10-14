import PDFDocument from 'pdfkit';
import { readFileSync, createWriteStream, mkdirSync } from 'node:fs';
import { FontRegistry } from '../src/fonts/registry.js';

mkdirSync('out', { recursive: true });
const doc = new PDFDocument({ margin: 0, size: 'A4' });
doc.pipe(createWriteStream('out/smoke.pdf'));

const reg = new FontRegistry();
const arial = reg.register(doc, {
  family: 'Arial',
  weight: 400,
  buffer: new Uint8Array(readFileSync('C:/Windows/Fonts/arial.ttf')),
});
const calibri = reg.register(doc, {
  family: 'Calibri',
  weight: 400,
  buffer: new Uint8Array(readFileSync('C:/Windows/Fonts/calibri.ttf')),
});
const yahei = reg.register(doc, {
  family: 'MSYaHei',
  weight: 400,
  postscriptName: 'MicrosoftYaHei',
  buffer: new Uint8Array(readFileSync('C:/Windows/Fonts/msyh.ttc')),
});

console.log('arial metrics', arial.ascender, arial.descender, arial.xHeight, arial.capHeight, arial.lineGap, arial.unitsPerEm);
console.log('width "Hello World" @12 =', arial.widthOf('Hello World', 12));
console.log('kerned AV @24 =', arial.widthOf('AV', 24), 'sum(A,V) =', arial.widthOf('A', 24) + arial.widthOf('V', 24));
console.log('ligature fi @24 =', arial.widthOf('fi', 24), 'f+i =', arial.widthOf('f', 24) + arial.widthOf('i', 24));
console.log('calibri "Hello World" @12 =', calibri.widthOf('Hello World', 12));
console.log('yahei 中文字 @12 =', yahei.widthOf('中文字', 12), 'has 中?', yahei.hasGlyphsFor('中'));
console.log('arial has 中?', arial.hasGlyphsFor('中'));
console.log('tnum: 1111 =', arial.widthOf('1111', 12), 'iiii =', arial.widthOf('iiii', 12), '1111+tnum =', arial.widthOf('1111', 12, { tnum: true }));
console.log('resolve stack:', reg.resolve(['Calibri', 'Arial'], 400).key, '| weight 700 ->', reg.resolve(['Arial'], 700).key);

doc.text('Searchable text: Hello World 3 of 3', 40, 40, { lineBreak: false });
doc.text('AV To Wa fi fligaere', 40, 60, { lineBreak: false });
doc.font('MSYaHei|400|normal');
doc.text('中文字測試 searchable CJK', 40, 80, { lineBreak: false });
doc.end();
