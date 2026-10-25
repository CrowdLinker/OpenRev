import { hmac, hmacBase64, hmacHex, toBase64, type HmacAlgo } from "../../src/server/lib/crypto";
import type { WebhookRequest } from "../../src/server/providers/types";

export const VISITOR = "3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
export const SESSION = "9b8a7c6d-5e4f-4a3b-9c2d-0e1f2a3b4c5d";

/** Builds a webhook request the way the HTTP route hands it to providers. */
export function makeRequest(rawBody: string, headers: Record<string, string> = {}, url = "https://x.test/api/webhooks/abc"): WebhookRequest {
  return { rawBody, headers: new Headers(headers), url: new URL(url), method: "POST" };
}

export function json(body: unknown): string {
  return JSON.stringify(body);
}

export const signHex = (algo: HmacAlgo, secret: string, data: string) => hmacHex(algo, secret, data);
export const signBase64 = (algo: HmacAlgo, secret: string, data: string) => hmacBase64(algo, secret, data);

/** Standard Webhooks headers (https://www.standardwebhooks.com) signed with raw key bytes. */
export async function standardWebhookHeaders(rawBody: string, key: Uint8Array, opts: { id?: string; ts?: number } = {}) {
  const id = opts.id ?? "msg_2abc";
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = toBase64(await hmac("SHA-256", key, `${id}.${ts}.${rawBody}`));
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
}

export function randomKey(len = 24): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(len));
}
