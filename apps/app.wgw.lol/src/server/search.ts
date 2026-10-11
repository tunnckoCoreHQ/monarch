import { PrivateRules } from "../git/rules";
import type { FileEntry } from "../git/tree";
import type { Access } from "./auth";
import { findRepoById, type RepoRow } from "./db";
import type { Env } from "./env";
import type { Result } from "./result";
import { sha256 } from "./util";

const MODEL = "@cf/baai/bge-base-en-v1.5";
/** Chunks hold whole lines, about this many characters each. */
const CHUNK_CHARS = 1500;
const MAX_FILE_BYTES = 256 * 1024;
/** Workers AI embeds up to 100 texts per call. */
const EMBED_BATCH = 100;
/** One run embeds about this many chunks, and records at most RUN_FILES files, then re-enqueues. */
const RUN_CHUNKS = 1500;
const RUN_FILES = 500;
/** Files recorded per D1 batch. */
const SAVE_FILES = 50;
/** Blobs and blob bytes per Durable Object read. */
const READ_FILES = 200;
const READ_BYTES = 1024 * 1024;
/** Vectorize takes 1,000 vectors per upsert; deletes use the same batch size. */
const MUTATION_BATCH = 1000;
/** Vectorize keeps 10 KiB of metadata per vector. 4 KiB of text leaves room for JSON escaping. */
const TEXT_BYTES = 4096;
/** Bound parameters per D1 statement stay under the limit of 100. */
const PATHS_PER_DELETE = 90;

const LOCKFILE = /(^|\/)(go\.sum|[^/]*\.lockb?|[^/]*-lock\.(json|ya?ml)|[^/]*\.lock\.json)$/;
const MINIFIED = /\.min\.(js|mjs|cjs|css)$|\.map$/;

export type Visibility = "public" | "private";

export interface IndexMessage {
  type: "wgw.index";
  repoId: string;
}

export interface Chunk {
  text: string;
  /** First and last line, counted from 1. */
  start: number;
  end: number;
}

export interface SearchHit {
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  score: number;
}

interface FileRow {
  path: string;
  blob_sha: string;
  chunks: number;
  visibility: Visibility;
}

interface Pending extends FileEntry {
  visibility: Visibility;
  old: FileRow | undefined;
}

interface Ready {
  file: Pending;
  chunks: Chunk[];
}

/** Durable Object methods return failures as values; the indexer turns them into errors. */
function value<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

/** Asks the queue consumer to bring the repository's search index up to the default branch tip. */
export async function enqueueIndex(env: Env, repoId: string): Promise<void> {
  const message: IndexMessage = { type: "wgw.index", repoId };
  await env.EVENTS.send(message);
}

export function isIndexMessage(body: unknown): body is IndexMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    "type" in body &&
    body.type === "wgw.index" &&
    "repoId" in body &&
    typeof body.repoId === "string"
  );
}

/**
 * Splits text into pieces of whole lines, about `size` characters each. A longer line is cut.
 * Blank lines at the edges of a piece are left out, so its line numbers frame the code.
 */
export function chunkLines(text: string, size = CHUNK_CHARS): Chunk[] {
  // A final newline ends the last line, as in the blob view.
  const lines = text.replace(/\n$/, "").split("\n");
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let length = 0;
  let start = 1;
  const flush = (end: number) => {
    let first = 0;
    let last = parts.length;
    while (first < last && parts[first].trim() === "") {
      first++;
    }
    while (last > first && parts[last - 1].trim() === "") {
      last--;
    }
    if (first < last) {
      chunks.push({
        text: parts.slice(first, last).join("\n"),
        start: start + first,
        end: end - (parts.length - last),
      });
    }
    parts = [];
    length = 0;
    start = end + 1;
  };
  for (const [index, full] of lines.entries()) {
    const line = full.slice(0, size);
    if (parts.length > 0 && length + line.length + 1 > size) {
      flush(index);
    }
    parts.push(line);
    length += line.length + 1;
  }
  flush(lines.length);
  return chunks;
}

/** A stable Vectorize ID: 48 hex characters, under the 64-byte limit. */
export async function vectorId(
  repoId: string,
  path: string,
  blobSha: string,
  index: number,
): Promise<string> {
  return (await sha256(`${repoId}\0${path}\0${blobSha}\0${index}`)).slice(0, 48);
}

/** Members see every chunk. Everyone else sees chunks of public paths in public repositories. */
export function visibilityOf(
  repo: Pick<RepoRow, "visibility">,
  rules: PrivateRules,
  path: string,
): Visibility {
  return repo.visibility === "private" || rules.isPrivate(path) ? "private" : "public";
}

function indexable(file: FileEntry): boolean {
  return file.size <= MAX_FILE_BYTES && !LOCKFILE.test(file.path) && !MINIFIED.test(file.path);
}

