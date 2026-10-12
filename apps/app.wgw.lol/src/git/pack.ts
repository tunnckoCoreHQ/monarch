import { type Bytes, concat, fromHex, sha1Hex, text, toHex, utf8 } from "./bytes";
import { type GitObject, type ObjectType, objectHash, TYPE_CODE, TYPE_NAME } from "./objects";
import { deflate, inflateAt } from "./zlib";

const OFS_DELTA = 6;
const REF_DELTA = 7;

export interface PackedObject extends GitObject {
  sha: string;
  /** The zlib stream of `content`, reused from the pack when the entry was not a delta. */
  zdata: Uint8Array;
}

interface Entry {
  offset: number;
  code: number;
  data: Uint8Array;
  raw?: Uint8Array;
  baseOffset?: number;
  baseSha?: string;
  resolved?: PackedObject;
}

/** The largest object a pack may hold, and the most a pack may expand to in total. */
export const MAX_OBJECT_SIZE = 64 * 1024 * 1024;
export const MAX_EXPANDED_SIZE = 96 * 1024 * 1024;

/** A pack that is over a size limit. A mirror fetch retries it in smaller pieces. */
export class PackLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackLimitError";
  }
}

function checkSize(size: number): void {
  if (size > MAX_OBJECT_SIZE) {
    throw new PackLimitError(`object of ${size} bytes is over the ${MAX_OBJECT_SIZE} byte limit`);
  }
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const readSize = () => {
    let size = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return size;
  };
  const baseSize = readSize();
  if (baseSize !== base.length) {
    throw new Error("delta base size mismatch");
  }
  const resultSize = readSize();
  checkSize(resultSize);
  const out = new Uint8Array(resultSize);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) {
          offset |= delta[pos++] << (i * 8);
        }
      }
      for (let i = 0; i < 3; i++) {
        if (op & (1 << (4 + i))) {
          size |= delta[pos++] << (i * 8);
        }
      }
      if (size === 0) {
        size = 0x10000;
      }
      out.set(base.subarray(offset >>> 0, (offset >>> 0) + size), outPos);
      outPos += size;
    } else if (op > 0) {
      out.set(delta.subarray(pos, pos + op), outPos);
      pos += op;
      outPos += op;
    } else {
      throw new Error("invalid delta opcode");
    }
  }
  if (outPos !== out.length) {
    throw new Error("delta result size mismatch");
  }
  return out;
}

/**
 * Parses a version 2 packfile and resolves every delta. `external` supplies bases that a thin pack
 * leaves out.
 */
export function parsePack(
  pack: Uint8Array,
  external: (sha: string) => GitObject | undefined,
): PackedObject[] {
  if (text(pack.subarray(0, 4)) !== "PACK") {
    throw new Error("not a packfile");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported pack version ${version}`);
  }
  const count = view.getUint32(8);
  const trailer = toHex(pack.subarray(-20));
  if (sha1Hex([pack.subarray(0, -20)]) !== trailer) {
    throw new Error("pack checksum mismatch");
  }

  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let pos = 12;
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let byte = pack[pos++];
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Entry = { offset, code, data: new Uint8Array() };
    if (code === OFS_DELTA) {
      byte = pack[pos++];
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = offset - distance;
    } else if (code === REF_DELTA) {
      entry.baseSha = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    }
    checkSize(size);
    expanded += size;
    if (expanded > MAX_EXPANDED_SIZE) {
      throw new PackLimitError(`the pack expands past the ${MAX_EXPANDED_SIZE} byte limit`);
    }
    const { data, used } = inflateAt(pack, pos, size);
    entry.data = data;
    if (code !== OFS_DELTA && code !== REF_DELTA) {
      entry.raw = pack.slice(pos, pos + used);
    }
    pos += used;
    entries.push(entry);
    byOffset.set(offset, entry);
  }

  const bySha = new Map<string, Entry>();
  const externals = new Map<string, GitObject | undefined>();
  const lookup = (sha: string): GitObject | undefined => {
    if (!externals.has(sha)) {
      externals.set(sha, external(sha));
    }
    return externals.get(sha);
  };
  const available = (entry: Entry): boolean => {
    if (entry.resolved !== undefined) {
      return true;
    }
    if (entry.baseOffset !== undefined) {
      const base = byOffset.get(entry.baseOffset);
      return base !== undefined && available(base);
    }
    if (entry.baseSha !== undefined) {
      return bySha.has(entry.baseSha) || lookup(entry.baseSha) !== undefined;
    }
    return true;
  };
  const resolve = (entry: Entry): PackedObject => {
    if (entry.resolved !== undefined) {
      return entry.resolved;
    }
    let type: ObjectType;
    let content: Uint8Array;
    if (entry.code === OFS_DELTA || entry.code === REF_DELTA) {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        base = baseEntry === undefined ? undefined : resolve(baseEntry);
      } else if (entry.baseSha !== undefined) {
        const baseEntry = bySha.get(entry.baseSha);
        base = baseEntry === undefined ? lookup(entry.baseSha) : resolve(baseEntry);
      }
      if (base === undefined) {
        throw new Error(`missing delta base ${entry.baseSha ?? entry.baseOffset}`);
      }
      type = base.type;
      content = applyDelta(base.content, entry.data);
      expanded += content.length;
      if (expanded > MAX_EXPANDED_SIZE) {
        throw new PackLimitError(`the pack expands past the ${MAX_EXPANDED_SIZE} byte limit`);
      }
    } else {
      type = TYPE_NAME[entry.code];
      content = entry.data;
    }
    const sha = objectHash(type, content);
    entry.resolved = { sha, type, content, zdata: entry.raw ?? deflate(content) };
    bySha.set(sha, entry);
    return entry.resolved;
  };

  // Plain objects first, so REF_DELTA entries can find in-pack bases by hash.
  for (const entry of entries) {
    if (entry.code !== OFS_DELTA && entry.code !== REF_DELTA) {
      resolve(entry);
    }
  }
  let pending = entries.filter((entry) => entry.resolved === undefined);
  while (pending.length > 0) {
    const before = pending.length;
    for (const entry of pending) {
      if (available(entry)) {
        resolve(entry);
      }
    }
    pending = pending.filter((entry) => entry.resolved === undefined);
    if (pending.length === before) {
      throw new Error(`missing delta base ${pending[0].baseSha ?? pending[0].baseOffset}`);
    }
  }
  return entries.map((entry) => entry.resolved!);
}

function entryHeader(type: ObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

export interface PackSource {
  type: ObjectType;
  size: number;
  zdata: Uint8Array;
}

/** Writes a packfile without deltas. Each entry reuses the stored zlib stream. */
export function writePack(objects: PackSource[]): Bytes {
  const header = new Uint8Array(12);
  header.set(utf8("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const object of objects) {
    parts.push(entryHeader(object.type, object.size), object.zdata);
  }
  const body = concat(parts);
  return concat([body, fromHex(sha1Hex([body]))]);
}
