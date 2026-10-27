import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import {
  RELAY_PRODUCT,
  RelayPaths,
  type RelayStatus,
} from "@browsermcp/protocol";

import type { DaemonInfo } from "@/contracts";
import { RELAY_HOST } from "@/relay/constants";

export function readDaemonInfo(file: string): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
    return typeof info.port === "number" && typeof info.token === "string"
      ? info
      : null;
  } catch {
    return null;
  }
}

/** Writes `daemon.json` (0600) atomically, so a thin process never reads half of it */
export function writeDaemonInfo(file: string, info: DaemonInfo) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

/** Removes `daemon.json` if it still names this process (a newer daemon may have replaced it) */
export function removeDaemonInfo(file: string, pid = process.pid) {
  if (readDaemonInfo(file)?.pid === pid) {
    rmSync(file, { force: true });
  }
}

/** `GET /browsermcp/status`, or null when nothing (or not a Browser MCP daemon) answers */
export async function fetchStatus(
  port: number,
  timeoutMs = 1000,
): Promise<RelayStatus | null> {
  try {
    const response = await fetch(
      `http://${RELAY_HOST}:${port}${RelayPaths.status}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) {
      return null;
    }
    const status = (await response.json()) as RelayStatus;
    return status.product === RELAY_PRODUCT ? status : null;
  } catch {
    return null;
  }
}
