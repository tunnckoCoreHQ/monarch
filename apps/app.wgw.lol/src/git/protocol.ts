import { type Bytes, concat } from "./bytes";
import { ZERO_SHA } from "./objects";
import { FLUSH, pkt, PktReader } from "./pktline";

export const AGENT = "agent=wgw/0.1";

export type Service = "git-upload-pack" | "git-receive-pack";

export interface Ref {
  name: string;
  sha: string;
}

export function isService(name: string | null): name is Service {
  return name === "git-upload-pack" || name === "git-receive-pack";
}

/** The smart HTTP `info/refs` body. `head` is the branch HEAD points to, if it exists. */
export function advertiseRefs(service: Service, refs: Ref[], head: Ref | undefined): Bytes {
  const caps =
    service === "git-upload-pack"
      ? ["multi_ack_detailed", "shallow", "no-progress", AGENT]
      : ["report-status", "delete-refs", "no-thin", "ofs-delta", "quiet", "atomic", AGENT];
  if (service === "git-upload-pack" && head !== undefined) {
    caps.unshift(`symref=HEAD:${head.name}`);
  }
  const lines: Array<{ sha: string; name: string }> = [];
  if (service === "git-upload-pack" && head !== undefined) {
    lines.push({ sha: head.sha, name: "HEAD" });
  }
  lines.push(...refs);
  const parts = [pkt(`# service=${service}\n`), FLUSH];
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps.join(" ")}\n`));
  }
  lines.forEach((line, index) => {
    parts.push(
      pkt(
        index === 0
          ? `${line.sha} ${line.name}\0${caps.join(" ")}\n`
          : `${line.sha} ${line.name}\n`,
      ),
    );
  });
  parts.push(FLUSH);
  return concat(parts);
}

export interface UploadRequest {
  wants: string[];
  /** Commits the client already has as shallow boundaries. */
  shallow: string[];
  depth?: number;
  /** True when the request ended right after the wants, before any have or done line. */
  wantsOnly: boolean;
  haves: string[];
  done: boolean;
}

export function parseUploadRequest(body: Uint8Array): UploadRequest {
  const reader = new PktReader(body);
  const request: UploadRequest = {
    wants: [],
    shallow: [],
    haves: [],
    done: false,
    wantsOnly: false,
  };
  for (;;) {
    const line = reader.nextLine();
    if (line === null || line === undefined) {
      break;
    }
    if (line.startsWith("want ")) {
      request.wants.push(line.slice(5, 45));
    } else if (line.startsWith("shallow ")) {
      request.shallow.push(line.slice(8, 48));
    } else if (line.startsWith("deepen ")) {
      request.depth = Number(line.slice(7));
    }
  }
  let sawNegotiation = false;
  for (;;) {
    const line = reader.nextLine();
    if (line === undefined) {
      break;
    }
    if (line === null) {
      sawNegotiation = true;
      continue;
    }
    sawNegotiation = true;
    if (line.startsWith("have ")) {
      request.haves.push(line.slice(5, 45));
    } else if (line === "done") {
      request.done = true;
    }
  }
  request.wantsOnly = !sawNegotiation;
  return request;
}

export interface Command {
  old: string;
  new: string;
  ref: string;
}

export interface ReceiveRequest {
  commands: Command[];
  caps: string[];
  pack: Uint8Array;
}

export function parseReceiveRequest(body: Uint8Array): ReceiveRequest {
  const reader = new PktReader(body);
  const request: ReceiveRequest = { commands: [], caps: [], pack: new Uint8Array() };
  for (;;) {
    const line = reader.nextLine();
    if (line === null || line === undefined) {
      break;
    }
    if (line.startsWith("shallow ")) {
      continue;
    }
    const nul = line.indexOf("\0");
    const command = nul === -1 ? line : line.slice(0, nul);
    if (nul !== -1) {
      request.caps = line.slice(nul + 1).split(" ");
    }
    const [old, sha, ref] = command.split(" ");
    request.commands.push({ old, new: sha, ref });
  }
  request.pack = body.subarray(reader.pos);
  return request;
}

// The ref commands come before the pack; commands that run past this are not read.
const MAX_COMMANDS = 1 << 20;

/**
 * Reads the ref commands at the start of a receive-pack body, up to the flush before the pack,
 * without buffering the pack. Returns them with a body that replays the bytes read and then
 * streams the rest. Commands that do not end within MAX_COMMANDS come back empty.
 */
export async function readCommands(
  body: ReadableStream<Uint8Array>,
): Promise<{ commands: Command[]; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let commands: Command[] = [];
  for (let size = 0; size < MAX_COMMANDS;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.length;
    const head = concat(chunks);
    const lines = new PktReader(head);
    let line;
    do {
      line = lines.next();
    } while (line !== null && line !== undefined);
    if (line === null) {
      commands = parseReceiveRequest(head).commands;
      break;
    }
  }
  let replayed = 0;
  const replay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (replayed < chunks.length) {
        controller.enqueue(chunks[replayed++]);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { commands, body: replay };
}

export interface RefResult {
  ref: string;
  error?: string;
}

export function reportStatus(unpackError: string | undefined, results: RefResult[]): Bytes {
  const parts: Uint8Array[] = [
    pkt(unpackError === undefined ? "unpack ok\n" : `unpack ${unpackError}\n`),
  ];
  for (const result of results) {
    parts.push(
      pkt(result.error === undefined ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.error}\n`),
    );
  }
  parts.push(FLUSH);
  return concat(parts);
}

/**
 * Parses an `info/refs` advertisement from another server. Used to import and mirror repositories.
 * `caps` lists the capabilities from the first line.
 */
export function parseAdvertisement(body: Uint8Array): {
  refs: Ref[];
  head?: string;
  caps: string[];
} {
  const reader = new PktReader(body);
  const refs: Ref[] = [];
  let head: string | undefined;
  let caps: string[] = [];
  let line = reader.nextLine();
  if (line?.startsWith("# service=")) {
    reader.nextLine();
    line = reader.nextLine();
  }
  while (line !== null && line !== undefined) {
    const nul = line.indexOf("\0");
    const entry = nul === -1 ? line : line.slice(0, nul);
    if (nul !== -1) {
      caps = line
        .slice(nul + 1)
        .split(" ")
        .filter((cap) => cap !== "");
      const symref = caps.find((cap) => cap.startsWith("symref=HEAD:"));
      head = symref?.slice("symref=HEAD:".length);
    }
    const [sha, name] = entry.split(" ");
    if (name !== undefined && !name.endsWith("^{}") && name !== "capabilities^{}") {
      refs.push({ sha, name });
    }
    line = reader.nextLine();
  }
  return { refs, head, caps };
}
