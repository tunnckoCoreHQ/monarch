// ci.run.ts: monarch CI on boxd, one GitHub check per run. Adapted from
// https://docs.boxd.sh/use-cases/ci-runners. The per-job variant is ci.run-disabled.ts.
//
//   run ci.run.ts        (on the monarch-ci machine; boxd holds the GitHub trigger and
//                         wakes the machine when an event arrives)
//
// For every pull request and every push to master:
//
//   1. restore one isolated machine from the snapshot of master's last green run
//      (checkout, node_modules, pnpm store, turbo cache, foundry)
//   2. fetch and check out the commit, run the setup steps
//   3. run the jobs in order on that machine and stop at the first failure. Every step
//      appends to ~/ci.log on that machine, which holds only this run.
//   4. post one check run, `ci`, with a table of every step and its seconds, and the
//      name of the step that failed if one did
//   5. green on master: save the machine as the next version of the snapshot.
//      A green machine is deleted. A failed machine is kept, named in the check's
//      summary, so `boxd connect <name>` lands in the failed state. The nightly cold run
//      deletes failed machines older than a day.
//
// The `cold` schedule runs master's head from a clean tree with turbo forced, to catch
// what a warm snapshot hides. It never promotes. Re-run on the check, the check's own
// Re-run button, and Re-run all checks each run the commit again.
import { boxd, every, githubApp, object } from "@boxd/run";

import config from "./ci.json";

type Repo = {
  snapshot: string;
  workdir: string;
  on: { push?: string[]; pull_request?: boolean };
  env?: Record<string, string>;
  setup: string[];
  jobs: Record<string, string>;
  promote?: string;
  cold?: string;
};
const repos: Record<string, Repo> = config;

/** The check run's name on GitHub. A cold run adds " (cold)". */
const CHECK = "monarch-ci";

/** `owner/name` split at the first slash. */
const split = (full: string) => {
  const i = full.indexOf("/");
  return { owner: full.slice(0, i), name: full.slice(i + 1) };
};

type Run = {
  sha: string;
  ref: string;
  label: string;
  isMain: boolean;
  /** The pull request base. Set, the jobs run with turbo --affected against it. */
  base?: string;
  cold?: boolean;
};
type Row = { name: string; ok: boolean; s: string; code?: number };

/** git's empty tree. As $BASE on a cold run, every setup step sees a changed lockfile. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Every step on a run machine appends to this file. */
const LOG = "/home/boxd/ci.log";
/** How long a failed run's machine stays around. */
const KEEP_FAILED_MS = 24 * 3_600_000;

type Inflight = {
  owner: string;
  name: string;
  check?: number;
  checks?: number[];
  machine?: string;
};
/** The runs in flight.
    Survives restarts: boxd restarts this script on redeploy, fork, and integration changes,
    which kills any run in progress. `recover` closes what such a run left behind. */
const state = object<{ inflight: Record<string, Inflight> }>("boxd-ci");
state.inflight ??= {};
const track = (key: string, r: Inflight) => {
  state.inflight = { ...state.inflight, [key]: r };
};
const untrack = (key: string) => {
  state.inflight = Object.fromEntries(Object.entries(state.inflight).filter(([k]) => k !== key));
};
const promotions = new Map<string, Promise<void>>();

