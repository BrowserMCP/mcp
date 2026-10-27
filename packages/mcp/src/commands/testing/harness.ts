/** Runs the engine against `LaunchedBackend` and the fixture pages, for tests and the eval */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommandEngine } from "@/commands/engine";
import { serveFixtures } from "@/commands/testing/fixtures";
import {
  LaunchedBackend,
  type LaunchOptions,
} from "@/commands/testing/launched-backend";
import type { Capability, CommandEngine, SessionIO } from "@/contracts";

/** File access like the thin process's, limited to one root directory */
export function rootedIO(root: string): SessionIO {
  const resolve = (file: string) => {
    const full = path.resolve(root, file);
    if (!full.startsWith(root + path.sep)) {
      throw new Error(`${file} is outside your MCP roots (${root})`);
    }
    return full;
  };
  return {
    async readFile(file) {
      const full = resolve(file);
      return {
        name: path.basename(full),
        mimeType: "text/plain",
        buffer: readFileSync(full),
      };
    },
    async writeFile(file, data) {
      const full = resolve(file);
      writeFileSync(full, data);
      return full;
    },
  };
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

export async function startHarness(
  options: LaunchOptions & { idleReleaseMs?: number } = {},
) {
  const [backend, fixtures] = await Promise.all([
    LaunchedBackend.launch(options),
    serveFixtures(),
  ]);
  const engine = createCommandEngine({
    backend,
    idleReleaseMs: options.idleReleaseMs,
  });
  const root = mkdtempSync(path.join(tmpdir(), "browsermcp-root-"));
  let sessions = 0;

  function openSession(
    appId = "test-app",
    capabilities: Capability[] = [],
  ): string {
    const id = `s${++sessions}`;
    engine.openSession({
      id,
      app: { id: appId, name: appId },
      capabilities,
      io: rootedIO(root),
    });
    return id;
  }

  async function call(session: string, commands: string | string[]) {
    const result = await engine.callTool(session, "browser", { commands });
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => (item as { text: string }).text)
      .join("\n");
    return { text, result, isError: !!result.isError };
  }

  return {
    backend,
    fixtures,
    engine,
    root,
    openSession,
    call,
    /** Runs commands in a session and returns the text */
    async run(session: string, commands: string | string[]) {
      return (await call(session, commands)).text;
    },
    async close() {
      (engine as CommandEngine & { dispose?: () => void }).dispose?.();
      await Promise.all([backend.close(), fixtures.close()]);
    },
  };
}
