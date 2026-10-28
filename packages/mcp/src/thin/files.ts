import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * The daemon's `readFile` / `writeFile` (for `upload` and `screenshot --path`). Any path on the machine works, as for the shell commands the agent runs with the user's permissions: `~` is the home directory, and relative paths resolve against the first of the AI app's MCP roots (its working directory when it has none)
 */
export function createFileAccess(
  roots: () => Promise<string[]>,
  home: string = homedir(),
): RpcHandlers<DaemonToClientMethods> {
  async function resolveFile(file: string): Promise<string> {
    if (file === "~" || file.startsWith("~/") || file.startsWith("~\\")) {
      return path.join(home, file.slice(1));
    }
    if (path.isAbsolute(file)) {
      return path.normalize(file);
    }
    const [base = process.cwd()] = await roots();
    return path.resolve(base, file);
  }

  return {
    async readFile({ path: file }) {
      const absolute = await resolveFile(file);
      const data = await readFile(absolute);
      return {
        name: path.basename(absolute),
        mimeType:
          MIME_TYPES[path.extname(absolute).toLowerCase()] ??
          "application/octet-stream",
        base64: data.toString("base64"),
      };
    },
    async writeFile({ path: file, base64 }) {
      const absolute = await resolveFile(file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.from(base64, "base64"));
      return { path: absolute };
    },
  };
}
