/**
 * Remote-image resolution. The layout pass is synchronous and must never touch
 * the network, so before rendering we run this async pre-pass: it walks the IR,
 * finds `<img>`/`ImageBlock`s whose `src` is an `http(s)` URL, fetches the bytes
 * once, rewrites `src` to those bytes, and fills in the intrinsic size. After it,
 * the offline path (local paths / `data:` / bytes) handles everything as usual.
 */
import { probeImageSize, type ImageSize } from './image.js';
import type { ReportDoc, ImageBlock } from '../ir/schema.js';

export interface ImageResolveOptions {
  /** Fetch `http(s)` image sources. Default `true`. Set `false` for air-gapped renders. */
  fetchRemote?: boolean;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Refuse responses larger than this many bytes. Default 25 MiB. */
  maxBytes?: number;
  /** Custom loader (proxy, auth, cache, fixtures). Overrides the built-in fetch. */
  resolveImage?: (url: string) => Promise<Uint8Array | null>;
  /** What to do when a remote image cannot be loaded. Default `'throw'`. */
  onError?: 'throw' | 'skip';
}

/** Minimal structural types so we compile without relying on DOM lib globals. */
interface Abortable {
  signal?: unknown;
}
interface FetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
type FetchLike = (url: string, init?: Abortable) => Promise<FetchResponse>;

const REMOTE = /^https?:\/\//i;

function isImageBlock(node: unknown): node is ImageBlock {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === 'image' &&
    typeof (node as { src?: unknown }).src === 'string'
  );
}

async function defaultFetch(url: string, opts: ImageResolveOptions): Promise<Uint8Array | null> {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  if (!fetchImpl) throw new Error('global fetch is unavailable (Node 18+ required) for remote images');
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;

  // AbortController/AbortSignal exist as Node globals from 18; typed loosely here.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`image exceeds ${maxBytes} bytes`);
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a report whose remote image blocks have been converted to embedded
 * bytes. The input object is not mutated; only the containing arrays are
 * rebuilt, and image nodes are replaced with fresh objects.
 */
export async function resolveRemoteImages(report: ReportDoc, opts: ImageResolveOptions = {}): Promise<ReportDoc> {
  const fetchRemote = opts.fetchRemote ?? true;
  const cache = new Map<string, ImageSize | Uint8Array | null>();

  const load = async (url: string): Promise<Uint8Array | null> => {
    if (cache.has(url)) {
      const hit = cache.get(url);
      return hit instanceof Uint8Array ? hit : null;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = opts.resolveImage ? await opts.resolveImage(url) : fetchRemote ? await defaultFetch(url, opts) : null;
    } catch (err) {
      if (opts.onError === 'skip') {
        bytes = null;
      } else {
        throw new Error(`Failed to load remote image "${url}": ${(err as Error).message}`);
      }
    }
    cache.set(url, bytes);
    return bytes;
  };

  // Resolve one image node to a replacement (or the same node if nothing changes).
  const resolveNode = async (block: ImageBlock): Promise<ImageBlock> => {
    const src = block.src as string;
    if (!REMOTE.test(src)) return block;
    const bytes = await load(src);
    if (!bytes) {
      if (opts.onError === 'skip') return { ...block, src: '', intrinsic: { width: 0, height: 0 } };
      throw new Error(`Remote image "${src}" could not be resolved (fetchRemote disabled and no resolver supplied)`);
    }
    const intrinsic = block.intrinsic ?? probeImageSize(bytes) ?? undefined;
    return { ...block, src: bytes, intrinsic };
  };

  // Walk a list of blocks, replacing any image nodes in place within the array.
  const resolveBlocks = async <T>(blocks: T[] | undefined): Promise<T[] | undefined> => {
    if (!blocks) return blocks;
    const out = [...blocks];
    for (let i = 0; i < out.length; i += 1) {
      const node = out[i];
      if (isImageBlock(node)) out[i] = (await resolveNode(node)) as unknown as T;
    }
    return out;
  };

  const body = await resolveBlocks(report.body);
  let bands = report.bands;
  if (bands) {
    bands = { ...bands };
    for (const key of Object.keys(bands) as (keyof NonNullable<typeof bands>)[]) {
      const band = bands[key];
      if (band) bands[key] = { ...band, blocks: (await resolveBlocks(band.blocks)) ?? band.blocks };
    }
  }

  return { ...report, ...(body ? { body } : {}), ...(bands ? { bands } : {}) };
}
