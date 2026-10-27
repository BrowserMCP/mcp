import path from "node:path";
import { build } from "tsup";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The built stub daemon (`stub-daemon.ts`), for tests that start daemon processes */
    stubDaemon: string;
  }
}

/** Builds the stub daemon under `node_modules/.cache`, where its external dependencies (`ws`, `playwright-core`) resolve */
export default async function setup(project: TestProject) {
  const root = path.resolve(import.meta.dirname, "../..");
  const outDir = path.join(root, "node_modules/.cache/browsermcp-test");
  await build({
    entry: { "stub-daemon": path.join(root, "src/testing/stub-daemon.ts") },
    outDir,
    format: ["esm"],
    target: "node20",
    silent: true,
    config: false,
    tsconfig: path.join(root, "tsconfig.json"),
  });
  project.provide("stubDaemon", path.join(outDir, "stub-daemon.js"));
}