/** The blob as text, or null for a binary file or minified code. */
function textOf(content: Uint8Array): string | null {
  // The same binary test as the blob API.
  if (content.subarray(0, 8000).includes(0)) {
    return null;
  }
  const text = new TextDecoder().decode(content);
  // Minified code puts a whole file on a few very long lines.
  return text.length / text.split("\n").length > 500 ? null : text;
}

/** Cuts text to at most `max` UTF-8 bytes, on a character boundary. */
function fit(text: string, max: number): string {
  return text.slice(0, new TextEncoder().encodeInto(text, new Uint8Array(max)).read);
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out = await env.AI.run(
    MODEL,
    { text: texts, pooling: "cls" },
    { gateway: { id: env.AI_GATEWAY } },
  );
  if (!("data" in out) || out.data?.length !== texts.length) {
    throw new Error("Workers AI returned no embeddings");
  }
  return out.data;
}

async function deleteVectors(env: Env, repoId: string, rows: FileRow[]): Promise<void> {
  const ids: string[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.chunks; index++) {
      ids.push(await vectorId(repoId, row.path, row.blob_sha, index));
    }
  }
  for (let at = 0; at < ids.length; at += MUTATION_BATCH) {
    await env.CODE.deleteByIds(ids.slice(at, at + MUTATION_BATCH));
  }
}

/**
 * Embeds and upserts the chunks of a few files, deletes the vectors of their old blobs, then
 * records the files. A run that stops halfway leaves rows that point at the old blobs, so the
 * next run redoes these files. Upserts by the same ID replace, so redoing is safe.
 */
async function save(env: Env, repoId: string, commit: string, ready: Ready[]): Promise<void> {
  const items = ready.flatMap(({ file, chunks }) =>
    chunks.map((chunk, index) => ({ file, chunk, index })),
  );
  for (let at = 0; at < items.length; at += EMBED_BATCH) {
    const batch = items.slice(at, at + EMBED_BATCH);
    // The path helps a query like "auth middleware" find the right file.
    const values = await embed(
      env,
      batch.map(({ file, chunk }) => `${file.path}\n${chunk.text}`),
    );
    const vectors = await Promise.all(
      batch.map(async ({ file, chunk, index }, i) => ({
        id: await vectorId(repoId, file.path, file.sha, index),
        values: values[i],
        metadata: {
          repo_id: repoId,
          path: file.path,
          start_line: chunk.start,
          end_line: chunk.end,
          commit,
          visibility: file.visibility,
          text: fit(chunk.text, TEXT_BYTES),
        },
      })),
    );
    await env.CODE.upsert(vectors);
  }
  const stale = ready.flatMap(({ file }) =>
    file.old !== undefined && file.old.blob_sha !== file.sha ? [file.old] : [],
  );
  await deleteVectors(env, repoId, stale);
  if (ready.length > 0) {
    await env.DB.batch(
      ready.map(({ file, chunks }) =>
        env.DB.prepare(
          "INSERT INTO search_files (repo_id, path, blob_sha, chunks, visibility) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repo_id, path) DO UPDATE SET blob_sha = excluded.blob_sha, chunks = excluded.chunks, visibility = excluded.visibility",
        ).bind(repoId, file.path, file.sha, chunks.length, file.visibility),
      ),
    );
  }
}

export interface IndexResult {
  /** Chunks embedded in this run. */
  embedded: number;
  /** Files whose vectors were deleted because they left the tip. */
  removed: number;
  /** True when the run stopped early and enqueued the rest. */
  more: boolean;
}

/**
 * Brings the search index up to the default branch tip. Only files whose blob or visibility
 * changed are embedded again, and files that left the tip lose their vectors.
 */
