import { getRouteApi, Link } from "@tanstack/react-router";
import { Fragment } from "react";

import { NativeSelect } from "~/components/ui/native-select";
import { ago, type Commit } from "~/lib/api";

const repoRoute = getRouteApi("/$owner/$repo");

const DAY = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

export function useRepo() {
  return repoRoute.useLoaderData();
}

function CommitRow({ commit, owner, repo }: { commit: Commit; owner: string; repo: string }) {
  const [subject] = commit.message.split("\n");
  return (
    <li className="hover:bg-card relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3">
      <Link
        to="/$owner/$repo/commit/$sha"
        params={{ owner, repo, sha: commit.sha }}
        title={subject}
        className="hover:text-signal truncate font-semibold after:absolute after:inset-0"
      >
        {subject}
      </Link>
      <span className="text-violet font-mono text-xs">{commit.sha.slice(0, 7)}</span>
      <p className="text-muted-foreground col-span-2 truncate font-mono text-xs">
        {commit.author.name} · {ago(commit.committer.time)}
      </p>
    </li>
  );
}

function groupByDay(commits: Commit[]): Array<[string, Commit[]]> {
  const days = new Map<string, Commit[]>();
  for (const commit of commits) {
    const day = DAY.format(new Date(commit.committer.time * 1000));
    const list = days.get(day);
    if (list === undefined) {
      days.set(day, [commit]);
    } else {
      list.push(commit);
    }
  }
  return [...days];
}

/** Commits as one list per committer day. */
export function CommitList({
  commits,
  owner,
  repo,
}: {
  commits: Commit[];
  owner: string;
  repo: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      {groupByDay(commits).map(([day, items]) => (
        <section key={day} aria-label={`Commits on ${day}`}>
          <h3 className="text-muted-foreground mb-2 font-mono text-xs tracking-wider uppercase">
            {day}
          </h3>
          <ul className="divide-y border">
            {items.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} owner={owner} repo={repo} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The repository name, then one link per folder. The last segment is the current location. */
export function PathCrumbs({
  owner,
  name,
  refName,
  path,
}: {
  owner: string;
  name: string;
  refName: string;
  path: string;
}) {
  const segments = path === "" ? [] : path.split("/");
  return (
    <nav aria-label="Path" className="min-w-0 font-mono text-sm wrap-anywhere">
      <Link
        to="/$owner/$repo"
        params={{ owner, repo: name }}
        search={{ ref: refName }}
        className="hover:text-signal font-bold"
      >
        {name}
      </Link>
      {segments.map((segment, index) => {
        const prefix = segments.slice(0, index + 1).join("/");
        return (
          <Fragment key={prefix}>
            <span className="text-faint px-1">/</span>
            {index === segments.length - 1 ? (
              <span aria-current="page" className="font-semibold">
                {segment}
              </span>
            ) : (
              <Link
                to="/$owner/$repo"
                params={{ owner, repo: name }}
                search={{ ref: refName, path: prefix }}
                className="text-muted-foreground hover:text-signal"
              >
                {segment}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export function RefPicker({
  value,
  branches,
  tags,
  onChange,
}: {
  value: string;
  branches: string[];
  tags: string[];
  onChange: (ref: string) => unknown;
}) {
  const known = branches.includes(value) || tags.includes(value);
  return (
    <NativeSelect
      aria-label="Branch or tag"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-48 max-w-full"
    >
      {known ? null : <option value={value}>{value.slice(0, 12)}</option>}
      <optgroup label="branches">
        {branches.map((branch) => (
          <option key={branch} value={branch}>
            {branch}
          </option>
        ))}
      </optgroup>
      {tags.length > 0 ? (
        <optgroup label="tags">
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </optgroup>
      ) : null}
    </NativeSelect>
  );
}
