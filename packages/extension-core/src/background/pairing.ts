import {
  PAIRING_KEY_ALGORITHM,
  pairingCode,
  pairingCommitment,
  pairingPayload,
} from "@browsermcp/protocol";

import { pairedDaemonKeysItem } from "../storage";

/** Base64 of 32 random bytes, which the daemon signs in `welcome` */
export function createChallenge(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Whether the daemon holds the private key of `publicKey` (base64 SPKI): its signature of `pairingPayload(challenge, port, pairingCommitment)` (base64 IEEE P1363), with the port the extension dialed, verifies. `false` for malformed keys, signatures or commitments, and for a signature made for another port (a program on one of `RELAY_PORTS` relaying the challenge to the real daemon)
 */
export async function verifyDaemonSignature({
  challenge,
  port,
  publicKey,
  pairingCommitment,
  signature,
}: {
  challenge: string;
  port: number;
  publicKey: string;
  pairingCommitment: string;
  signature: string;
}): Promise<boolean> {
  if (typeof pairingCommitment !== "string" || !pairingCommitment) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64(publicKey),
      {
        name: PAIRING_KEY_ALGORITHM.name,
        namedCurve: PAIRING_KEY_ALGORITHM.namedCurve,
      },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: PAIRING_KEY_ALGORITHM.name, hash: PAIRING_KEY_ALGORITHM.hash },
      key,
      fromBase64(signature),
      new TextEncoder().encode(
        pairingPayload(challenge, port, pairingCommitment),
      ),
    );
  } catch {
    return false;
  }
}

/**
 * The six-digit code the popup shows next to **Allow** and the daemon's tool results show, so the user can match them (`pairingCode()`), once the daemon revealed the nonce `welcome` committed to. `null` when the reveal doesn't match the commitment: the daemon is untrusted
 */
export async function getPairingCode({
  publicKey,
  pairingCommitment: commitment,
  extensionNonce,
  daemonNonce,
}: {
  publicKey: string;
  pairingCommitment: string;
  extensionNonce: string;
  daemonNonce: unknown;
}): Promise<string | null> {
  try {
    if (
      typeof daemonNonce !== "string" ||
      (await pairingCommitment(daemonNonce)) !== commitment
    ) {
      return null;
    }
    return await pairingCode(publicKey, extensionNonce, daemonNonce);
  } catch {
    // Not base64
    return null;
  }
}

/** Whether the user clicked **Allow** for this daemon key, on this browser profile */
export async function isPairedKey(publicKey: string): Promise<boolean> {
  return (await pairedDaemonKeysItem.getValue()).includes(publicKey);
}

export async function addPairedKey(publicKey: string): Promise<void> {
  const keys = await pairedDaemonKeysItem.getValue();
  if (!keys.includes(publicKey)) {
    await pairedDaemonKeysItem.setValue([...keys, publicKey]);
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
