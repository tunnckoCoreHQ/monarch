import { type Bytes, concat, text, utf8 } from "./bytes";

export const FLUSH = utf8("0000");

export function pkt(data: string | Uint8Array): Bytes {
  const bytes = typeof data === "string" ? utf8(data) : data;
  const length = (bytes.length + 4).toString(16).padStart(4, "0");
  return concat([utf8(length), bytes]);
}

/** Reads pkt-lines from a buffer. `next()` returns null for a flush and undefined at the end. */
export class PktReader {
  pos: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  next(): Uint8Array | null | undefined {
    if (this.pos + 4 > this.buf.length) {
      return undefined;
    }
    const length = Number.parseInt(text(this.buf.subarray(this.pos, this.pos + 4)), 16);
    if (Number.isNaN(length)) {
      return undefined;
    }
    if (length < 4) {
      this.pos += 4;
      return null;
    }
    const data = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return data;
  }

  nextLine(): string | null | undefined {
    const data = this.next();
    if (data === null || data === undefined) {
      return data;
    }
    const line = text(data);
    return line.endsWith("\n") ? line.slice(0, -1) : line;
  }
}
