import path from "node:path/posix";

import type { IFileSystem } from "just-bash";

/**
 * A project as data: file contents and symlinks, keyed by absolute VFS path. This is how a project
 * reaches the VFS where there is no disk to read it from, such as a Worker.
 */
export interface Snapshot {
  /** UTF-8 text, or base64 for binary files listed in `binary`. */
  files: Record<string, string>;
  binary?: string[];
  /** Symlink path → target, as `readlink` returns it (relative or absolute). */
  links: Record<string, string>;
}

/** Fill a virtual filesystem from a snapshot. */
export async function loadSnapshot(fs: IFileSystem, snapshot: Snapshot): Promise<void> {
  const binary = new Set(snapshot.binary);
  for (const [file, content] of Object.entries(snapshot.files)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      binary.has(file) ? Uint8Array.from(atob(content), (char) => char.charCodeAt(0)) : content,
    );
  }
  for (const [link, target] of Object.entries(snapshot.links)) {
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
  }
}
