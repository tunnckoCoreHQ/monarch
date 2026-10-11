import { describe, expect, it } from "vitest";

import { burstOperationId, joinBurst, route, TYPING_FRAME } from "../src/burst";

const burst = [
  { seq: 4, text: "hey", at: 0 },
  { seq: 5, text: "so I finally went to that gallery", at: 1200 },
  { seq: 6, text: "and I hated it lol", at: 4100 },
];

describe("joinBurst", () => {
  it("puts each bubble on its own line, oldest first", () => {
    expect(joinBurst(burst)).toBe("hey\nso I finally went to that gallery\nand I hated it lol");
  });
});

describe("burstOperationId", () => {
  it("names the burst by its first and last bubble", () => {
    expect(burstOperationId(burst)).toBe("burst:4-6");
  });

  it("gives a rerun of the same flush the same id", () => {
    expect(burstOperationId([...burst])).toBe(burstOperationId(burst));
  });

  it("rejects an empty burst", () => {
    expect(() => burstOperationId([])).toThrow();
  });
});

describe("route", () => {
  it("opens a burst when the floor is idle", () => {
    expect(route({ buffered: 0, busy: false })).toBe("buffer");
  });

  it("steers a running reply when no burst is open", () => {
    expect(route({ buffered: 0, busy: true })).toBe("steer");
  });

  it("keeps an open burst collecting while a reply runs", () => {
    expect(route({ buffered: 2, busy: true })).toBe("buffer");
  });
});

describe("TYPING_FRAME", () => {
  it("is the exact JSON clients send while typing", () => {
    expect(TYPING_FRAME).toBe('{"type":"typing"}');
  });
});
