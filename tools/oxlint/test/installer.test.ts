import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

const skill = fileURLToPath(new URL("../../../.agents/skills/install-anti-slop/", import.meta.url));
const assets = join(skill, "assets/anti-slop");
const plugin = fileURLToPath(new URL("../anti-slop/", import.meta.url));
const installer = join(skill, "scripts/install.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("anti-slop installation", () => {
  it("keeps the installed plugin identical to the bundled assets", () => {
    const files = readdirSync(assets, { recursive: true, encoding: "utf8" }).sort();
    expect(readdirSync(plugin, { recursive: true, encoding: "utf8" }).sort()).toEqual(files);
    for (const file of files) {
      if (!statSync(join(assets, file)).isFile()) {
        continue;
      }
      expect(readFileSync(join(plugin, file), "utf8")).toBe(
        readFileSync(join(assets, file), "utf8"),
      );
    }
  });

  it("refuses an existing destination and removes stale files only with --force", () => {
    const directory = mkdtempSync(join(tmpdir(), "monarch-anti-slop-"));
    temporaryDirectories.push(directory);
    execFileSync(process.execPath, [installer], { cwd: directory });
    const target = join(directory, "tools/oxlint/anti-slop");
    writeFileSync(join(target, "obsolete.ts"), "export const obsolete = true;\n");
    expect(spawnSync(process.execPath, [installer], { cwd: directory }).status).toBe(1);
    expect(readFileSync(join(target, "obsolete.ts"), "utf8")).toContain("obsolete");
    execFileSync(process.execPath, [installer, "--force"], { cwd: directory });
    expect(readdirSync(target, { recursive: true, encoding: "utf8" }).sort()).toEqual(
      readdirSync(assets, { recursive: true, encoding: "utf8" }).sort(),
    );
  });

  it.each([".", ".."])("refuses the unsafe destination %s", (target) => {
    const directory = mkdtempSync(join(tmpdir(), "monarch-anti-slop-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "keep.txt"), "keep");
    expect(
      spawnSync(process.execPath, [installer, target, "--force"], { cwd: directory }).status,
    ).toBe(1);
    expect(readFileSync(join(directory, "keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses a destination that reaches the bundled assets through a symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "monarch-anti-slop-"));
    temporaryDirectories.push(directory);
    const copiedSkill = join(directory, "skill");
    cpSync(skill, copiedSkill, { recursive: true });
    symlinkSync(join(copiedSkill, "assets"), join(directory, "alias"), "dir");
    const result = spawnSync(
      process.execPath,
      [join(copiedSkill, "scripts/install.mjs"), "alias/anti-slop", "--force"],
      { cwd: directory },
    );
    expect(result.status).toBe(1);
    expect(readFileSync(join(copiedSkill, "assets/anti-slop/index.ts"), "utf8")).toBe(
      readFileSync(join(assets, "index.ts"), "utf8"),
    );
  });
});
