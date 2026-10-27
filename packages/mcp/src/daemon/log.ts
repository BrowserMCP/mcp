import { appendFileSync, renameSync, statSync } from "node:fs";
import { format } from "node:util";

import type { Logger } from "@/utils/log";

/** Logs to a file capped at `maxBytes`, keeping one rotation (`daemon.log.1`) */
export function createFileLogger(
  file: string,
  {
    maxBytes = 1_000_000,
    echo = false,
  }: { maxBytes?: number; echo?: boolean } = {},
): Logger {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  return (...args) => {
    const line = `${new Date().toISOString()} [${process.pid}] ${format(...args)}\n`;
    if (echo) {
      process.stderr.write(line);
    }
    const bytes = Buffer.byteLength(line);
    try {
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(file, `${file}.1`);
        size = 0;
      }
      appendFileSync(file, line, { mode: 0o600 });
      size += bytes;
    } catch {
      // Logging must never take the daemon down
    }
  };
}