const secs = (t0: number) => ((performance.now() - t0) / 1000).toFixed(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function sh(
  id: string,
  dir: string,
  script: string,
  env?: Record<string, string>,
  timeout = 30 * 60_000,
) {
  return boxd.machines.exec(id, {
    command: ["bash", "-lc", `cd ${dir} && ${script}`],
    env,
    timeout,
  });
}

/** Runs a step, appends its output to the machine's log, records a row, and prints a line. */
async function step(
  rows: Row[],
  name: string,
  id: string,
  dir: string,
  script: string,
  env: Record<string, string> | undefined,
  say: (m: string) => void,
) {
  const t0 = performance.now();
  const logged = `set -o pipefail; { echo "=== ${name}"; ${script}; } 2>&1 | tee -a ${LOG}`;
  const r = await sh(id, dir, logged, env);
  rows.push({ name, ok: r.success, s: secs(t0), code: r.success ? undefined : r.exitCode });
  say(`${r.success ? "✓" : "✗"} ${name}  (${secs(t0)}s)`);
  return r.success;
}

/** The short form of a step for the live log: `pnpm install --frozen-lockfile` → `install`. */
const short = (cmd: string) =>
  cmd.match(/(?:yarn|pnpm|npm|bun)(?: run| exec)? ([\w:.-]+)/)?.[1] ??
  (cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd);

const table = (rows: Row[]) =>
  `| | step | seconds |\n|---|---|---|\n${rows.map((r) => `| ${r.ok ? "✓" : "✗"} | \`${r.name}\` | ${r.s} |`).join("\n")}`;

async function ci(repoName: string, run: Run) {
  const repo = repos[repoName];
  const { owner, name } = split(repoName);
  const gh = await githubApp.client();
  const t0 = performance.now();
  // The live log, `run logs -f`: one line per event, timed from the push.
  const say = (msg: string) => console.log(`${secs(t0).padStart(6)}s  ${msg}`);
  const checkName = `${CHECK}${run.cold ? " (cold)" : ""}`;
  const short7 = run.sha.slice(0, 7);
  const source = repo.snapshot;
  const machineName = `ci-${short7}-${Date.now() % 100_000}`;
  const keptHint =
    `\n\nThe machine \`${machineName}\` is kept for a day. \`boxd connect ${machineName}\`: ` +
    `the repo is at \`${repo.workdir}\` with ${short7} checked out, the full log at \`${LOG}\`.`;

  const env: Record<string, string> = {
    CI: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    ...repo.env,
    ...(run.base ? { AFFECTED: "--affected", TURBO_SCM_BASE: run.base } : { AFFECTED: "" }),
    ...(run.cold ? { TURBO_FORCE: "true" } : {}),
  };

  const rows: Row[] = [];
  let checkId: number | undefined;
  let machine: string | undefined;
  let ok = false;
  let failed: string | undefined; // what went wrong, for the check's title
  let keep: string | undefined; // the machine to save as the next snapshot
  let creating: Promise<{ id: string }> | undefined;
  console.log(`\n▶ ${run.label} · ${short7} · from ${source}`);
  try {
    // 1. One machine, restored from master's last green state, with the commit on top.
    //    Isolated: no boxd CLI, no integrations, so the code under test can't reach the
    //    account. The restore starts first; the GitHub calls overlap with it.
    const tr = performance.now();
    const restore = boxd.machines.create({
      name: machineName,
      fromSnapshot: source,
      isolated: true,
    });
    creating = restore;
    const tokenPromise = githubApp.getToken();
    tokenPromise.catch(() => undefined); // awaited below; this only keeps a failure from going unhandled
    const created = await gh.rest.checks.create({
      owner,
      repo: name,
      name: checkName,
      head_sha: run.sha,
      status: "in_progress",
      started_at: now(),
    });
    checkId = created.data.id;
    track(machineName, { owner, name, check: checkId });
    const m = await restore;
    machine = m.id;
    track(machineName, { owner, name, check: checkId, machine: m.id });
    // A large or fresh snapshot can answer before the machine is up.
    await boxd.machines.waitUntilReady(m.id);
    rows.push({ name: `restore from ${source}`, ok: true, s: secs(tr) });
    say(`✓ restored from ${source} as ${machineName}  (${secs(tr)}s)`);

    // 2. Checkout and setup. $BASE is the snapshot's commit, so an unchanged lockfile skips
    //    the install. A cold run wipes the tree and makes $BASE the empty tree instead.
    const token = await tokenPromise;
    // The snapshot carries the previous green run's log. Start this machine's log empty.
    await sh(m.id, repo.workdir, `: > ${LOG}`);
    const base = run.cold
      ? EMPTY_TREE
      : (await sh(m.id, repo.workdir, "git rev-parse HEAD")).stdout.trim();
    const refs = [run.sha, run.base].filter(Boolean).join(" ");
    const auth = `git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_APP_TOKEN" | base64 -w0)"`;
    const clean = run.cold ? " && git clean -fdxq" : "";
    ok = await step(
      rows,
      `checkout ${short7}`,
      m.id,
      repo.workdir,
      `${auth} fetch -q origin ${refs} && git checkout -q -f ${run.sha}${clean}`,
      { GH_APP_TOKEN: token },
      say,
    );
    for (const s of repo.setup) {
      if (!ok) {
        break;
      }
      ok = await step(rows, short(s), m.id, repo.workdir, s, { ...env, BASE: base }, say);
    }

    // 3. The jobs, in order, on the same machine. The first failure stops the run.
    for (const [job, cmd] of Object.entries(repo.jobs)) {
      if (!ok) {
        break;
      }
      ok = await step(rows, job, m.id, repo.workdir, cmd, env, say);
    }
    const bad = rows.find((r) => !r.ok);
    if (bad) {
      failed = `${bad.name} failed with exit code ${bad.code ?? "?"}`;
    }

    // 4. Green on master: this machine becomes the next snapshot (below). A cold run is
    //    never promoted, since its point is to not carry state forward.
    if (ok && run.isMain && repo.promote && !run.cold) {
      keep = m.id;
    }
    say(`${ok ? "✓ green" : "✗ failed"} on ${short7}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failed = `boxd-ci: ${msg}`;
    rows.push({ name: "boxd-ci", ok: false, s: secs(t0) });
    say(`✗ ${msg}`);
  } finally {
    untrack(machineName);
    // A failure before the restore finished still leaves a machine behind. Delete it.
    if (!machine && creating) {
      const m = await creating.catch(() => null);
      if (m) {
        await boxd.machines.delete(m.id).catch(() => undefined);
      }
    }
    if (machine && machine !== keep) {
      if (ok) {
        await boxd.machines.delete(machine).catch(() => undefined);
      }
      // Failed: keep it, but let it hibernate soon so it costs disk only. The nightly
      // sweep deletes it once it is a day old.
      else {
        await boxd.machines.setAutoHibernateTimeout(machine, 300).catch(() => undefined);
      }
    }
    // The one check, with every step and its seconds. The log stays on the machine.
    if (checkId !== undefined) {
      const total = secs(t0);
      await gh.rest.checks
        .update({
          owner,
          repo: name,
          check_run_id: checkId,
          status: "completed",
          conclusion: ok ? "success" : "failure",
          completed_at: now(),
          output: {
            title: ok ? `green in ${total}s` : `failed: ${failed ?? "?"}`,
            summary: `${run.label}, ${total}s in total.\n\n${table(rows)}${ok || !machine ? "" : keptHint}`,
          },
          actions: [{ label: "Re-run", description: "Run this commit again", identifier: "rerun" }],
        })
        .catch((e: unknown) =>
          say(`✗ check update: ${e instanceof Error ? e.message : String(e)}`),
        );
      say(`check posted on ${short7}`);
    }
  }

  // Reported first, saved after: nobody waits on the snapshot.
  if (keep) {
    const id = keep;
    console.log("        green on master: saving this machine as the next snapshot…");
    const prev = promotions.get(repoName) ?? Promise.resolve();
    const next = prev
      .then(() => promote(repoName, id))
      .catch((e: unknown) =>
        console.log(`✗ promote: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => boxd.machines.delete(id).catch(() => undefined));
    promotions.set(repoName, next);
    await next;
  }
}

