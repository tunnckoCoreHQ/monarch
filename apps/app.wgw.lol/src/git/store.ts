import type { GitObject, ObjectType } from "./objects";

export interface RawObject {
  type: ObjectType;
  size: number;
  /** The zlib stream, or undefined when the object lives outside the store, in R2. */
  zdata?: Uint8Array;
}

/** Synchronous object access. The Durable Object backs it with SQLite; tests back it with a Map. */
export interface ObjectStore {
  read(sha: string): GitObject | undefined;
  raw(sha: string): RawObject | undefined;
  has(sha: string): boolean;
  write(type: ObjectType, content: Uint8Array): string;
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
