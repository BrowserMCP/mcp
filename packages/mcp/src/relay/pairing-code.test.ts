import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createPairingNonce,
  pairingCode,
  pairingCommitment,
} from "@browsermcp/protocol";

import { generateIdentity } from "@/daemon/identity";

const publicKey = generateIdentity().publicKey;

describe("pairingCode", () => {
  it("is six digits, shown as two groups of three", async () => {
    for (let i = 0; i < 50; i++) {
      expect(
        await pairingCode(
          publicKey,
          createPairingNonce(),
          createPairingNonce(),
        ),
      ).toMatch(/^\d{3} \d{3}$/);
    }
  });

  it("is the first 4 bytes of the SHA-256 of the domain-separated key and nonces, mod 1,000,000, zero-padded", async () => {
    const [extensionNonce, daemonNonce] = ["ZXh0ZW5zaW9u", "ZGFlbW9u"];
    const digest = createHash("sha256")
      .update(
        `browsermcp-pair-code-v1:${publicKey}:${extensionNonce}:${daemonNonce}`,
      )
      .digest();
    const digits = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
    expect(await pairingCode(publicKey, extensionNonce, daemonNonce)).toBe(
      `${digits.slice(0, 3)} ${digits.slice(3)}`,
    );
  });

  it("is the same for the same key and nonces, on either side", async () => {
    const extensionNonce = createPairingNonce();
    const daemonNonce = createPairingNonce();
    const extensionSide = await pairingCode(
      publicKey,
      extensionNonce,
      daemonNonce,
    );
    const daemonSide = await pairingCode(
      publicKey,
      extensionNonce,
      daemonNonce,
    );
    expect(daemonSide).toBe(extensionSide);
  });

  it("changes with either nonce or the key", async () => {
    const extensionNonce = createPairingNonce();
    const daemonNonce = createPairingNonce();
    const code = await pairingCode(publicKey, extensionNonce, daemonNonce);
    // Each differs by chance one time in a million; together, these never collide
    const others = await Promise.all([
      pairingCode(publicKey, createPairingNonce(), daemonNonce),
      pairingCode(publicKey, extensionNonce, createPairingNonce()),
      pairingCode(generateIdentity().publicKey, extensionNonce, daemonNonce),
      // The nonces' order matters
      pairingCode(publicKey, daemonNonce, extensionNonce),
    ]);
    expect(others.every((other) => other === code)).toBe(false);
    const codes = await Promise.all(
      Array.from({ length: 20 }, () =>
        pairingCode(publicKey, createPairingNonce(), daemonNonce),
      ),
    );
    expect(new Set(codes).size).toBeGreaterThan(15);
  });
});

describe("pairingCommitment", () => {
  it("is base64 of the SHA-256 of the nonce's bytes", async () => {
    const nonce = createPairingNonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(32);
    expect(await pairingCommitment(nonce)).toBe(
      createHash("sha256")
        .update(Buffer.from(nonce, "base64"))
        .digest("base64"),
    );
    expect(await pairingCommitment(createPairingNonce())).not.toBe(
      await pairingCommitment(nonce),
    );
  });
});
