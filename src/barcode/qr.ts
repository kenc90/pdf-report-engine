/**
 * QR Code Model 2 encoder (byte mode, versions 1-40, all four error-correction
 * levels), self-contained and dependency-free.
 *
 * The block geometry comes from the standard's two tables (ECC codewords per
 * block, block count per version/level); everything else — Reed-Solomon over
 * GF(2^8), function patterns, masking, penalty scoring — is computed here.
 */
export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  /** Modules per side (21..177). */
  size: number;
  /** Row-major module grid; `true` is dark. */
  modules: boolean[][];
  version: number;
  mask: number;
}

/** Error-correction level ordinal, also the row index in the tables below. */
const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** ECC level → the two format bits stored in the symbol. */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Version 0 is padding. Rows are L, M, Q, H.
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export function encodeQR(text: string, level: QrEcc = 'M'): QrCode {
  const data = utf8Bytes(text);
  const ordinal = ECC_ORDINAL[level];

  let version = 0;
  for (let v = 1; v <= 40; v += 1) {
    const capacity = numDataCodewords(v, ordinal) * 8;
    if (capacity >= 4 + byteCountBits(v) + data.length * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error(`QR payload too long for ${level} (${data.length} bytes)`);

  const dataCodewords = buildDataCodewords(data, version, ordinal);
  const allCodewords = addEccAndInterleave(dataCodewords, version, ordinal);

  const size = version * 4 + 17;
  const modules = new Array<boolean[]>(size);
  const isFunction = new Array<boolean[]>(size);
  for (let i = 0; i < size; i += 1) {
    modules[i] = new Array<boolean>(size).fill(false);
    isFunction[i] = new Array<boolean>(size).fill(false);
  }

  drawFunctionPatterns(modules, isFunction, size, version, level);
  drawCodewords(modules, isFunction, size, allCodewords);

  let mask = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let m = 0; m < 8; m += 1) {
    applyMask(modules, isFunction, size, m);
    drawFormatBits(modules, isFunction, size, level, m);
    const penalty = penaltyScore(modules, size);
    if (penalty < best) {
      best = penalty;
      mask = m;
    }
    applyMask(modules, isFunction, size, m);
  }
  applyMask(modules, isFunction, size, mask);
  drawFormatBits(modules, isFunction, size, level, mask);

  return { size, modules, version, mask };
}

// --- data ------------------------------------------------------------------

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function byteCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function numDataCodewords(version: number, ordinal: number): number {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ordinal]![version]! * NUM_BLOCKS[ordinal]![version]!;
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function buildDataCodewords(data: number[], version: number, ordinal: number): number[] {
  const bits: number[] = [];
  appendBits(0b0100, 4, bits); // Byte mode
  appendBits(data.length, byteCountBits(version), bits);
  for (const b of data) appendBits(b, 8, bits);

  const capacity = numDataCodewords(version, ordinal) * 8;
  appendBits(0, Math.min(4, capacity - bits.length), bits);
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  // Standard pad bytes, alternating, until the data capacity is filled.
  for (let pad = 0xec; codewords.length < capacity / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

function appendBits(value: number, length: number, out: number[]): void {
  for (let i = length - 1; i >= 0; i -= 1) out.push((value >>> i) & 1);
}

// --- error correction ------------------------------------------------------

function addEccAndInterleave(data: number[], version: number, ordinal: number): number[] {
  const numBlocks = NUM_BLOCKS[ordinal]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ordinal]![version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      // Skip the padding slot inserted in short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j]![i]!);
    }
  }
  return result;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = rsMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) result[i] = result[i]! ^ rsMultiply(divisor[i]!, factor);
  }
  return result;
}

function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// --- function patterns -----------------------------------------------------

