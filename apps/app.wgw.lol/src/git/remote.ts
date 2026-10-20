import { type Bytes, concat, sha1Hex, text, toHex } from "./bytes";
import { ZERO_SHA } from "./objects";
import { MAX_EXPANDED_SIZE, writePack } from "./pack";
import { FLUSH, pkt, PktReader } from "./pktline";
import { AGENT, type Command, parseAdvertisement, type Ref, type Service } from "./protocol";
import { GitError } from "./repo";

/** A git smart HTTP remote that takes a bearer token, such as a Cloudflare Artifacts repository. */
export interface Remote {
  /** Full remote URL, ending in `.git`, for example https://<acct>.artifacts.cloudflare.net/git/app-wgw-lol/repo_x.git */
  url: string;
  /** Returns a bearer token for this remote. Called once per request. */
  token: () => Promise<string>;
}

const USER_AGENT = "git/2.47.0 (wgw)";
/** Advertisements and push reports are small; anything larger is not a git server. */
const MAX_REPLY = 16 * 1024 * 1024;

/** The last path segment of the remote, so error messages do not carry the account URL. */
function label(remote: Remote): string {
  return remote.url.replace(/\/+$/, "").split("/").at(-1) ?? "remote";
}

/** Sends one smart HTTP request: the advertisement without a body, the service RPC with one. */
async function call(
  remote: Remote,
  service: Service,
  fetcher: typeof fetch,
  body?: Bytes,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await remote.token()}`,
    "user-agent": USER_AGENT,
  };
  const base = remote.url.replace(/\/+$/, "");
  let url = `${base}/info/refs?service=${service}`;
  let where = `${label(remote)} info/refs`;
  if (body === undefined) {
    headers.accept = `application/x-${service}-advertisement`;
  } else {
    url = `${base}/${service}`;
    where = `${label(remote)} ${service}`;
    headers.accept = `application/x-${service}-result`;
    headers["content-type"] = `application/x-${service}-request`;
  }
  let res: Response;
  try {
    res = await fetcher(url, { method: body === undefined ? "GET" : "POST", headers, body });
  } catch (error) {
    throw new GitError(
      `cannot reach ${where}: ${error instanceof Error ? error.message : "fetch failed"}`,
      502,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
    throw new GitError(`${where} answered ${res.status}${detail === "" ? "" : `: ${detail}`}`, 502);
  }
  return res;
}

async function readBody(res: Response, limit: number, what: string): Promise<Uint8Array> {
  if (res.body === null) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) {
      throw new GitError(`${what} is larger than ${limit} bytes`, 413);
    }
    chunks.push(chunk);
  }
  return concat(chunks);
}

/** GET info/refs for the service; parses the v0/v1 advertisement. */
export async function lsRemote(
  remote: Remote,
  service: Service,
  fetcher: typeof fetch = fetch,
): Promise<{ refs: Ref[]; head?: string; caps: string[] }> {
  const body = await readBody(
    await call(remote, service, fetcher),
    MAX_REPLY,
    `the ${label(remote)} advertisement`,
  );
  // A smart server opens with the service line. Anything else, like a login page, would otherwise
  // read as a remote without refs, and a sync would delete every branch.
  if (new PktReader(body).nextLine() !== `# service=${service}`) {
    throw new GitError(`${label(remote)} did not answer as a git smart HTTP remote`, 502);
  }
  return parseAdvertisement(body);
}

/** Skips the ACK and NAK lines of an upload-pack result and returns the pack after them. */
/**
 * Cloudflare Artifacts ends an upload-pack result with a flush packet after the pack. A pack ends
 * in the SHA-1 of everything before it, so the flush is dropped only when that checksum confirms
 * the pack ends 4 bytes earlier.
 */
function withoutTrailingFlush(pack: Uint8Array): Uint8Array {
  if (pack.length < 36 || text(pack.subarray(-4)) !== "0000") {
    return pack;
  }
  const end = pack.length - 4;
  const sum = toHex(pack.subarray(end - 20, end));
  return sha1Hex([pack.subarray(0, end - 20)]) === sum ? pack.subarray(0, end) : pack;
}

function packAfterAcks(body: Uint8Array, where: string): Uint8Array {
  const reader = new PktReader(body);
  while (reader.pos < body.length) {
    if (text(body.subarray(reader.pos, reader.pos + 4)) === "PACK") {
      return withoutTrailingFlush(body.subarray(reader.pos));
    }
    const line = reader.nextLine();
    if (line === undefined) {
      throw new GitError(`${where} sent a malformed result`, 502);
    }
    if (line?.startsWith("ERR ")) {
      throw new GitError(`${where} refused the fetch: ${line.slice(4)}`, 502);
    }
    // A deepen request is answered with shallow and unshallow lines first. The mirror works out
    // its boundaries from the commits it receives, so it skips them.
    const known = line === null || line === "NAK" || /^(ACK|shallow|unshallow) /.test(line);
    if (!known) {
      throw new GitError(`${where} sent an unexpected line: ${line.slice(0, 100)}`, 502);
    }
  }
  return new Uint8Array();
}

