/**
 * EAN-13 encoder.
 *
 * Accepts 12 digits (the check digit is computed) or 13 (it is validated).
 * The first digit selects the L/G parity pattern for the left half; the right
 * half always uses R (the bitwise complement of L).
 */

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = L.map((code) => code.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));

// First digit → L/G parity for the six left-hand digits.
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Normalise to 13 digits, computing or validating the check digit. */
export function normalizeEan13(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 12) return digits + checkDigit(digits);
  if (digits.length === 13) {
    if (checkDigit(digits.slice(0, 12)) !== digits[12]) {
      throw new Error(`EAN-13 checksum mismatch for ${digits}`);
    }
    return digits;
  }
  throw new Error('EAN-13 requires 12 or 13 digits');
}

function checkDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/** Encode 13 normalised digits as a module string, including guard bars. */
export function encodeEan13(digits13: string): string {
  const parity = PARITY[Number(digits13[0])]!;
  let bits = '101';
  for (let i = 1; i <= 6; i += 1) {
    const digit = Number(digits13[i]);
    bits += parity[i - 1] === 'L' ? L[digit]! : G[digit]!;
  }
  bits += '01010';
  for (let i = 7; i <= 12; i += 1) bits += R[Number(digits13[i])]!;
  bits += '101';
  return bits;
}

/** Quiet zone in modules on the left (11) and right (7) of an EAN-13 symbol. */
export const EAN13_QUIET = 18;
