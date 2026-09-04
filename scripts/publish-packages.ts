import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tag = process.argv[2];
const repository = "tunnckoCoreHQ/monarch";
const registry = "https://npm.wgw.lol/";
if (
  (tag !== "nightly" && tag !== "latest") ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_REF !== "refs/heads/master" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_run"
) {
  throw new Error("Publishing must follow successful master checks in GitHub Actions");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function run(...args: string[]): void {
  execFileSync("pnpm", args, { stdio: "inherit" });
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
if (tag === "nightly") {
  const head = await github<{ object: { sha: string } }>("git/ref/heads/master");
  if (head.object.sha !== sha) {
    console.log("A newer master commit exists; skipping this nightly run.");
    process.exit(0);
  }
} else {
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
      console.log("No pending changesets; skipping nightly publishing.");
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
    const metadata: { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> } =
      metadataResponse.ok ? await metadataResponse.json() : {};

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
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
