/**
 * `pdf` and `download`: files the agent saves from the page, written through the session's `io` like `screenshot --path`.
 *
 * `pdf` prints the page with `Page.printToPDF` on the engine's own CDP session. `download` fetches the URL inside the page, so it gets the page's cookies and CORS applies as for the page's own scripts, and nothing reaches beyond what the page itself could fetch (no `chrome.downloads`, no `Network.loadNetworkResource`, which the extension refuses).
 */
import type { Locator, Page } from "playwright-core";

import { ACTION_TIMEOUT_MS, resolveOne } from "@/commands/actions";
import type { StepContext } from "@/commands/commands";
import { StepError } from "@/commands/output";
import { parseTarget } from "@/commands/targets";

/** The largest file `download` fetches. Its bytes cross CDP and the relay as one base64 string, which stays well under Chrome's 64 MiB message limit */
export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/html": ".html",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** Names Windows reserves for devices, with or without an extension */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** A file name from a page, URL or header, made safe to save: no directories, no leading or trailing dots, no characters or device names file systems refuse */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // oxlint-disable-next-line no-control-regex -- control characters are what this removes
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .slice(0, 120)
    .replace(/[.\s]+$/, "");
  if (!cleaned) return fallback;
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** The file name in a `Content-Disposition` header (`filename*=UTF-8''…` first) */
export function dispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {}
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]).trim() : null;
}

/** Adds the extension for the MIME type when the name has none */
function withExtension(name: string, mimeType: string): string {
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return name;
  return name + (EXTENSIONS[mimeType.split(";")[0].trim().toLowerCase()] ?? "");
}

/**
 * Saves `data` under `path` when the agent gave one (overwriting it, as `screenshot --path` does), else under `name` relative to the MCP root, adding " (1)", " (2)"… rather than overwrite a file that's there, as browsers do
 */
async function save(
  ctx: StepContext,
  data: Buffer,
  path: string | undefined,
  name: string,
): Promise<string> {
  const fail = (file: string, error: unknown) =>
    new StepError(`Couldn't save ${file}: ${(error as Error).message}`);
  if (path) {
    try {
      return await ctx.io.writeFile(path, data);
    } catch (error) {
      throw fail(path, error);
    }
  }
  const dot = name.lastIndexOf(".");
  const [stem, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 0; i < 100; i++) {
    const file = i === 0 ? name : `${stem} (${i})${ext}`;
    try {
      // Created only if it isn't there, so two sessions saving the same name don't overwrite each other
      return await ctx.io.writeFile(file, data, { exclusive: true });
    } catch (error) {
      if (!/EEXIST/.test((error as Error).message)) throw fail(file, error);
    }
  }
  throw new StepError(`Too many files named like ${name}: pass a <path>`);
}

function pathArg(value: string | true | undefined): string | undefined {
  if (value === true) throw new StepError("--path takes a file path");
  return value;
}

export async function pdf(ctx: StepContext): Promise<void> {
  const page = await ctx.page();
  const cdp = await ctx.internalCdp();
  const { data } = await cdp.send("Page.printToPDF", {
    printBackground: true,
    landscape: !!ctx.args.flags.landscape,
    preferCSSPageSize: true,
  });
  const buffer = Buffer.from(data, "base64");
  const title = await page.title().catch(() => "");
  const saved = await save(
    ctx,
    buffer,
    ctx.args.positional[0]?.text ?? pathArg(ctx.args.flags.path),
    `${safeFileName(title.replace(/\s+/g, " "), "page")}.pdf`,
  );
  const pages = buffer.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  ctx.note(
    `${pages ? `${pages.length} page${pages.length === 1 ? "" : "s"}, ` : ""}${formatBytes(buffer.length)}, saved to ${saved}`,
  );
}

/** `download`'s argument is a URL when it has a scheme `fetch` takes (not `a:` of a CSS selector like `a:nth-child(2)`) or starts like a relative URL; anything else is a target */
export function isUrlArgument(text: string): boolean {
  return /^(https?:\/\/|blob:|data:|\/|\.\.?\/|\?)/i.test(text);
}

type Fetched =
  | {
      ok: true;
      base64: string;
      size: number;
      type: string;
      disposition: string | null;
      url: string;
    }
  | { ok: false; reason: "fetch"; message: string; url: string }
  | { ok: false; reason: "status"; status: number; text: string; url: string }
  | { ok: false; reason: "size"; size: number; url: string };

type FetchArgs = { url: string; max: number };

/**
 * Fetches in the page, as its own scripts would, reading at most `max` bytes. For a target, it runs in the target's frame (an iframe's file is fetched as that frame would fetch it). Playwright serializes the function alone, so it takes its arguments either as `page.evaluate`'s only argument or as `locator.evaluate`'s second, after the element
 */
