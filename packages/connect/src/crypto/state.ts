import { createHmac, randomUUID, timingSafeEqual } from "crypto";

export interface StatePayload {
  callback_url: string;
  platform: string;
  nonce: string;
  timestamp: string;
  original_state?: string;
}

export function signState(payload: StatePayload, signingKey: string): string {
  const json = JSON.stringify(payload);
  const signature = createHmac("sha256", signingKey)
    .update(json)
    .digest("hex");
  const encoded = Buffer.from(json).toString("base64url");
  return `${encoded}.${signature}`;
}

export function verifyState(
  signedState: string,
  signingKey: string
): StatePayload | null {
  const dotIndex = signedState.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const encoded = signedState.substring(0, dotIndex);
  const signature = signedState.substring(dotIndex + 1);

  const json = Buffer.from(encoded, "base64url").toString("utf8");
  const expectedSignature = createHmac("sha256", signingKey)
    .update(json)
    .digest("hex");

  if (signature.length !== expectedSignature.length) return null;
  if (
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  )
    return null;

  try {
    return JSON.parse(json) as StatePayload;
  } catch {
    return null;
  }
}

export function createNonce(): string {
  return randomUUID();
}

const NONCE_TTL_MS = 5 * 60 * 1000;

export class NonceStore {
  private nonces = new Map<string, number>();

  add(nonce: string): void {
    this.cleanup();
    this.nonces.set(nonce, Date.now() + NONCE_TTL_MS);
  }

  consume(nonce: string): boolean {
    this.cleanup();
    if (!this.nonces.has(nonce)) return false;
    this.nonces.delete(nonce);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.nonces) {
      if (expiry < now) this.nonces.delete(nonce);
    }
  }
}