/** Options for a bounded fetch. */
export interface FetchOptions {
  /** Sends `deepen <depth>`: the pack stops after this many commits from each want. */
  depth?: number;
  /** Commits the client has without their parents, sent as `shallow` lines. */
  shallow?: string[];
}

/**
 * POST git-upload-pack with wants and haves (no side-band, no multi_ack, `done` in the same
 * request). Returns the raw pack bytes (empty Uint8Array when the server sent no pack).
 */
export async function fetchPack(
  remote: Remote,
  wants: string[],
  haves: string[],
  fetcher: typeof fetch = fetch,
  options: FetchOptions = {},
): Promise<Uint8Array> {
  const wanted = [...new Set(wants)];
  if (wanted.length === 0) {
    return new Uint8Array();
  }
  const caps =
    options.depth === undefined ? `no-progress ${AGENT}` : `no-progress shallow ${AGENT}`;
  const parts: Uint8Array[] = wanted.map((sha, index) =>
    pkt(index === 0 ? `want ${sha} ${caps}\n` : `want ${sha}\n`),
  );
  for (const sha of new Set(options.shallow)) {
    parts.push(pkt(`shallow ${sha}\n`));
  }
  if (options.depth !== undefined) {
    parts.push(pkt(`deepen ${options.depth}\n`));
  }
  parts.push(FLUSH);
  // No flush before `done`: a stateless upload-pack ends the exchange at a flush.
  for (const sha of new Set(haves)) {
    parts.push(pkt(`have ${sha}\n`));
  }
  parts.push(pkt("done\n"));
  const res = await call(remote, "git-upload-pack", fetcher, concat(parts));
  const where = `${label(remote)} git-upload-pack`;
  return packAfterAcks(await readBody(res, MAX_EXPANDED_SIZE, `the ${where} result`), where);
}

/**
 * POST git-receive-pack with commands (the first line carries `report-status`) and a pack. Deletes
 * alone send no pack; any other command sends `pack`, or a valid empty pack when `pack` is empty.
 * Throws GitError 409 when the remote rejects a ref, with its reason, and GitError 502 on an
 * `unpack <error>`, a missing report, or an HTTP error.
 */
export async function sendPack(
  remote: Remote,
  commands: Command[],
  pack: Uint8Array,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (commands.length === 0) {
    return;
  }
  const parts: Uint8Array[] = commands.map((command, index) => {
    const line = `${command.old} ${command.new} ${command.ref}`;
    return pkt(index === 0 ? `${line}\0report-status ${AGENT}\n` : `${line}\n`);
  });
  parts.push(FLUSH);
  if (commands.some((command) => command.new !== ZERO_SHA)) {
    parts.push(pack.length > 0 ? pack : writePack([]));
  }
  const res = await call(remote, "git-receive-pack", fetcher, concat(parts));
  const where = `${label(remote)} git-receive-pack`;
  const reader = new PktReader(await readBody(res, MAX_REPLY, `the ${where} report`));
  let unpack: string | undefined;
  const results = new Map<string, string | undefined>();
  for (;;) {
    const line = reader.nextLine();
    if (line === null || line === undefined) {
      break;
    }
    if (line.startsWith("ERR ")) {
      throw new GitError(`${where} refused the push: ${line.slice(4)}`, 502);
    }
    if (line.startsWith("unpack ")) {
      unpack = line.slice(7);
    } else if (line.startsWith("ok ")) {
      results.set(line.slice(3), undefined);
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const space = rest.indexOf(" ");
      results.set(
        space === -1 ? rest : rest.slice(0, space),
        space === -1 ? "rejected" : rest.slice(space + 1),
      );
    }
  }
  if (unpack === undefined) {
    throw new GitError(`${where} sent no report-status`, 502);
  }
  if (unpack !== "ok") {
    throw new GitError(`${where} could not unpack: ${unpack}`, 502);
  }
  const rejected = commands.flatMap((command) => {
    const reason = results.get(command.ref);
    return reason === undefined ? [] : [`${command.ref}: ${reason}`];
  });
  if (rejected.length > 0) {
    throw new GitError(rejected.join("; "), 409);
  }
  const unreported = commands.find((command) => !results.has(command.ref));
  if (unreported !== undefined) {
    throw new GitError(`${where} did not report ${unreported.ref}`, 502);
  }
}
