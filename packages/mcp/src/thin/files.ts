import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { DaemonToClientMethods } from "@/contracts";
import type { RpcHandlers } from "@/utils/rpc";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
};

/** Not following a symlink in the last component, where the platform has it (not on Windows, where `lstat` is the only check) */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The daemon's `readFile` / `writeFile` (for `upload` and `screenshot --path`), limited to the AI app's MCP roots, so a page can't talk the agent into uploading `~/.ssh/id_rsa`. Relative paths resolve against the first root. Roots that would allow everything (`/`, the home directory or one of its parents, e.g. the working directory of an AI app started from the home directory) are ignored, and with none left, file access is refused. Symlinks are refused as the last component, and followed (checking where they lead) elsewhere
 */
export function createFileAccess(
  roots: () => Promise<string[]>,
  home: string = homedir(),
): RpcHandlers<DaemonToClientMethods> {
  /** Resolves `file` (following symlinks as far as they exist), checks it's under a root, and returns the real path to do I/O on */
  async function resolveInRoots(
    file: string,
  ): Promise<{ absolute: string; real: string }> {
    const given = await roots();
    const rootPaths: string[] = [];
    for (const root of given) {
      if (await isProjectRoot(root, home)) {
        rootPaths.push(root);
      }
    }
    if (rootPaths.length === 0) {
      throw new Error(
        `Browser MCP only reads and writes files in the AI app's project directory, and ${given.length ? given.join(", ") : "the working directory"} isn't one. Run the AI app in a project directory, or use an AI app that supports MCP roots`,
      );
    }
    const absolute = path.resolve(rootPaths[0]!, file);
    const real = await realpathOfExisting(absolute);
    for (const root of rootPaths) {
      const realRoot = await realpathOfExisting(path.resolve(root));
      if (isWithin(realRoot, real)) {
        return { absolute, real };
      }
    }
    throw new Error(
      `${file} is outside the AI app's MCP roots (${rootPaths.join(", ")}). Use a file under one of them`,
    );
  }

  return {
    async readFile({ path: file }) {
      const { absolute, real } = await resolveInRoots(file);
      await refuseSymlink(file, real);
      const handle = await open(real, constants.O_RDONLY | O_NOFOLLOW);
      try {
        const data = await handle.readFile();
        return {
          name: path.basename(absolute),
          mimeType:
            MIME_TYPES[path.extname(absolute).toLowerCase()] ??
            "application/octet-stream",
          base64: data.toString("base64"),
        };
      } finally {
        await handle.close();
      }
    },
    async writeFile({ path: file, base64 }) {
      const { absolute, real } = await resolveInRoots(file);
      await mkdir(path.dirname(real), { recursive: true });
      await refuseSymlink(file, real);
      const handle = await open(
        real,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
        0o644,
      );
      try {
        await handle.writeFile(Buffer.from(base64, "base64"));
      } finally {
        await handle.close();
      }
      return { path: absolute };
    },
  };
}

/** Whether `root` may be a root: not a file system root, the home directory or one of its parents */
export async function isProjectRoot(
  root: string,
  home: string = homedir(),
): Promise<boolean> {
  const real = await realpathOfExisting(path.resolve(root)).catch(() => null);
  if (!real || path.parse(real).root === real) {
    return false;
  }
  const realHome = await realpathOfExisting(path.resolve(home)).catch(
    () => home,
  );
  return !isWithin(real, realHome);
}

/** Whether `file` is `dir` or under it */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function refuseSymlink(file: string, real: string) {
  const stats = await lstat(real).catch(() => null);
  if (stats?.isSymbolicLink()) {
    throw new Error(`${file} is a symbolic link. Use the file it points to`);
  }
}

/** The real path of `file`, or of its nearest existing ancestor joined with the rest (for files about to be written). Refuses dangling symlinks, which a write would follow out of the roots */
async function realpathOfExisting(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (
      await lstat(file).then(
        (stats) => stats.isSymbolicLink(),
        () => false,
      )
    ) {
      throw new Error(
        `${file} is a symbolic link to a missing file. Use another path`,
      );
    }
    const parent = path.dirname(file);
    if (parent === file) {
      return file;
    }
    return path.join(await realpathOfExisting(parent), path.basename(file));
  }
}
