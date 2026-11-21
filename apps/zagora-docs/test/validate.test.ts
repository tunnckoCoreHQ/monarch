import { execFileSync } from "node:child_process";

import { expect, test } from "vitest";

// `blume validate` scans every page, which takes longer than the default 5s timeout on CI.
test("every link in the docs resolves", { timeout: 60_000 }, () => {
  const output = execFileSync("pnpm", ["exec", "blume", "validate", "--json"], {
    encoding: "utf-8",
  });
  expect(JSON.parse(output).diagnostics).toEqual([]);
});