function fetchInPage(
  where: Page | Locator,
  url: string,
  max: number,
): Promise<Fetched> {
  const run = async (first: unknown, second?: FetchArgs): Promise<Fetched> => {
    const { url, max } = (second ?? first) as FetchArgs;
    {
      const absolute = new URL(url, document.baseURI).href;
      let response: Response;
      try {
        response = await fetch(absolute);
      } catch (error) {
        return {
          ok: false,
          reason: "fetch",
          message: String((error as Error)?.message ?? error),
          url: absolute,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: "status",
          status: response.status,
          text: response.statusText,
          url: response.url || absolute,
        };
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > max) {
        void response.body?.cancel();
        return { ok: false, reason: "size", size: declared, url: response.url };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          void reader.cancel();
          return { ok: false, reason: "size", size, url: response.url };
        }
        chunks.push(value);
      }
      let binary = "";
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i += 0x8000) {
          binary += String.fromCharCode(...chunk.subarray(i, i + 0x8000));
        }
      }
      return {
        ok: true,
        base64: btoa(binary),
        size,
        type: response.headers.get("content-type") ?? "",
        disposition: response.headers.get("content-disposition"),
        url: response.url || absolute,
      };
    }
  };
  const args: FetchArgs = { url, max };
  return "goto" in where
    ? where.evaluate(run, args)
    : where.evaluate(run, args, { timeout: ACTION_TIMEOUT_MS });
}

/** The URL a link or media element points at, and a link's `download` name */
async function targetUrl(
  page: Page,
  text: string,
): Promise<{ url: string; name: string | null; locator: Locator }> {
  const t = parseTarget(text);
  const locator = await resolveOne(page, t);
  const found = await locator.evaluate(
    (el) => {
      const link = el.closest(
        "a[href], area[href]",
      ) as HTMLAnchorElement | null;
      if (link) return { url: link.href, name: link.getAttribute("download") };
      const media = el as HTMLImageElement & { data?: string };
      const url =
        media.currentSrc ||
        media.src ||
        (el instanceof HTMLObjectElement ? el.data : "") ||
        el.querySelector("source[src]")?.getAttribute("src") ||
        "";
      return url
        ? { url: new URL(url, document.baseURI).href, name: null }
        : null;
    },
    undefined,
    { timeout: ACTION_TIMEOUT_MS },
  );
  if (!found) {
    throw new StepError(
      `${t.source} isn't a link and has no src. Target the <a>, <img>, <video> or <object>, or pass the URL`,
    );
  }
  return { ...found, locator };
}

export async function download(ctx: StepContext): Promise<void> {
  const page = await ctx.page();
  const arg = ctx.args.positional[0]?.text;
  if (!arg) throw new StepError("Missing <url> or <target>");
  const path = pathArg(ctx.args.flags.path);
  const {
    url,
    name: linkName,
    locator,
  } = isUrlArgument(arg)
    ? { url: arg, name: null, locator: undefined }
    : await targetUrl(page, arg);
  const result = await fetchInPage(locator ?? page, url, DOWNLOAD_MAX_BYTES);
  if (!result.ok) {
    if (result.reason === "status") {
      throw new StepError(
        `${result.url} answered ${result.status}${result.text ? ` ${result.text}` : ""}`,
      );
    }
    if (result.reason === "size") {
      throw new StepError(
        `${result.url} is over ${formatBytes(DOWNLOAD_MAX_BYTES)}${result.size > DOWNLOAD_MAX_BYTES ? ` (${formatBytes(result.size)})` : ""}, the most download fetches`,
      );
    }
    throw new StepError(
      `The page couldn't fetch ${result.url}: ${result.message}. download fetches as the page's scripts do, so the network, the page's CSP and, for another site's file, CORS apply: to get another site's file, \`goto\` a page on that site first`,
    );
  }
  const data = Buffer.from(result.base64, "base64");
  const fromUrl = /^(blob|data):/i.test(result.url)
    ? ""
    : (() => {
        try {
          return decodeURIComponent(
            new URL(result.url).pathname.split("/").pop() ?? "",
          );
        } catch {
          return "";
        }
      })();
  const name = withExtension(
    safeFileName(
      dispositionFileName(result.disposition) || linkName || fromUrl,
      "download",
    ),
    result.type,
  );
  const saved = await save(ctx, data, path, name);
  const type = result.type.split(";")[0].trim();
  ctx.note(
    `${formatBytes(data.length)}${type ? ` ${type}` : ""}, saved to ${saved}`,
  );
}
