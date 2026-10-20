export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const fields = typeof data === "object" && data !== null ? data : {};
    const message =
      "message" in fields && typeof fields.message === "string" ? fields.message : res.statusText;
    const code = "error" in fields && typeof fields.error === "string" ? fields.error : "error";
    throw new ApiError(res.status, message, code);
  }
  const type = res.headers.get("content-type") ?? "";
  // SAFETY: each caller names the shape its endpoint returns.
  return (type.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export interface Me {
  id: string;
  handle: string;
  name: string;
  email: string | null;
  kind: "human" | "agent";
  provider: string;
}

export async function getMe(): Promise<Me | null> {
  try {
    return (await api<{ me: Me | null }>("/api/session")).me;
  } catch {
    return null;
  }
}

export interface Repo {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  visibility: "public" | "private";
  default_branch: string;
  source: string | null;
  forked_from: string | null;
  pushed_at: number | null;
  created_at: number;
  clone_url: string;
  web_url: string;
  status: "ready" | "importing" | "forking" | "failed";
  status_detail: string | null;
  storage: "artifacts";
}

export interface RepoDetail extends Repo {
  role: "read" | "write" | "admin" | null;
  view: "full" | "public";
  empty: boolean;
  branches: string[];
  tags: string[];
  open_pulls: number;
  private_rules: string | null;
  hides_paths: boolean;
}

export interface Person {
  name: string;
  email: string;
  time: number;
}

export interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
  /** The combined status; only the commit list sends it. */
  status?: CombinedState;
}

export type StatusState = "pending" | "success" | "failure" | "error";

/** Any failure or error fails a commit, then any pending; null when it has no statuses. */
export type CombinedState = "pending" | "success" | "failure" | null;

export interface CommitStatus {
  context: string;
  state: StatusState;
  description: string;
  target_url: string | null;
  creator: string | null;
  created_at: number;
  updated_at: number;
}

export interface CombinedStatus {
  sha: string;
  state: CombinedState;
  statuses: CommitStatus[];
}

export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified";
  binary: boolean;
  additions: number;
  deletions: number;
  patch: string;
}

export interface TreeItem {
  name: string;
  path: string;
  type: "tree" | "blob" | "commit";
  sha: string;
  size?: number;
}

export function ago(seconds: number | null): string {
  if (seconds === null) {
    return "never";
  }
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  if (diff < 60) {
    return "just now";
  }
  const units: Array<[number, string]> = [
    [31_536_000, "y"],
    [2_592_000, "mo"],
    [86_400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, label] of units) {
    if (diff >= size) {
      return `${Math.floor(diff / size)}${label} ago`;
    }
  }
  return "just now";
}

export function bytes(size: number | undefined): string {
  if (size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
