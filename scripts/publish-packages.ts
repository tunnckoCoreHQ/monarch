import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const tag = process.argv[2];
const repository = "tunnckoCoreHQ/monarch";
const registry = "https://npm.wgw.lol/";
if (
  (tag !== "nightly" && tag !== "latest") ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_REF !== "refs/heads/master" ||
  !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "")
) {
  throw new Error("Publishing must follow successful master checks in GitHub Actions");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function run(...args: string[]): void {
  execFileSync("pnpm", args, { stdio: "inherit" });
}

function report(message: string): void {
  console.log(message);
  appendFileSync(process.env.GITHUB_OUTPUT!, `report=${message}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `${message}\n\n`);
}

async function publishedCommit(
  name: string,
  version: string,
  dist?: { tarball?: string; integrity?: string },
): Promise<string> {
  if (!dist?.tarball || !dist.integrity?.startsWith("sha512-")) {
    throw new Error(`Missing tarball or integrity for ${name}@${version}`);
  }
  const response = await fetch(dist.tarball, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Cannot download ${name}@${version}: ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== dist.integrity) {
    throw new Error(`Tarball integrity mismatch for ${name}@${version}`);
  }
  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", "-", "package/package.json"], {
      input: archive,
      encoding: "utf8",
    }),
  );
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    typeof manifest.gitHead !== "string" ||
    !/^[0-9a-f]{40}$/.test(manifest.gitHead)
  ) {
    throw new Error(`Invalid packaged identity or source commit for ${name}@${version}`);
  }
  return manifest.gitHead;
}

async function github<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

interface Package {
  name: string;
  version: string;
  private?: boolean;
  scripts?: { build?: string };
  publishConfig?: { registry?: string };
}

const packages = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`packages/${entry.name}/package.json`))
  .map((entry) => {
    const dir = `packages/${entry.name}`;
    const manifest: Package = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    return { ...manifest, dir };
  })
  .filter((pkg) => !pkg.private && pkg.name.startsWith("@tunnckocore/"));

if (packages.some((pkg) => pkg.publishConfig?.registry)) {
  throw new Error("Remove publishConfig.registry; publishing must use the shared .npmrc");
}

const sha = git("rev-parse", "HEAD");
const selected = new Set<string>();
if (tag === "latest") {
  if (!process.env.RELEASE_PR) {
    throw new Error("Stable publishing requires a merged release PR");
  }
  const paths = git("diff", "--name-only", `${sha}^`, sha, "--", "packages/*/package.json").split(
    "\n",
  );
  for (const pkg of packages) {
    if (paths.includes(`${pkg.dir}/package.json`)) {
      selected.add(pkg.name);
    }
  }
}

const temporary = mkdtempSync(join(tmpdir(), "monarch-publish-"));
const verified: string[] = [];
try {
  if (tag === "nightly") {
    const statusFile = join(temporary, "status.json");
    run("exec", "changeset", "status", "--output", statusFile);
    const plan: { releases: { name: string; type: string }[] } = JSON.parse(
      readFileSync(statusFile, "utf8"),
    );
    for (const release of plan.releases.filter((release) => release.type !== "none")) {
      if (!packages.some((pkg) => pkg.name === release.name)) {
        throw new Error("Changesets may release only publishable packages/* under @tunnckocore");
      }
      selected.add(release.name);
    }
    if (selected.size === 0) {
      report("Not published: no pending changesets");
      rmSync(temporary, { recursive: true, force: true });
      process.exit(0);
    }
    run(
      "exec",
      "changeset",
      "version",
      "--snapshot",
      `nightly.${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}`,
    );
    run("install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile");
  }

  if (selected.size > 0) {
    const requiredDeployment = git("log", "-1", "--format=%H", "--", "apps/vlt-front-worker");
    for (let attempt = 0; ; attempt++) {
      const health = await fetch(`${registry}-/health`, { signal: AbortSignal.timeout(10_000) });
      const deployed = health.ok
        ? ((await health.json()) as { commit?: string }).commit
        : undefined;
      if (
        deployed &&
        /^[0-9a-f]{40}$/.test(deployed) &&
        spawnSync("git", ["merge-base", "--is-ancestor", requiredDeployment, deployed]).status === 0
      ) {
        break;
      }
      if (attempt === 59) {
        throw new Error(`npm.wgw.lol has not deployed ${requiredDeployment}; publishing stopped`);
      }
      console.log(`Waiting for Cloudflare Builds to deploy npm.wgw.lol at ${requiredDeployment}`);
      await setTimeout(10_000);
      git("fetch", "origin", "master");
    }
  }

  const authFile = join(temporary, "npmrc");
  writeFileSync(authFile, "//npm.wgw.lol/:_authToken=${NODE_AUTH_TOKEN}\n", { mode: 0o600 });

  for (const pkg of packages) {
    if (!selected.has(pkg.name)) {
      continue;
    }
    const manifest: Package = JSON.parse(readFileSync(`${pkg.dir}/package.json`, "utf8"));
    const version = manifest.version;
    const changelogPath = `${pkg.dir}/CHANGELOG.md`;
    const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
    if (
      tag === "latest" &&
      (!/^\d+\.\d+\.\d+$/.test(version) || !changelog.includes(`\n## ${version}\n`))
    ) {
      throw new Error(`Missing stable version or release notes for ${pkg.name}`);
    }

    const metadataResponse = await fetch(`${registry}${encodeURIComponent(pkg.name)}`, {
      headers: { "cache-control": "no-cache" },
    });
    if (!metadataResponse.ok && metadataResponse.status !== 404) {
      throw new Error(`Cannot read ${pkg.name}: ${metadataResponse.status}`);
    }
    const metadata: {
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
      "dist-tags"?: Record<string, string>;
    } = metadataResponse.ok ? await metadataResponse.json() : {};

    const nightly = metadata["dist-tags"]?.nightly;
    if (tag === "nightly" && nightly) {
      const publishedSha = await publishedCommit(
        pkg.name,
        nightly,
        metadata.versions?.[nightly]?.dist,
      );
      if (git("merge-base", sha, publishedSha) === sha) {
        verified.push(`${pkg.name}@${nightly} already contains this commit`);
        continue;
      }
    }

    const latest = metadata["dist-tags"]?.latest;
    if (tag === "latest" && latest && /^\d+\.\d+\.\d+$/.test(latest)) {
      const published = latest.split(".").map(Number);
      const candidate = version.split(".").map(Number);
      const difference = published.findIndex((part, index) => part !== candidate[index]);
      if (difference !== -1 && published[difference] > candidate[difference]) {
        console.log(`Skipping ${pkg.name}@${version}; latest is already ${latest}.`);
        continue;
      }
    }

    if (!metadata.versions?.[version] || metadata["dist-tags"]?.[tag] !== version) {
      if (!metadata.versions?.[version] && pkg.scripts?.build) {
        run("exec", "vp", "run", "--filter", pkg.name, "build");
      }
      if (!metadata.versions?.[version]) {
        writeFileSync(
          `${pkg.dir}/package.json`,
          `${JSON.stringify({ ...manifest, gitHead: sha }, null, 2)}\n`,
        );
      }
      const tokenUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!);
      tokenUrl.searchParams.set("audience", "https://npm.wgw.lol");
      const tokenResponse = await fetch(tokenUrl, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      });
      if (!tokenResponse.ok) {
        throw new Error(`GitHub OIDC request failed: ${tokenResponse.status}`);
      }
      const { value } = (await tokenResponse.json()) as { value: string };
      if (!value) {
        throw new Error("GitHub did not return an OIDC token");
      }
      console.log(`::add-mask::${value}`);

      const args = metadata.versions?.[version]
        ? ["dist-tag", "add", `${pkg.name}@${version}`, tag]
        : ["--filter", pkg.name, "publish", "--tag", tag, "--no-git-checks"];
      execFileSync("pnpm", args, {
        stdio: "inherit",
        env: { ...process.env, NODE_AUTH_TOKEN: value, NPM_CONFIG_USERCONFIG: authFile },
      });
    }

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${registry}${encodeURIComponent(pkg.name)}`, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(10_000),
      });
      const published: {
        "dist-tags"?: Record<string, string>;
        versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
      } = response.ok ? await response.json() : {};
      const tarball = published.versions?.[version]?.dist?.tarball;
      if (published["dist-tags"]?.[tag] === version && tarball) {
        if (
          (await publishedCommit(pkg.name, version, published.versions?.[version]?.dist)) !== sha
        ) {
          throw new Error(`Published source commit differs for ${pkg.name}@${version}`);
        }
        verified.push(`${pkg.name}@${version}`);
        break;
      }
      if (attempt === 11) {
        throw new Error(`VLT has not confirmed ${pkg.name}@${version} with ${tag} from ${sha}`);
      }
      await setTimeout(10_000);
    }

    if (tag === "latest") {
      const packageTag = `${pkg.name}@${version}`;
      const existing = await fetch(
        `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(packageTag)}`,
        { headers: { authorization: `Bearer ${process.env.GH_TOKEN}` } },
      );
      if (existing.ok) {
        continue;
      }
      if (existing.status !== 404) {
        throw new Error(`Cannot read release ${packageTag}: ${existing.status}`);
      }
      const notes = changelog.split(`\n## ${version}\n`)[1].split(/\n## /)[0].trim();
      await github("releases", "POST", {
        tag_name: packageTag,
        target_commitish: sha,
        name: packageTag,
        body: notes,
        make_latest: "false",
      });
    }
    console.log(`Published ${pkg.name}@${version} with ${tag}`);
  }
  report(
    verified.length > 0
      ? `Verified ${tag}: ${verified.join(", ")}`
      : "Not published: no release needed",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
