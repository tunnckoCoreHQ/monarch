import { createHash } from "node:crypto";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Bytes backed by a plain ArrayBuffer, which Response and fetch accept as a body. */
export type Bytes = Uint8Array<ArrayBuffer>;

export function concat(parts: Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function fromHex(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function sha1Hex(parts: Uint8Array[]): string {
  const hash = createHash("sha1");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
}

export async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) {
    return new Uint8Array();
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
