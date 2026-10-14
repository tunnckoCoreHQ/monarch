// ci.run.ts: monarch CI on boxd. Adapted from https://docs.boxd.sh/use-cases/ci-runners
//
//   run ci.run.ts        (on the monarch-ci machine; boxd holds the GitHub trigger and
//                         wakes the machine when an event arrives)
//
// GitHub only sends the event and shows the result. For every pull request and every
// push to master:
//
//   1. restore one isolated machine from the snapshot of master's last green run
//      (checkout, node_modules, pnpm store, turbo cache, foundry)
//   2. fetch and check out the commit, run the setup steps
//   3. run the jobs in order on that machine, one GitHub check run each, and stop at the
//      first failure. Every step also appends to ~/ci.log on that machine, which
//      holds only this run: the log is emptied first.
//   4. green on master: save the machine as the next version of the snapshot.
//      A green machine is deleted. A failed machine is kept, named in the failed
//      check's summary, so `boxd connect <name>` lands in the failed state. The nightly
//      cold run deletes failed machines older than a day.
//
// The `cold` schedule runs master's head from a clean tree with turbo forced, to catch
// what a warm snapshot hides. It never promotes. Re-running a check from GitHub runs
// the whole run again for that commit.
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
  /** Run only these jobs. Set by a re-run of one check. */
  only?: string[];
};
type Row = { name: string; ok: boolean; s: string; tail?: string };

/** git's empty tree. As $BASE on a cold run, every setup step sees a changed lockfile. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Every step on a run machine appends to this file. */
const LOG = "/home/boxd/ci.log";
/** How long a failed run's machine stays around. */
const KEEP_FAILED_MS = 24 * 3_600_000;

type Inflight = { owner: string; name: string; checks: number[]; machine?: string };
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
  const out = `${r.stdout}\n${r.stderr}`.trim().split("\n");
  rows.push({
    name,
    ok: r.success,
    s: secs(t0),
    tail: r.success ? undefined : out.slice(-80).join("\n"),
  });
  say(`${r.success ? "✓" : "✗"} ${name}  (${secs(t0)}s)`);
  return r.success;
}

/** The short form of a step for the live log: `pnpm install --frozen-lockfile` → `install`. */
const short = (cmd: string) =>
  cmd.match(/(?:yarn|pnpm|npm|bun)(?: run| exec)? ([\w:.-]+)/)?.[1] ??
  (cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd);

const table = (rows: Row[]) =>
  rows.length
    ? `| | step | time |\n|---|---|---|\n${rows.map((r) => `| ${r.ok ? "✓" : "✗"} | \`${r.name}\` | ${r.s}s |`).join("\n")}`
    : "";
const tail = (rows: Row[]) => {
  const t = rows.find((r) => !r.ok)?.tail;
  return t ? `\`\`\`\n${t.slice(-60_000)}\n\`\`\`` : undefined;
};

