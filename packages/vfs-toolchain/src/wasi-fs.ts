import { Directory, type Fd, Inode, OpenDirectory, wasi } from "@bjorn3/browser_wasi_shim";

/**
 * Symlinks for `@bjorn3/browser_wasi_shim`, whose in-memory filesystem has none. Tools resolve
 * pnpm's `node_modules` through symlinks (`realpath`, then walk up to the store's siblings), so a
 * tree without them resolves packages differently than the disk does. Lookups here follow links
 * the way POSIX does: always for intermediate components, and for the last one unless the caller
 * asked not to (`lstat`, `readlink`).
 */
export class Symlink extends Inode {
  /** Absolute target path, resolved against the link's directory when the tree was taken. */
  readonly target: string;

  constructor(target: string) {
    super();
    this.target = target;
  }

  // oxlint-disable-next-line class-methods-use-this -- the shim's Inode declares this method.
  path_open(): { ret: number; fd_obj: Fd | null } {
    return { ret: wasi.ERRNO_LOOP, fd_obj: null };
  }

  stat(): wasi.Filestat {
    return new wasi.Filestat(this.ino, wasi.FILETYPE_SYMBOLIC_LINK, BigInt(this.target.length));
  }
}

const MAX_LINK_HOPS = 40;
// WASI `lookupflags`: follow a symlink in the last path component.
const LOOKUP_SYMLINK_FOLLOW = 1;

interface Lookup {
  ret: number;
  entry: Inode | null;
}

function splitPath(pathString: string): string[] {
  return pathString.split("/").filter((part) => part !== "" && part !== ".");
}

/** Walk `parts` from `start`, following links (the last one only when `followLast`). */
function lookup(start: VfsDirectory, parts: readonly string[], followLast: boolean): Lookup {
  const queue = [...parts];
  const stack: Directory[] = [];
  let current: Inode = start;
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (!(current instanceof Directory)) {
      return { ret: wasi.ERRNO_NOTDIR, entry: null };
    }
    if (part === "..") {
      current = stack.pop() ?? current;
      continue;
    }
    const child: Inode | undefined = current.contents.get(part);
    if (child === undefined) {
      return { ret: wasi.ERRNO_NOENT, entry: null };
    }
    if (child instanceof Symlink && (queue.length > 0 || followLast)) {
      hops += 1;
      if (hops > MAX_LINK_HOPS) {
        return { ret: wasi.ERRNO_LOOP, entry: null };
      }
      queue.unshift(...splitPath(child.target));
      current = start.root;
      stack.length = 0;
      continue;
    }
    stack.push(current);
    current = child;
  }
  return { ret: wasi.ERRNO_SUCCESS, entry: current };
}

/** A directory whose open file descriptors resolve symlinks. */
export class VfsDirectory extends Directory {
  /** The root of the tree, where absolute link targets start. */
  root: VfsDirectory;

  constructor(contents: Map<string, Inode>, root?: VfsDirectory) {
    super(contents);
    this.root = root ?? this;
  }

  path_open(): { ret: number; fd_obj: OpenDirectory } {
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: new VfsOpenDirectory(this) };
  }

  /** Directories a tool creates resolve links too. */
  create_entry_for_path(pathString: string, isDir: boolean): Lookup {
    const created = super.create_entry_for_path(pathString, isDir);
    if (!(created.entry instanceof Directory) || created.entry instanceof VfsDirectory) {
      return created;
    }
    const directory = new VfsDirectory(created.entry.contents, this.root);
    const parts = splitPath(pathString);
    const parent = this.lookup(parts.slice(0, -1), true).entry;
    if (parent instanceof Directory) {
      parent.contents.set(parts.at(-1)!, directory);
    }
    return { ret: created.ret, entry: directory };
  }

  lookup(parts: readonly string[], followLast: boolean): Lookup {
    return lookup(this, parts, followLast);
  }
}

/** An open directory that resolves paths through {@link VfsDirectory.lookup}. */
export class VfsOpenDirectory extends OpenDirectory {
  declare dir: VfsDirectory;

  private resolve(pathString: string, followLast: boolean): Lookup {
    if (pathString.startsWith("/")) {
      return { ret: wasi.ERRNO_NOTCAPABLE, entry: null };
    }
    return this.dir.lookup(splitPath(pathString), followLast);
  }

  path_filestat_get(
    flags: number,
    pathString: string,
  ): { ret: number; filestat: wasi.Filestat | null } {
    const { ret, entry } = this.resolve(pathString, (flags & LOOKUP_SYMLINK_FOLLOW) !== 0);
    return entry ? { ret: wasi.ERRNO_SUCCESS, filestat: entry.stat() } : { ret, filestat: null };
  }

  path_lookup(pathString: string, dirflags: number): { ret: number; inode_obj: Inode | null } {
    const { ret, entry } = this.resolve(pathString, (dirflags & LOOKUP_SYMLINK_FOLLOW) !== 0);
    return { ret, inode_obj: entry };
  }

  path_readlink(pathString: string): { ret: number; data: string | null } {
    const { ret, entry } = this.resolve(pathString, false);
    if (!entry) {
      return { ret, data: null };
    }
    return entry instanceof Symlink
      ? { ret: wasi.ERRNO_SUCCESS, data: entry.target }
      : { ret: wasi.ERRNO_INVAL, data: null };
  }

  path_open(
    dirflags: number,
    pathString: string,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdFlags: number,
  ): { ret: number; fd_obj: Fd | null } {
    const parts = splitPath(pathString);
    const name = parts.pop();
    if (name === undefined) {
      return this.dir.path_open();
    }
    // Resolve the parent (always following links), then open the last component there.
    const parent = this.dir.lookup(parts, true);
    if (!(parent.entry instanceof VfsDirectory)) {
      return { ret: parent.entry ? wasi.ERRNO_NOTDIR : parent.ret, fd_obj: null };
    }
    const child = parent.entry.contents.get(name);
    if (!(child instanceof Symlink)) {
      // The shim's own open: creating, truncating, and opening files and directories.
      return new OpenDirectory(parent.entry).path_open(
        dirflags,
        name,
        oflags,
        rightsBase,
        rightsInheriting,
        fdFlags,
      );
    }
    if ((dirflags & LOOKUP_SYMLINK_FOLLOW) === 0) {
      return { ret: wasi.ERRNO_LOOP, fd_obj: null };
    }
    const target = parent.entry.root.lookup(splitPath(child.target), true);
    if (!target.entry) {
      return { ret: target.ret, fd_obj: null };
    }
    if ((oflags & wasi.OFLAGS_DIRECTORY) !== 0 && !(target.entry instanceof Directory)) {
      return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
    }
    return target.entry.path_open(oflags, rightsBase, fdFlags);
  }
}

/** The preopened root, `/`. */
export class VfsPreopenDirectory extends VfsOpenDirectory {
  readonly prestat_name: string;

  constructor(name: string, dir: VfsDirectory) {
    super(dir);
    this.prestat_name = name;
  }

  fd_prestat_get(): { ret: number; prestat: wasi.Prestat | null } {
    return { ret: wasi.ERRNO_SUCCESS, prestat: wasi.Prestat.dir(this.prestat_name) };
  }
}
