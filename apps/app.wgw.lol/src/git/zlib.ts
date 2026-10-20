import {
  deflate as pakoDeflate,
  inflate as pakoInflate,
  ZStream,
  Z_FINISH,
  Z_STREAM_END,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateInit,
} from "pako";

export function deflate(data: Uint8Array): Uint8Array {
  return pakoDeflate(data, { level: 6 });
}

export function inflate(data: Uint8Array): Uint8Array {
  return pakoInflate(data);
}

/**
 * Inflates one zlib stream that starts at `offset` inside `buf` and reports how many compressed
 * bytes it used. Packfiles do not record compressed lengths, so this finds the next entry.
 */
export function inflateAt(
  buf: Uint8Array,
  offset: number,
  size: number,
): { data: Uint8Array; used: number } {
  const strm = new ZStream();
  zlibInflateInit(strm);
  strm.input = buf;
  strm.next_in = offset;
  strm.avail_in = buf.length - offset;
  // Room past `size` lets zlib read the end-of-stream marker and checksum.
  strm.output = new Uint8Array(size + 64);
  strm.next_out = 0;
  strm.avail_out = size + 64;
  const status = zlibInflate(strm, Z_FINISH);
  const used = strm.next_in - offset;
  const produced = strm.next_out;
  const output = strm.output;
  zlibInflateEnd(strm);
  if (status !== Z_STREAM_END || produced !== size) {
    throw new Error(`corrupt zlib stream at offset ${offset}`);
  }
  return { data: output.subarray(0, size), used };
}
