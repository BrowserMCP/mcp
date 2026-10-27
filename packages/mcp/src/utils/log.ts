/** Where a layer writes its log lines: the daemon's log file, or stderr in the thin process */
export type Logger = (...args: unknown[]) => void;

/**
 * Logs to stderr, since the thin process's stdout is the MCP transport. AI apps show it in their MCP logs
 */
export const debugLog: Logger = (...args) => {
  console.error(...args);
};
