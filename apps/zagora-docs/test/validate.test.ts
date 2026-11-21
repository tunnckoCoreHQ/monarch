import { execFileSync } from "node:child_process";

import { expect, test } from "vitest";

test("every link in the docs resolves", { timeout: 60_000 }, () => {
  const output = execFileSync("pnpm", ["exec", "blume", "validate", "--json"], {
    encoding: "utf-8",
  });
  expect(JSON.parse(output).diagnostics).toEqual([]);
});
