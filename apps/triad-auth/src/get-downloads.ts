const DAY_MS = 86_400_000;
const NPM_DOWNLOADS_START = "2015-01-10";

export interface NpmDownloadsOptions {
  packageName: string;
  from: string;
  to: string;
  signal?: AbortSignal;
}

export interface DownloadRecord {
  downloads: number;
  day: string;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface NpmPackageMetadata {
  time?: {
    created?: string;
  };
}

export interface NpmDownloadsResponse {
  start: string;
  end: string;
  package: string;
  downloads: DownloadRecord[];
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`Invalid date: ${value}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.valueOf()) || formatDay(date) !== value) {
    throw new TypeError(`Invalid date: ${value}`);
  }

  return date;
}

function splitByYear(from: Date, to: Date): DateRange[] {
  const ranges: DateRange[] = [];
  let cursor = new Date(from);

  while (cursor <= to) {
    const endOfYear = new Date(Date.UTC(cursor.getUTCFullYear(), 11, 31));

    const chunkEnd = endOfYear < to ? endOfYear : to;

    ranges.push({
      from: formatDay(cursor),
      to: formatDay(chunkEnd),
    });

    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }

  return ranges;
}

export async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Request failed: ${response.status} ${response.statusText}` +
        (body ? ` — ${body.slice(0, 5000)}` : ""),
    );
  }

  return response.json() as Promise<T>;
}

export async function fetchPackageCreationDay(
  packageName: string,
  signal?: AbortSignal,
): Promise<string> {
  const name = encodeURIComponent(packageName);

  const metadata = await fetchJSON<NpmPackageMetadata>(
    `https://registry.npmjs.org/${name}`,
    signal,
  );

  const created = metadata.time?.created;

  if (!created) {
    throw new Error(`Package metadata has no creation date: ${packageName}`);
  }

  const creationDay = created.slice(0, 10);

  // Validate the value received from npm.
  parseDay(creationDay);

  return creationDay;
}

export async function fetchNpmDownloadRecords({
  packageName,
  from,
  to,
  signal,
}: NpmDownloadsOptions): Promise<DownloadRecord[]> {
  const requestedFrom = parseDay(from);
  const requestedTo = parseDay(to);

  if (requestedFrom > requestedTo) {
    throw new RangeError("`from` must be before or equal to `to`");
  }

  const creationDay = await fetchPackageCreationDay(packageName, signal);

  // Clamp the requested start to the package creation date.
  const packageCreated = parseDay(creationDay);
  const npmDownloadsStart = parseDay(NPM_DOWNLOADS_START);

  const effectiveFrom = new Date(
    Math.max(requestedFrom.getTime(), packageCreated.getTime(), npmDownloadsStart.getTime()),
  );

  // The entire requested period predates the package.
  if (effectiveFrom > requestedTo) {
    return [];
  }

  const ranges = splitByYear(effectiveFrom, requestedTo);
  const name = encodeURIComponent(packageName);

  const chunks = await Promise.all(
    ranges.map(async (range) => {
      const period = `${range.from}:${range.to}`;

      const result = await fetchJSON<NpmDownloadsResponse>(
        `https://api.npmjs.org/downloads/range/${period}/${name}`,
        signal,
      );

      if (!Array.isArray(result.downloads)) {
        throw new TypeError(`Invalid downloads response for ${packageName}`);
      }

      return result.downloads;
    }),
  );

  return chunks.flat();
}

export interface FetchRowsOptions<T> {
  signal?: AbortSignal;
  from?: string;
  to?: string;
  filter?: (record: T) => boolean;
}

export async function* fetchLines(
  url: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Request failed: ${response.status} ${response.statusText}` +
        (body ? ` — ${body.slice(0, 5000)}` : ""),
    );
  }

  if (!response.body) {
    throw new Error("Response has no readable body");
  }

  const reader = response.body
    .pipeThrough(
      new TextDecoderStream("utf-8", {
        fatal: true,
      }),
    )
    .getReader();

  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      buffer += value;

      let newlineIndex: number;

      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        yield line;
      }
    }

    if (buffer !== "") {
      throw new SyntaxError("Stream ended without a final newline");
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original error.
      }
    }

    reader.releaseLock();
  }
}

export function matchesRecord<T extends { day: string }>(
  record: T,
  options: FetchRowsOptions<T>,
): "yield" | "skip" | "stop" {
  if (options.from && record.day < options.from) {
    return "skip";
  }

  // Assumes records are sorted by ascending day.
  if (options.to && record.day > options.to) {
    return "stop";
  }

  if (options.filter && !options.filter(record)) {
    return "skip";
  }

  return "yield";
}

export async function* fetchNDJSON<T extends { day: string } = DownloadRecord>(
  url: string,
  options: FetchRowsOptions<T> = {},
): AsyncGenerator<T, void, void> {
  for await (const line of fetchLines(url, options.signal)) {
    const record = JSON.parse(line) as T;
    const action = matchesRecord(record, options);

    if (action === "stop") {
      return;
    }

    if (action === "yield") {
      yield record;
    }
  }
}

export async function* fetchTOON(
  url: string,
  options: FetchRowsOptions<DownloadRecord> = {},
): AsyncGenerator<DownloadRecord, void, void> {
  let expectedRows: number | undefined;
  let rowsRead = 0;

  for await (const line of fetchLines(url, options.signal)) {
    if (expectedRows === undefined) {
      const header = /^\[(\d+)\]\{downloads,day\}:$/.exec(line);

      if (!header) {
        throw new SyntaxError("Invalid TOON header");
      }

      expectedRows = Number(header[1]);
      continue;
    }

    const row = /^\s+(\d+),(\d{4}-\d{2}-\d{2})$/.exec(line);

    if (!row) {
      throw new SyntaxError(`Invalid TOON row ${rowsRead + 1}`);
    }

    const record: DownloadRecord = {
      downloads: Number(row[1]),
      day: row[2],
    };

    rowsRead++;

    const action = matchesRecord(record, options);

    if (action === "stop") {
      return;
    }

    if (action === "yield") {
      yield record;
    }
  }

  if (expectedRows === undefined) {
    throw new SyntaxError("Missing TOON header");
  }

  if (rowsRead !== expectedRows) {
    throw new SyntaxError(`TOON expected ${expectedRows} rows but received ${rowsRead}`);
  }
}

export async function fetchNpmDownloadsNDJSON(options: NpmDownloadsOptions): Promise<string> {
  const records = await fetchNpmDownloadRecords(options);

  return records
    .map(({ downloads, day }) => JSON.stringify({ downloads, day }))
    .join("\n")
    .concat(records.length ? "\n" : "");
}

export async function fetchNpmDownloadsCSV(options: NpmDownloadsOptions): Promise<string> {
  const records = await fetchNpmDownloadRecords(options);

  return ["downloads,day", ...records.map(({ downloads, day }) => `${downloads},${day}`), ""].join(
    "\n",
  );
}

const csv = await fetchNpmDownloadsCSV({
  packageName: "formidable",
  from: "2015-01-01",
  to: "2026-08-09",
});

console.log(csv);
