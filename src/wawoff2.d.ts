// Minimal ambient types for the optional WOFF2 decoder (ships no .d.ts).
declare module 'wawoff2' {
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>;
  export function compress(ttf: Uint8Array): Promise<Uint8Array>;
}
