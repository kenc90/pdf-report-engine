/**
 * Bounded response-body reading for the two online pre-passes
 * (`resolveRemoteImages`, `resolveRemoteFonts`).
 *
 * A `maxBytes` cap only protects the host if the body is refused *before* it is
 * buffered. Reading `await res.arrayBuffer()` and checking the length afterwards
 * allocates the whole payload first — so a 2 GiB response is fully in memory by
 * the time the limit "trips". Instead we reject on a declared `content-length`,
 * then count chunks as they arrive and cancel the stream the moment the running
 * total goes over.
 *
 * Hosts needing finer control (proxy, auth, cache, or their own cancellation)
 * bypass this entirely by supplying `resolveImage` / `resolveFont`.
 *
 * Types are declared structurally rather than leaning on DOM globals, matching
 * the rest of `core/`: the same code has to typecheck for Node and for a browser
 * bundle, and stubs used in tests only need the handful of members we read.
 */

/** The `ReadableStream` reader members we use; absent in older shims. */
interface BodyReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array | ArrayBuffer | null }>;
  cancel(reason?: unknown): unknown;
  releaseLock?(): void;
}

/** The response members we use. `headers` / `body` are optional so stubs still typecheck. */
export interface LimitedFetchResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get?(name: string): string | null } | null;
  body?: { getReader?(): BodyReader } | null;
}

/** Declared body length from `content-length`, or `null` when absent / unparseable. */
function declaredBytes(res: LimitedFetchResponse): number | null {
  const raw = res.headers?.get?.('content-length');
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function cancelQuietly(reader: BodyReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The body was already broken; we are discarding it either way.
  }
}

function join(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * Read a response body as bytes, never holding more than `maxBytes` of it.
 *
 * `label` prefixes the rejection so callers keep their existing message shape
 * (`"image exceeds N bytes"`, `"font exceeds N bytes"`).
 */
export async function readBoundedBytes(
  res: LimitedFetchResponse,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const tooBig = () => new Error(`${label} exceeds ${maxBytes} bytes`);

  const declared = declaredBytes(res);
  if (declared !== null && declared > maxBytes) throw tooBig();

  const reader = res.body?.getReader?.();
  if (!reader) {
    // No iterable body (a fetch shim without streams, or a test stub): fall back
    // to the single-buffer read we used before, still rejecting an oversized result.
    const bytes = asBytes(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw tooBig();
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;
      const chunk = asBytes(value);
      total += chunk.length;
      if (total > maxBytes) {
        await cancelQuietly(reader);
        throw tooBig();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return join(chunks, total);
}