async function promote(repoName: string, machineId: string) {
  const t0 = performance.now();
  const target = repos[repoName].snapshot;
  const before = await boxd.snapshots.get(target).catch(() => null);
  await boxd.snapshots.create(machineId, target);
  // The copy reads from the live machine: keep it until the snapshot is ready.
  let snap = await boxd.snapshots.get(target);
  while (snap.status !== "ready" || (snap.version ?? 0) <= (before?.version ?? 0)) {
    await sleep(1000);
    snap = await boxd.snapshots.get(target);
  }
  console.log(
    `        ★ saved as ${target}@${snap.version} in ${secs(t0)}s: the next job starts here`,
  );
}

/** Closes what a run killed by a restart left behind: its open check and its machine. */
async function recover() {
  const entries: Array<[string, Inflight]> = Object.entries(state.inflight);
  if (!entries.length) {
    return;
  }
  const gh = await githubApp.client();
  for (const [key, r] of entries) {
    // Entries from the per-job variant carry several ids.
    const ids = r.check === undefined ? (r.checks ?? []) : [r.check];
    for (const id of ids) {
      const current = await gh.rest.checks
        .get({ owner: r.owner, repo: r.name, check_run_id: id })
        .catch(() => null);
      if (!current || current.data.status === "completed") {
        continue;
      }
      await gh.rest.checks
        .update({
          owner: r.owner,
          repo: r.name,
          check_run_id: id,
          status: "completed",
          conclusion: "cancelled",
          completed_at: now(),
          output: {
            title: "cancelled: the CI automation restarted during this run",
            summary: "Use Re-run on this check to run it again.",
          },
        })
        .catch(() => undefined);
    }
    if (r.machine) {
      await boxd.machines.delete(r.machine).catch(() => undefined);
    }
    console.log(`recovered ${key}: check cancelled${r.machine ? ", machine deleted" : ""}`);
  }
  state.inflight = {};
}

/** Deletes the failed run machines that are older than a day, nothing newer. Runs nightly. */
async function sweep() {
  const cutoff = Date.now() - KEEP_FAILED_MS;
  for (const m of await boxd.machines.list()) {
    if (!m.name.startsWith("ci-") || !m.createdAt || m.createdAt.getTime() > cutoff) {
      continue;
    }
    console.log(`        sweep: deleting ${m.name}, failed more than a day ago`);
    await boxd.machines.delete(m.id).catch(() => undefined);
  }
}

