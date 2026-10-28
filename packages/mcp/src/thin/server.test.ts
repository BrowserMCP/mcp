import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";

import { INSTRUCTIONS } from "@/commands/instructions";
import { readDaemonInfo } from "@/daemon/info";
import { daemonInfoPath } from "@/daemon/paths";
import { createFileAccess } from "@/thin/files";
import { createThinServer } from "@/thin/server";

let home: string;
let root: string;
let port: number;
let close: () => Promise<void>;

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "browsermcp-home-"));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "browsermcp-root-")));
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  await close?.();
  const info = readDaemonInfo(daemonInfoPath(home, port));
  if (info) {
    try {
      process.kill(info.pid);
    } catch {
      // Already gone
    }
  }
  // Daemons that lost the race to start may still be writing their log
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  rmSync(root, { recursive: true, force: true });
});

/** The thin process's MCP server, with an MCP client that has roots (or not) */
async function connect({ roots }: { roots?: string[] } = {}) {
  const { server, daemon } = createThinServer({
    capabilities: [],
    port,
    home,
    version: "2.0.0",
    daemonCommand: [process.execPath, inject("stubDaemon")],
    log: () => {},
  });
  const client = new Client(
    { name: "claude-code", version: "1.0.0" },
    { capabilities: roots ? { roots: {} } : {} },
  );
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((root) => ({ uri: pathToFileURL(root).href })),
    }));
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  close = async () => {
    daemon.close();
    await client.close();
  };
  const run = async (commands: string) => {
    const result = (await client.callTool({
      name: "browser",
      arguments: { commands },
    })) as CallToolResult;
    return {
      text: (result.content[0] as { text: string }).text,
      isError: !!result.isError,
    };
  };
  return { client, run };
}

describe("the thin process's MCP server", () => {
  it("serves the daemon's tools, named after the MCP client, with the instructions", async () => {
    const { client, run } = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["browser"]);
    expect(await run("app")).toEqual({
      text: "claude-code Claude Code",
      isError: false,
    });
  });

  it("resolves relative file paths against the client's first MCP root, and reads and writes absolute ones elsewhere", async () => {
    writeFileSync(path.join(root, "upload.txt"), "data");
    writeFileSync(path.join(home, "elsewhere.txt"), "away");
    const { run } = await connect({ roots: [root] });
    expect(await run("read upload.txt")).toEqual({
      text: "upload.txt text/plain data",
      isError: false,
    });
    expect(await run(`write shots/page.jpg x`)).toEqual({
      text: path.join(root, "shots/page.jpg"),
      isError: false,
    });
    expect(await run(`read ${path.join(home, "elsewhere.txt")}`)).toEqual({
      text: "elsewhere.txt text/plain away",
      isError: false,
    });
    expect(await run(`write ${path.join(home, "out/page.jpg")} x`)).toEqual({
      text: path.join(home, "out/page.jpg"),
      isError: false,
    });
  });

  it("resolves relative file paths against a root of / too", async () => {
    const { run } = await connect({ roots: ["/"] });
    expect((await run("read etc/hosts")).text).toContain("hosts ");
  });
});

describe("createFileAccess", () => {
  it("reads and writes absolute paths outside the roots, and through symlinks", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "browsermcp-outside-"));
    writeFileSync(path.join(outside, "secret"), "s");
    symlinkSync(outside, path.join(root, "link"));
    const files = createFileAccess(async () => [root]);
    await expect(
      files.readFile({ path: path.join(outside, "secret") }),
    ).resolves.toMatchObject({
      name: "secret",
      base64: Buffer.from("s").toString("base64"),
    });
    await expect(
      files.readFile({ path: "link/secret" }),
    ).resolves.toMatchObject({ name: "secret" });
    await expect(
      files.writeFile({ path: "link/new.txt", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(root, "link/new.txt") });
    expect(existsSync(path.join(outside, "new.txt"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it("doesn't ask for the roots for absolute paths and ~", async () => {
    writeFileSync(path.join(root, "abs.txt"), "x");
    const files = createFileAccess(async () => {
      throw new Error("asked for the roots");
    }, home);
    await expect(
      files.readFile({ path: path.join(root, "abs.txt") }),
    ).resolves.toMatchObject({ name: "abs.txt" });
    await expect(
      files.writeFile({ path: "~/abs.txt", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(home, "abs.txt") });
  });

  it("expands ~ to the home directory", async () => {
    const files = createFileAccess(async () => [root], home);
    mkdirSync(path.join(home, "Downloads"));
    await expect(
      files.writeFile({ path: "~/Downloads/file.pdf", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(home, "Downloads/file.pdf") });
    await expect(
      files.readFile({ path: "~/Downloads/file.pdf" }),
    ).resolves.toMatchObject({
      name: "file.pdf",
      mimeType: "application/pdf",
    });
  });

  it("uses the working directory when the client has no roots", async () => {
    const files = createFileAccess(async () => [process.cwd()]);
    await expect(
      files.readFile({ path: "package.json" }),
    ).resolves.toMatchObject({
      name: "package.json",
      mimeType: "application/json",
    });
  });
});
