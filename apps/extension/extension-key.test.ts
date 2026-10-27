import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { SELF_BUILT_EXTENSION_ID } from "@browsermcp/protocol";

import { EXTENSION_KEY } from "./extension-key";

/** The extension ID Chrome derives from a manifest's `key`: the first 128 bits of its SHA-256 hash, with each hex digit (0-f) written as a letter (a-p) */
function getExtensionId(key: string) {
  const hash = createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...hash]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

it("gives the ID the server accepts", () => {
  expect(getExtensionId(EXTENSION_KEY)).toBe(SELF_BUILT_EXTENSION_ID);
});