type PushEvent = { ref: string; after: string; deleted?: boolean };
type PullRequestEvent = {
  action: string;
  number: number;
  pull_request: {
    head: { sha: string; ref: string; repo: { full_name: string } | null };
    base: { sha: string };
  };
};
type RerunPr = { number: number; head: { ref: string }; base: { sha: string } };
type CheckRunEvent = {
  action: string;
  requested_action?: { identifier: string };
  check_run: {
    name: string;
    head_sha: string;
    check_suite: { head_branch: string | null };
    pull_requests: RerunPr[];
  };
};
type CheckSuiteEvent = {
  action: string;
  check_suite: { head_sha: string; head_branch: string | null; pull_requests: RerunPr[] };
};

for (const [repoName, repo] of Object.entries(repos)) {
  const { owner, name } = split(repoName);
  if (repo.on.push?.length) {
    githubApp.on("push", { repo: repoName }, async (e: PushEvent) => {
      const branch = e.ref.replace("refs/heads/", "");
      if (!repo.on.push?.includes(branch) || e.deleted) {
        return;
      }
      await ci(repoName, {
        sha: e.after,
        ref: branch,
        label: `push to ${branch}`,
        isMain: branch === repo.promote,
      });
    });
  }
  if (repo.on.pull_request) {
    githubApp.on("pull_request", { repo: repoName }, async (e: PullRequestEvent) => {
      if (!["opened", "synchronize", "reopened"].includes(e.action)) {
        return;
      }
      // Only branches of the repo itself. A fork's head is not fetchable with the App
      // token, and its code would otherwise run on a machine restored from our snapshot.
      if (e.pull_request.head.repo?.full_name !== repoName) {
        return;
      }
      await ci(repoName, {
        sha: e.pull_request.head.sha,
        ref: e.pull_request.head.ref,
        label: `pull request #${e.number}`,
        isMain: false,
        base: e.pull_request.base.sha,
      });
    });
  }
  // Re-run on the check (check_run rerequested), the check's own Re-run button (check_run
  // requested_action), and "Re-run all checks" (check_suite) run the commit again. GitHub
  // lists no pull requests for a fork's commit, and its head_branch is null, so those
  // fall through and return.
  const rerun = async (sha: string, branch: string | null, prs: RerunPr[], cold: boolean) => {
    const pr = prs[0];
    if (pr) {
      await ci(repoName, {
        sha,
        ref: pr.head.ref,
        label: `rerun of pull request #${pr.number}`,
        isMain: false,
        base: pr.base.sha,
        cold,
      });
      return;
    }
    if (!branch || !repo.on.push?.includes(branch)) {
      return;
    }
    await ci(repoName, {
      sha,
      ref: branch,
      label: `rerun of push to ${branch}`,
      isMain: branch === repo.promote,
      cold,
    });
  };
  githubApp.on("check_run.rerequested", { repo: repoName }, async (e: CheckRunEvent) => {
    const { name: checkName, head_sha, check_suite, pull_requests } = e.check_run;
    if (!checkName.startsWith(CHECK)) {
      return;
    }
    await rerun(head_sha, check_suite.head_branch, pull_requests, checkName.endsWith(" (cold)"));
  });
  githubApp.on("check_run.requested_action", { repo: repoName }, async (e: CheckRunEvent) => {
    const { name: checkName, head_sha, check_suite, pull_requests } = e.check_run;
    if (!checkName.startsWith(CHECK) || e.requested_action?.identifier !== "rerun") {
      return;
    }
    await rerun(head_sha, check_suite.head_branch, pull_requests, checkName.endsWith(" (cold)"));
  });
  githubApp.on("check_suite.rerequested", { repo: repoName }, async (e: CheckSuiteEvent) => {
    const { head_sha, head_branch, pull_requests } = e.check_suite;
    await rerun(head_sha, head_branch, pull_requests, false);
  });
  if (repo.cold && repo.promote) {
    const branch = repo.promote;
    every(repo.cold, async () => {
      await sweep().catch((e: unknown) =>
        console.log(`✗ sweep: ${e instanceof Error ? e.message : String(e)}`),
      );
      const gh = await githubApp.client();
      const { data } = await gh.rest.repos.getBranch({ owner, repo: name, branch });
      await ci(repoName, {
        sha: data.commit.sha,
        ref: branch,
        label: `cold run of ${branch}`,
        isMain: false,
        cold: true,
      });
    });
  }
}
recover().catch((e: unknown) =>
  console.log(`✗ recover: ${e instanceof Error ? e.message : String(e)}`),
);
console.log(`boxd-ci watching ${Object.keys(repos).join(", ")}`);
