import { Bash, defineCommand } from "just-bash/browser";
import { expect, test } from "vitest";

import { ultraciteCommand } from "../src/ultracite.ts";

/** Stand-ins for oxlint and oxfmt that record how they were called. */
function recordingShell(failing: string[] = []) {
  const calls: string[] = [];
  const fake = (name: string) =>
    defineCommand(name, async (args) => {
      calls.push([name, ...args].join(" "));
      return { stdout: "", stderr: "", exitCode: failing.includes(name) ? 1 : 0 };
    });
  const bash = new Bash({
    cwd: "/repo",
    customCommands: [fake("oxlint"), fake("oxfmt"), ultraciteCommand],
  });
  return { bash, calls };
}

test("fix runs oxlint --fix with the passthrough flags, then oxfmt --write", async () => {
  const { bash, calls } = recordingShell();
  const result = await bash.exec("ultracite fix --type-aware --type-check packages/zagora");
  expect(result.exitCode).toBe(0);
  expect(calls).toEqual([
    "oxlint --fix --type-aware --type-check packages/zagora",
    "oxfmt --write --no-error-on-unmatched-pattern packages/zagora",
  ]);
});

test("fix --unsafe uses --fix-dangerously; no paths means the working directory", async () => {
  const { bash, calls } = recordingShell();
  await bash.exec("ultracite fix --unsafe");
  expect(calls).toEqual([
    "oxlint --fix-dangerously .",
    "oxfmt --write --no-error-on-unmatched-pattern .",
  ]);
});

test("check runs oxfmt --check, then oxlint, and fails when either fails", async () => {
  const { bash, calls } = recordingShell(["oxfmt"]);
  const result = await bash.exec("ultracite check src");
  expect(calls).toEqual(["oxfmt --check --no-error-on-unmatched-pattern src", "oxlint src"]);
  expect(result.exitCode).toBe(1);
});
