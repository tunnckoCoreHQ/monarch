/**
 * Private path rules. A repository lists them in a root `.gitprivate` file, one pattern per line,
 * with gitignore-like syntax: `#` starts a comment, a trailing `/` matches only directories, `*`
 * matches inside one path segment, and `**` matches any number of segments. A pattern without a
 * slash matches at any depth; a pattern with a slash is anchored at the repository root.
 */
export const RULES_FILE = ".gitprivate";

interface Pattern {
  segments: string[];
  dirOnly: boolean;
}

/**
 * Matches one segment against a pattern with `*` and `?`. It backtracks only to the last `*`, so
 * the cost stays within pattern length times value length.
 */
function globSegment(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = v;
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p++;
      v++;
    } else if (star !== -1) {
      p = star + 1;
      v = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") {
    p++;
  }
  return p === pattern.length;
}

function matchSegment(pattern: string, value: string): boolean {
  return pattern === value || (/[*?]/.test(pattern) && globSegment(pattern, value));
}

/** Matches path segments against pattern segments. The memo keeps `**` runs polynomial. */
function matchFrom(pattern: string[], path: string[]): boolean {
  const failed = new Set<number>();
  const width = path.length + 1;
  const step = (pi: number, si: number): boolean => {
    if (pi === pattern.length) {
      return si === path.length;
    }
    const key = pi * width + si;
    if (failed.has(key)) {
      return false;
    }
    let result: boolean;
    if (pattern[pi] === "**") {
      result = step(pi + 1, si) || (si < path.length && step(pi, si + 1));
    } else {
      result = si < path.length && matchSegment(pattern[pi], path[si]) && step(pi + 1, si + 1);
    }
    if (!result) {
      failed.add(key);
    }
    return result;
  };
  return step(0, 0);
}

function canReachBelow(pattern: string[], pi: number, path: string[], si: number): boolean {
  if (si === path.length || pi === pattern.length) {
    return true;
  }
  if (pattern[pi] === "**") {
    return true;
  }
  return matchSegment(pattern[pi], path[si]) && canReachBelow(pattern, pi + 1, path, si + 1);
}

export class PrivateRules {
  readonly patterns: Pattern[];
  readonly key: string;

  constructor(source: string) {
    const lines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    this.patterns = lines.map((line) => {
      const dirOnly = line.endsWith("/");
      const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
      const anchored = line.startsWith("/") || body.includes("/");
      const segments = body.split("/").filter((segment) => segment !== "");
      return { segments: anchored ? segments : ["**", ...segments], dirOnly };
    });
    this.key = lines.join("\n");
  }

  get empty(): boolean {
    return this.patterns.length === 0;
  }

  /** True when the entry at `path` matches a rule itself. */
  matches(path: string, isDir: boolean): boolean {
    const segments = path.split("/");
    return this.patterns.some(
      (pattern) => (isDir || !pattern.dirOnly) && matchFrom(pattern.segments, segments),
    );
  }

  /** True when the path or one of its parent directories is private. */
  isPrivate(path: string, isDir = false): boolean {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (this.matches(segments.slice(0, i).join("/"), true)) {
        return true;
      }
    }
    return this.matches(path, isDir);
  }

  /** True when some rule may match a path inside the directory `path`. */
  reachesInto(path: string): boolean {
    const segments = path.split("/");
    return this.patterns.some((pattern) => canReachBelow(pattern.segments, 0, segments, 0));
  }
}
