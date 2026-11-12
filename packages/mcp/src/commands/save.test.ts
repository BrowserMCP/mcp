import { describe, expect, it } from "vitest";

import {
  dispositionFileName,
  isUrlArgument,
  safeFileName,
} from "@/commands/save";

describe("download's file names and arguments", () => {
  it("tells URLs from targets", () => {
    for (const url of [
      "https://example.com/a.pdf",
      "http://localhost/x",
      "blob:https://example.com/1",
      "data:text/plain,hi",
      "/files/a.pdf",
      "//cdn.example.com/a.pdf",
      "./a.pdf",
      "../a.pdf",
      "?page=2",
    ]) {
      expect(isUrlArgument(url), url).toBe(true);
    }
    for (const target of [
      "e12",
      "f1e3",
      "a:nth-child(2)",
      "li:first-child a",
      "getByRole('link', { name: 'PDF' })",
      "#download",
    ]) {
      expect(isUrlArgument(target), target).toBe(false);
    }
  });

  it("makes names safe to save", () => {
    expect(safeFileName("../../.bashrc", "x")).toBe("bashrc");
    expect(safeFileName("a\\b/c:d?.pdf", "x")).toBe("c_d_.pdf");
    expect(safeFileName("report. ", "x")).toBe("report");
    expect(safeFileName("CON", "x")).toBe("_CON");
    expect(safeFileName("nul.txt", "x")).toBe("_nul.txt");
    expect(safeFileName("console.log", "x")).toBe("console.log");
    expect(safeFileName("...", "download")).toBe("download");
  });

  it("reads Content-Disposition, filename* first", () => {
    expect(
      dispositionFileName(
        `attachment; filename="plain.csv"; filename*=UTF-8''%E2%82%AC%20rates.csv`,
      ),
    ).toBe("€ rates.csv");
    expect(dispositionFileName("attachment; filename=plain.csv")).toBe(
      "plain.csv",
    );
    expect(dispositionFileName("inline")).toBeNull();
    expect(dispositionFileName(null)).toBeNull();
  });
});
