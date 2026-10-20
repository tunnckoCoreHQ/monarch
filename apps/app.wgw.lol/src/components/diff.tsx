import { useMemo } from "react";

import { Empty } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import type { FileDiff } from "~/lib/api";
import { cn } from "~/lib/utils";

type LineKind = "hunk" | "add" | "del" | "context" | "note";

interface DiffLine {
  kind: LineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const ROW_TONE: Record<LineKind, string> = {
  hunk: "bg-diff-hunk text-violet",
  add: "bg-diff-add",
  del: "bg-diff-del",
  context: "",
  note: "text-faint italic",
};

// Gutters are opaque so they stay readable while the code scrolls under them.
const GUTTER_TONE: Record<LineKind, string> = {
  hunk: "bg-diff-hunk",
  add: "bg-diff-add-gutter text-foreground/75",
  del: "bg-diff-del-gutter text-foreground/75",
  context: "bg-background text-faint",
  note: "bg-background",
};

const SIGN: Record<LineKind, string> = { hunk: "", add: "+", del: "-", context: "", note: "" };

const STATUS_BADGE = {
  added: "signal",
  deleted: "destructive",
  modified: "violet",
} as const;

/** Reads the hunks of a unified patch. Header lines before the first hunk are skipped. */
function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      inHunk = true;
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      lines.push({ kind: "hunk", text: line, oldNumber: null, newNumber: null });
      continue;
    }
    if (!inHunk || line === "") {
      continue;
    }

    const text = line.slice(1);
    if (line.startsWith("+")) {
      lines.push({ kind: "add", text, oldNumber: null, newNumber });
      newNumber++;
    } else if (line.startsWith("-")) {
      lines.push({ kind: "del", text, oldNumber, newNumber: null });
      oldNumber++;
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "note", text, oldNumber: null, newNumber: null });
    } else {
      lines.push({ kind: "context", text, oldNumber, newNumber });
      oldNumber++;
      newNumber++;
    }
  }
  return lines;
}

function FilePatch({ file }: { file: FileDiff }) {
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, line.oldNumber ?? 0, line.newNumber ?? 0);
  }
  const numberWidth = `${String(widest).length + 2}ch`;

  return (
    <section aria-label={file.path} className="min-w-0 border">
      <header className="bg-card flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 font-mono text-xs">
        <Badge variant={STATUS_BADGE[file.status]}>{file.status}</Badge>
        <span className="min-w-0 flex-1 font-semibold wrap-anywhere">{file.path}</span>
        <span className="flex shrink-0 gap-2">
          <span className="text-signal">+{file.additions}</span>
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </header>
      {file.binary ? (
        <p className="text-muted-foreground px-4 py-3 font-mono text-xs">
          Binary file. There is no text diff.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="w-max min-w-full py-1 font-mono text-[12.5px] leading-5">
            {lines.map((line, index) => (
              <div key={index} className={cn("flex", ROW_TONE[line.kind])}>
                <span
                  aria-hidden
                  className={cn("sticky left-0 flex shrink-0 select-none", GUTTER_TONE[line.kind])}
                >
                  <span className="pr-2 text-right" style={{ width: numberWidth }}>
                    {line.oldNumber ?? ""}
                  </span>
                  <span className="pr-2 text-right" style={{ width: numberWidth }}>
                    {line.newNumber ?? ""}
                  </span>
                </span>
                <span
                  className={cn(
                    "w-5 shrink-0 text-center select-none",
                    line.kind === "add" ? "text-signal" : "text-destructive",
                  )}
                >
                  {SIGN[line.kind]}
                </span>
                <span className="pr-6 whitespace-pre">{line.text === "" ? " " : line.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function DiffView({ files }: { files: FileDiff[] }) {
  if (files.length === 0) {
    return <Empty>No file changes.</Empty>;
  }

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-muted-foreground font-mono text-xs">
        {files.length} {files.length === 1 ? "file" : "files"} changed ·{" "}
        <span className="text-signal">+{additions}</span>{" "}
        <span className="text-destructive">−{deletions}</span>
      </p>
      {files.map((file) => (
        <FilePatch key={file.path} file={file} />
      ))}
    </div>
  );
}
