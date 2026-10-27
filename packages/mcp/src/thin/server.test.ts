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

  it("reads and writes files only under the client's MCP roots", async () => {
    writeFileSync(path.join(root, "upload.txt"), "data");
    const { run } = await connect({ roots: [root] });
    expect(await run("read upload.txt")).toEqual({
      text: "upload.txt text/plain data",
      isError: false,
    });
    expect(await run(`write shots/page.jpg x`)).toEqual({
      text: path.join(root, "shots/page.jpg"),
      isError: false,
    });
    const outside = await run(
      `read ${path.join(home, "daemon-" + port + ".json")}`,
    );
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain(`outside the AI app's MCP roots (${root})`);
  });

  it("refuses file access when the only root is /", async () => {
    const { run } = await connect({ roots: ["/"] });
    const result = await run("read etc/hosts");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Run the AI app in a project directory");
  });
});

describe("createFileAccess", () => {
  it("refuses paths that escape the roots, including through symlinks", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "browsermcp-outside-"));
    writeFileSync(path.join(outside, "secret"), "s");
    symlinkSync(outside, path.join(root, "link"));
    mkdirSync(path.join(root, "sub"));
    const files = createFileAccess(async () => [root]);
    await expect(files.readFile({ path: "../secret" })).rejects.toThrow(
      /outside/,
    );
    await expect(files.readFile({ path: "link/secret" })).rejects.toThrow(
      /outside/,
    );
    await expect(
      files.writeFile({ path: "link/new.txt", base64: "eA==" }),
    ).rejects.toThrow(/outside/);
    await expect(
      files.writeFile({ path: "sub/new.txt", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(root, "sub/new.txt") });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses dangling symlinks, which a write would follow out of the roots", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "browsermcp-outside-"));
    symlinkSync(path.join(outside, "planted"), path.join(root, "dangling"));
    writeFileSync(path.join(root, "real.txt"), "inside");
    symlinkSync(path.join(root, "real.txt"), path.join(root, "alias.txt"));
    const files = createFileAccess(async () => [root], outside);
    await expect(
      files.writeFile({ path: "dangling", base64: "eA==" }),
    ).rejects.toThrow(/symbolic link/);
    expect(existsSync(path.join(outside, "planted"))).toBe(false);
    // A symlink to a file under the roots is read from where it leads
    await expect(files.readFile({ path: "alias.txt" })).resolves.toMatchObject({
      name: "alias.txt",
      base64: Buffer.from("inside").toString("base64"),
    });
    rmSync(outside, { recursive: true, force: true });
  });

  it("ignores roots that allow everything: /, the home directory and its parents", async () => {
    writeFileSync(path.join(root, "file.txt"), "x");
    const home = path.join(root, "home");
    mkdirSync(home);
    for (const roots of [["/"], [home], [root]]) {
      const files = createFileAccess(async () => roots, home);
      await expect(files.readFile({ path: "file.txt" })).rejects.toThrow(
        "Run the AI app in a project directory, or use an AI app that supports MCP roots",
      );
    }
    // A project root next to them still works, and relative paths resolve against it
    const files = createFileAccess(
      async () => ["/", root],
      path.join(tmpdir(), "elsewhere"),
    );
    await expect(files.readFile({ path: "file.txt" })).resolves.toMatchObject({
      name: "file.txt",
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