export async function indexRepo(env: Env, repoId: string): Promise<IndexResult> {
  const repo = await findRepoById(env, repoId);
  if (repo === null || repo.status !== "ready") {
    return { embedded: 0, removed: 0, more: false };
  }
  const stub = env.REPO.getByName(repoId);
  const commit = value(await stub.resolve("full", repo.default_branch));
  const files = commit === null ? [] : value(await stub.searchFiles(commit));
  const rules = new PrivateRules(commit === null ? "" : value(await stub.privacy(commit)).rules);

  const rows = await env.DB.prepare(
    "SELECT path, blob_sha, chunks, visibility FROM search_files WHERE repo_id = ?",
  )
    .bind(repoId)
    .all<FileRow>();
  const indexed = new Map(rows.results.map((row) => [row.path, row]));
  const wanted = new Set<string>();
  const pending: Pending[] = [];
  for (const file of files) {
    if (!indexable(file)) {
      continue;
    }
    wanted.add(file.path);
    const visibility = visibilityOf(repo, rules, file.path);
    const old = indexed.get(file.path);
    if (old === undefined || old.blob_sha !== file.sha || old.visibility !== visibility) {
      pending.push({ ...file, visibility, old });
    }
  }

  const gone = rows.results.filter((row) => !wanted.has(row.path));
  await deleteVectors(env, repoId, gone);
  for (let at = 0; at < gone.length; at += PATHS_PER_DELETE) {
    const paths = gone.slice(at, at + PATHS_PER_DELETE).map((row) => row.path);
    await env.DB.prepare(
      `DELETE FROM search_files WHERE repo_id = ? AND path IN (${paths.map(() => "?").join(", ")})`,
    )
      .bind(repoId, ...paths)
      .run();
  }

  let embedded = 0;
  let next = 0;
  let ready: Ready[] = [];
  let readyChunks = 0;
  const flush = async () => {
    if (commit === null || ready.length === 0) {
      return;
    }
    await save(env, repoId, commit, ready);
    embedded += readyChunks;
    ready = [];
    readyChunks = 0;
  };
  while (next < pending.length && embedded + readyChunks < RUN_CHUNKS && next < RUN_FILES) {
    const group: Pending[] = [];
    let bytes = 0;
    while (
      next + group.length < pending.length &&
      group.length < READ_FILES &&
      (group.length === 0 || bytes < READ_BYTES)
    ) {
      const file = pending[next + group.length];
      group.push(file);
      bytes += file.size;
    }
    const contents = value(await stub.searchBlobs(group.map((file) => file.sha)));
    for (const [i, file] of group.entries()) {
      const content = contents[i];
      const text = content === null ? null : textOf(content);
      const chunks = text === null ? [] : chunkLines(text);
      ready.push({ file, chunks });
      readyChunks += chunks.length;
      next++;
      if (readyChunks >= EMBED_BATCH || ready.length >= SAVE_FILES) {
        await flush();
      }
      if (embedded + readyChunks >= RUN_CHUNKS || next >= RUN_FILES) {
        break;
      }
    }
  }
  await flush();

  const more = next < pending.length;
  if (more) {
    await enqueueIndex(env, repoId);
  }
  return { embedded, removed: gone.length, more };
}

/** Deletes the repository's vectors and rows. Run it before the repo row goes. */
export async function deleteRepoIndex(env: Env, repoId: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT path, blob_sha, chunks, visibility FROM search_files WHERE repo_id = ?",
  )
    .bind(repoId)
    .all<FileRow>();
  await deleteVectors(env, repoId, rows.results);
  await env.DB.prepare("DELETE FROM search_files WHERE repo_id = ?").bind(repoId).run();
}

function metaText(match: VectorizeMatch, key: string): string {
  const field = match.metadata?.[key];
  return typeof field === "string" ? field : "";
}

function metaNumber(match: VectorizeMatch, key: string): number {
  const field = match.metadata?.[key];
  return typeof field === "number" ? field : 0;
}

function hitOf(match: VectorizeMatch): SearchHit {
  return {
    path: metaText(match, "path"),
    start_line: metaNumber(match, "start_line"),
    end_line: metaNumber(match, "end_line"),
    snippet: metaText(match, "text"),
    score: match.score,
  };
}

async function nearest(
  env: Env,
  query: string,
  limit: number,
  filter: VectorizeVectorMetadataFilter,
): Promise<VectorizeMatch[]> {
  const [vector] = await embed(env, [query]);
  const result = await env.CODE.query(vector, { topK: limit, filter, returnMetadata: "all" });
  return result.matches;
}

/** Searches one repository. Members search every chunk; everyone else only public chunks. */
export async function searchRepo(
  env: Env,
  grant: Access,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const filter: VectorizeVectorMetadataFilter =
    grant.view === "full"
      ? { repo_id: grant.repo.id }
      : { repo_id: grant.repo.id, visibility: "public" };
  return (await nearest(env, query, limit, filter)).map(hitOf);
}

/**
 * Searches the public chunks of every public repository. Members get nothing extra here, so a key
 * limited to one repository sees what `visibleRepos` shows it: public repositories.
 */
export async function searchPublic(
  env: Env,
  query: string,
  limit: number,
): Promise<Array<SearchHit & { owner: string; name: string }>> {
  const matches = await nearest(env, query, limit, { visibility: "public" });
  const ids = [...new Set(matches.map((match) => metaText(match, "repo_id")))];
  if (ids.length === 0) {
    return [];
  }
  // Visibility comes from D1 as well: a repository made private keeps public chunks until its
  // reindex runs, and a deleted one may leave vectors behind.
  const repos = await env.DB.prepare(
    `SELECT repos.id, users.handle AS owner, repos.name FROM repos JOIN users ON users.id = repos.owner_id WHERE repos.visibility = 'public' AND repos.id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all<{ id: string; owner: string; name: string }>();
  const byId = new Map(repos.results.map((repo) => [repo.id, repo]));
  return matches.flatMap((match) => {
    const repo = byId.get(metaText(match, "repo_id"));
    return repo === undefined ? [] : [{ owner: repo.owner, name: repo.name, ...hitOf(match) }];
  });
}