function drawFunctionPatterns(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  version: number,
  level: QrEcc,
): void {
  for (let i = 0; i < size; i += 1) {
    setFunction(modules, isFunction, 6, i, i % 2 === 0);
    setFunction(modules, isFunction, i, 6, i % 2 === 0);
  }
  drawFinder(modules, isFunction, size, 3, 3);
  drawFinder(modules, isFunction, size, size - 4, 3);
  drawFinder(modules, isFunction, size, 3, size - 4);

  const positions = alignmentPositions(version, size);
  const n = positions.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(modules, isFunction, positions[i]!, positions[j]!);
    }
  }

  drawFormatBits(modules, isFunction, size, level, 0);
  drawVersionBits(modules, isFunction, size, version);
}

function setFunction(
  modules: boolean[][],
  isFunction: boolean[][],
  x: number,
  y: number,
  dark: boolean,
): void {
  modules[y]![x] = dark;
  isFunction[y]![x] = true;
}

function drawFinder(modules: boolean[][], isFunction: boolean[][], size: number, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(modules, isFunction, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(modules: boolean[][], isFunction: boolean[][], cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(modules, isFunction, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormatBits(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  level: QrEcc,
  mask: number,
): void {
  const data = (ECC_FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i += 1) setFunction(modules, isFunction, 8, i, bit(bits, i));
  setFunction(modules, isFunction, 8, 7, bit(bits, 6));
  setFunction(modules, isFunction, 8, 8, bit(bits, 7));
  setFunction(modules, isFunction, 7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) setFunction(modules, isFunction, 14 - i, 8, bit(bits, i));

  for (let i = 0; i < 8; i += 1) setFunction(modules, isFunction, size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) setFunction(modules, isFunction, 8, size - 15 + i, bit(bits, i));
  setFunction(modules, isFunction, 8, size - 8, true);
}

function drawVersionBits(modules: boolean[][], isFunction: boolean[][], size: number, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const dark = bit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(modules, isFunction, a, b, dark);
    setFunction(modules, isFunction, b, a, dark);
  }
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

// --- codewords + masking ---------------------------------------------------

function drawCodewords(modules: boolean[][], isFunction: boolean[][], size: number, data: number[]): void {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && i < data.length * 8) {
          modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

function applyMask(modules: boolean[][], isFunction: boolean[][], size: number, mask: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isFunction[y]![x]) continue;
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y]![x] = !modules[y]![x];
    }
  }
}

// --- mask selection --------------------------------------------------------

function penaltyScore(modules: boolean[][], size: number): number {
  let result = 0;

  for (let y = 0; y < size; y += 1) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x += 1) {
      if (modules[y]![x] === runColor) {
        runLength += 1;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result += 1;
      } else {
        addHistory(history, runLength, size);
        if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
        runColor = modules[y]![x]!;
        runLength = 1;
      }
    }
    result += terminateAndCount(history, runColor, runLength, size) * PENALTY_N3;
  }

  for (let x = 0; x < size; x += 1) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y += 1) {
      if (modules[y]![x] === runColor) {
        runLength += 1;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result += 1;
      } else {
        addHistory(history, runLength, size);
        if (!runColor) result += countFinderPatterns(history) * PENALTY_N3;
        runColor = modules[y]![x]!;
        runLength = 1;
      }
    }
    result += terminateAndCount(history, runColor, runLength, size) * PENALTY_N3;
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y]![x]!;
      if (color === modules[y]![x + 1] && color === modules[y + 1]![x] && color === modules[y + 1]![x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

function addHistory(history: number[], runLength: number, size: number): void {
  if (history[0] === 0) runLength += size;
  history.pop();
  history.unshift(runLength);
}

function countFinderPatterns(history: number[]): number {
  const n = history[1]!;
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (
    (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
    (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
  );
}

function terminateAndCount(history: number[], runColor: boolean, runLength: number, size: number): number {
  if (runColor) {
    addHistory(history, runLength, size);
    runLength = 0;
  }
  return countFinderPatterns(historyWithBorder(history, runLength + size, size));
}

/** `addHistory` mutates; this returns the post-push view for counting. */
function historyWithBorder(history: number[], runLength: number, size: number): number[] {
  const copy = history.slice();
  addHistory(copy, runLength, size);
  return copy;
}