async function ci(repoName: string, run: Run) {
  const repo = repos[repoName];
  const { owner, name } = split(repoName);
  const gh = await githubApp.client();
  const t0 = performance.now();
  // The live log, `run logs -f`: one line per event, timed from the push.
  const say = (msg: string) => console.log(`${secs(t0).padStart(6)}s  ${msg}`);
  const suffix = run.cold ? " (cold)" : "";
  const short7 = run.sha.slice(0, 7);
  const source = repo.snapshot;
  const allJobs = Object.entries(repo.jobs);
  // A re-run of one check runs that job alone.
  const only = run.only ? allJobs.filter(([job]) => run.only?.includes(job)) : [];
  const jobs = only.length ? only : allJobs;
  const setupNote = only.length ? `\n\nRe-run of ${jobs.map(([job]) => job).join(", ")} only.` : "";
  const machineName = `ci-${short7}-${Date.now() % 100_000}`;
  const keptHint =
    `\n\nThe machine \`${machineName}\` is kept for a day. \`boxd connect ${machineName}\`: ` +
    `the repo is at \`${repo.workdir}\` with ${short7} checked out, the full log at \`${LOG}\`.`;

  // One check run per job, plus one for the restore, checkout, and setup. `open` holds
  // the ones not completed yet, so an exception can close them all.
  const open = new Map<string, number>();
  const create = async (title: string, status: "queued" | "in_progress") => {
    const r = await gh.rest.checks.create({
      owner,
      repo: name,
      name: `monarch-ci/${title}${suffix}`,
      head_sha: run.sha,
      status,
      ...(status === "in_progress" ? { started_at: now() } : {}),
    });
    open.set(title, r.data.id);
    return r.data.id;
  };
  const start = (id: number) =>
    gh.rest.checks.update({
      owner,
      repo: name,
      check_run_id: id,
      status: "in_progress",
      started_at: now(),
    });
  const finish = async (
    title: string,
    conclusion: "success" | "failure" | "skipped",
    summaryTitle: string,
    rows: Row[],
    text?: string,
    note = "",
  ) => {
    const id = open.get(title);
    if (id === undefined) {
      return;
    }
    open.delete(title);
    await gh.rest.checks.update({
      owner,
      repo: name,
      check_run_id: id,
      status: "completed",
      conclusion,
      completed_at: now(),
      output: {
        title: summaryTitle,
        summary: table(rows) + note + (conclusion === "failure" ? keptHint : ""),
        text: text ?? tail(rows),
      },
      // A button on the check's page. GitHub sends check_run.requested_action when clicked.
      actions: [
        { label: "Re-run this check", description: "Run only this job again", identifier: "rerun" },
      ],
    });
  };

  const env: Record<string, string> = {
    CI: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    ...repo.env,
    ...(run.base ? { AFFECTED: "--affected", TURBO_SCM_BASE: run.base } : { AFFECTED: "" }),
    ...(run.cold ? { TURBO_FORCE: "true" } : {}),
  };

  let machine: string | undefined;
  let ok = false;
  let keep: string | undefined; // the machine to save as the next snapshot
  let creating: Promise<{ id: string }> | undefined;
  console.log(`\n▶ ${run.label} · ${short7} · from ${source}`);
  try {
    // 1. One machine, restored from master's last green state, with the commit on top.
    //    Isolated: no boxd CLI, no integrations, so the code under test can't reach the
    //    account. The restore starts first, and the GitHub calls overlap with it: the
    //    App token, and all the check runs at once.
    const rows: Row[] = [];
    const tr = performance.now();
    const restore = boxd.machines.create({
      name: machineName,
      fromSnapshot: source,
      isolated: true,
    });
    creating = restore;
    const tokenPromise = githubApp.getToken();
    tokenPromise.catch(() => undefined); // awaited below; this only keeps a failure from going unhandled
    await Promise.all([
      create("setup", "in_progress"),
      ...jobs.map(([job]) => create(job, "queued")),
    ]);
    track(machineName, { owner, name, checks: [...open.values()] });
    const m = await restore;
    machine = m.id;
    track(machineName, { owner, name, checks: [...open.values()], machine: m.id });
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
    await finish(
      "setup",
      ok ? "success" : "failure",
      ok ? `ready in ${secs(t0)}s` : `failed: ${rows.find((r) => !r.ok)?.name ?? "?"}`,
      rows,
      undefined,
      setupNote,
    );

    // 3. The jobs, in order, on the same machine. The first failure skips the rest.
    for (const [job, cmd] of jobs) {
      if (!ok) {
        await finish(job, "skipped", "skipped: an earlier step failed", []);
        continue;
      }
      const id = open.get(job);
      if (id === undefined) {
        continue;
      }
      await start(id);
      const jr: Row[] = [];
      ok = await step(jr, job, m.id, repo.workdir, cmd, env, say);
      await finish(
        job,
        ok ? "success" : "failure",
        ok ? `green in ${jr[0]?.s}s` : `failed: ${job}`,
        jr,
      );
    }

    // 4. Green on master: this machine becomes the next snapshot (below). A cold run is
    //    never promoted, since its point is to not carry state forward.
    if (ok && run.isMain && repo.promote && !run.cold) {
      keep = m.id;
    }
    say(`${ok ? "✓ green" : "✗ failed"}: checks posted on ${short7}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    say(`✗ ${msg}`);
    for (const title of open.keys()) {
      await finish(
        title,
        "failure",
        `boxd-ci: ${msg.slice(0, 100)}`,
        [],
        `\`\`\`\n${msg}\n\`\`\``,
      ).catch(() => undefined);
    }
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

/** Closes what a run killed by a restart left behind: its open checks and its machine. */
async function recover() {
  const entries: Array<[string, Inflight]> = Object.entries(state.inflight);
  if (!entries.length) {
    return;
  }
  const gh = await githubApp.client();
  for (const [key, r] of entries) {
    for (const id of r.checks) {
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
    console.log(`recovered ${key}: checks cancelled${r.machine ? ", machine deleted" : ""}`);
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
type PullRequestEvent = {
  action: string;
  number: number;
  pull_request: {
    head: { sha: string; ref: string; repo: { full_name: string } | null };
    base: { sha: string };
  };
};

/** `monarch-ci/test (cold)` → `{ cold: true, only: ["test"] }`. Setup has no job of its own. */
const parse = (checkName: string) => {
  const cold = checkName.endsWith(" (cold)");
  const job = checkName.slice("monarch-ci/".length, cold ? -" (cold)".length : undefined);
  return { cold, only: job === "setup" ? undefined : [job] };
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
  // Re-run on one of our checks (check_run rerequested) and the "Re-run this check" button
  // on a check's page (check_run requested_action) run that one job again, on a fresh
  // machine with the commit checked out. "Re-run all checks" (check_suite) runs everything. GitHub lists no pull requests for a fork's commit,
  // and its head_branch is null, so those fall through and return.
  const rerun = async (
    sha: string,
    branch: string | null,
    prs: RerunPr[],
    cold: boolean,
    only?: string[],
  ) => {
    const what = only ? `rerun of ${only.join(", ")} for` : "rerun of";
    const pr = prs[0];
    if (pr) {
      await ci(repoName, {
        sha,
        ref: pr.head.ref,
        label: `${what} pull request #${pr.number}`,
        isMain: false,
        base: pr.base.sha,
        cold,
        only,
      });
      return;
    }
    if (!branch || !repo.on.push?.includes(branch)) {
      return;
    }
    await ci(repoName, {
      sha,
      ref: branch,
      label: `${what} push to ${branch}`,
      // A single job can't stand for a green master, so it never promotes.
      isMain: branch === repo.promote && !only,
      cold,
      only,
    });
  };
  githubApp.on("check_run.rerequested", { repo: repoName }, async (e: CheckRunEvent) => {
    const { name: checkName, head_sha, check_suite, pull_requests } = e.check_run;
    if (!checkName.startsWith("monarch-ci/")) {
      return;
    }
    const { cold, only } = parse(checkName);
    await rerun(head_sha, check_suite.head_branch, pull_requests, cold, only);
  });
  githubApp.on("check_run.requested_action", { repo: repoName }, async (e: CheckRunEvent) => {
    const { name: checkName, head_sha, check_suite, pull_requests } = e.check_run;
    if (!checkName.startsWith("monarch-ci/") || e.requested_action?.identifier !== "rerun") {
      return;
    }
    const { cold, only } = parse(checkName);
    await rerun(head_sha, check_suite.head_branch, pull_requests, cold, only);
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
