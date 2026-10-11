import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/git/bytes";
import { serializeCommit, serializeTree, parseTree } from "../src/git/objects";
import { applyDelta, MAX_OBJECT_SIZE } from "../src/git/pack";
import { FLUSH, pkt } from "../src/git/pktline";
import { readCommands } from "../src/git/protocol";
import { PrivateRules } from "../src/git/rules";
import { EMPTY_TREE } from "../src/git/store";
import { mergeBase } from "../src/git/walk";
import { memoryRepo } from "./memory";

const person = { name: "Tester", email: "t@example.com", time: 1_760_000_000, tz: "+0000" };

describe("git core limits", () => {
  it("rejects a tree without separators", () => {
    expect(() => parseTree(new Uint8Array(30).fill(1))).toThrow(/malformed tree/);
  });

  it("rejects a delta that declares a huge result", () => {
    // Base size 0, then a result size of 2^35 as a varint.
    const delta = new Uint8Array([0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(() => applyDelta(new Uint8Array(), delta)).toThrow(
      new RegExp(`${MAX_OBJECT_SIZE} byte limit`),
    );
  });

  it("matches adversarial wildcard rules quickly", () => {
    const rules = new PrivateRules(`${"a*".repeat(12)}b\n${"**/".repeat(12)}x\n`);
    const started = performance.now();
    expect(rules.matches("a".repeat(4000), false)).toBe(false);
    expect(rules.matches(Array.from({ length: 60 }, () => "d").join("/"), false)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    expect(rules.matches(`${"a".repeat(30)}b`, false)).toBe(true);
  });

  it("matches a wildcard against a filename that contains a star", () => {
    expect(new PrivateRules("*.pem\n").matches("*secret.pem", false)).toBe(true);
  });
});

describe("mergeBase", () => {
  it("picks the newest shared commit, not the first one found", () => {
    const repo = memoryRepo();
    const store = repo.objects;
    let time = person.time;
    const commit = (parents: string[], message: string) =>
      store.write(
        "commit",
        serializeCommit({
          tree: EMPTY_TREE,
          parents,
          author: { ...person, time: ++time },
          committer: { ...person, time },
          message,
        }),
      );
    store.write("tree", serializeTree([]));
    const old = commit([], "O");
    const shared = commit([old], "X");
    const base = commit([shared], "base");
    // The head merges a branch from X, with the older O as its second parent.
    const side = commit([shared], "side");
    const head = commit([side, old], "head");
    expect(mergeBase(store, base, head)).toBe(shared);
  });
});

describe("receive-pack commands", () => {
  it("reads the commands across chunks and replays the whole body", async () => {
    const [a, b, c] = ["a", "b", "c"].map((char) => char.repeat(40));
    const body = concat([
      pkt(`${a} ${b} refs/heads/main\0report-status side-band-64k\n`),
      pkt(`${"0".repeat(40)} ${c} refs/tags/v1\n`),
      FLUSH,
      utf8("PACK and the rest of the pack"),
    ]);
    // Seven-byte chunks split the length prefixes and the commands.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < body.length; at += 7) {
          controller.enqueue(body.slice(at, at + 7));
        }
        controller.close();
      },
    });
    const read = await readCommands(stream);
    expect(read.commands).toEqual([
      { old: a, new: b, ref: "refs/heads/main" },
      { old: "0".repeat(40), new: c, ref: "refs/tags/v1" },
    ]);
    const replayed = new Uint8Array(await new Response(read.body).arrayBuffer());
    expect(replayed).toEqual(body);
  });
});
