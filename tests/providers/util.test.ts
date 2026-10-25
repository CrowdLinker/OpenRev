import { describe, expect, it } from "vitest";
import { toBase64 } from "../../src/server/lib/crypto";
import {
  asObject,
  pairsToObject,
  parseForm,
  urlTokenMatches,
  utcMs,
  verifyHmacSignature,
  verifyStandardWebhook,
} from "../../src/server/providers/util";
import { makeRequest, randomKey, signBase64, signHex, standardWebhookHeaders } from "./_helpers";

describe("verifyHmacSignature", () => {
  it("accepts hex (case-insensitive) and base64 digests, strips prefixes", async () => {
    const hex = await signHex("SHA-256", "s3cret", "body");
    expect(await verifyHmacSignature({ algorithm: "sha256", secret: "s3cret", data: "body", signature: hex.toUpperCase(), encoding: "hex" })).toBe(true);
    expect(
      await verifyHmacSignature({ algorithm: "sha256", secret: "s3cret", data: "body", signature: `sha256=${hex}`, encoding: "hex", prefix: "sha256=" }),
    ).toBe(true);
    const b64 = await signBase64("SHA-512", "s3cret", "body");
    expect(await verifyHmacSignature({ algorithm: "sha512", secret: "s3cret", data: "body", signature: b64, encoding: "base64" })).toBe(true);
  });

  it("rejects wrong secrets, tampered data, missing secrets and missing signatures", async () => {
    const hex = await signHex("SHA-256", "s3cret", "body");
    expect(await verifyHmacSignature({ algorithm: "sha256", secret: "other", data: "body", signature: hex, encoding: "hex" })).toBe(false);
    expect(await verifyHmacSignature({ algorithm: "sha256", secret: "s3cret", data: "body!", signature: hex, encoding: "hex" })).toBe(false);
    expect(await verifyHmacSignature({ algorithm: "sha256", secret: "", data: "body", signature: hex, encoding: "hex" })).toBe(false);
    expect(await verifyHmacSignature({ algorithm: "sha256", secret: "s3cret", data: "body", signature: null, encoding: "hex" })).toBe(false);
  });
});

describe("verifyStandardWebhook", () => {
  const body = '{"type":"x"}';

  it("strict base64 mode accepts whsec_ secrets and bare base64 secrets", async () => {
    const key = randomKey();
    const headers = await standardWebhookHeaders(body, key);
    expect(await verifyStandardWebhook(makeRequest(body, headers), `whsec_${toBase64(key)}`, 600, "base64")).toBe(true);
    expect(await verifyStandardWebhook(makeRequest(body, headers), toBase64(key), 600, "base64")).toBe(true);
  });

  it("auto mode also accepts the UTF-8 bytes of the whole secret (Polar legacy)", async () => {
    const secret = "whsec_notReallyBase64!!";
    const headers = await standardWebhookHeaders(body, new TextEncoder().encode(secret));
    expect(await verifyStandardWebhook(makeRequest(body, headers), secret, 600, "auto")).toBe(true);
    expect(await verifyStandardWebhook(makeRequest(body, headers), secret, 600, "base64")).toBe(false);
  });

  it("rejects stale timestamps and tampered bodies", async () => {
    const key = randomKey();
    const old = await standardWebhookHeaders(body, key, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(await verifyStandardWebhook(makeRequest(body, old), `whsec_${toBase64(key)}`)).toBe(false);
    const fresh = await standardWebhookHeaders(body, key);
    expect(await verifyStandardWebhook(makeRequest(body + " ", fresh), `whsec_${toBase64(key)}`)).toBe(false);
  });
});

describe("parsing helpers", () => {
  it("parseForm expands bracketed keys", () => {
    const out = parseForm("sale_id=abc&url_params%5Bopenrev_visitor_id%5D=v123&card[type]=visa&tags[]=a&tags[]=b&plain=1");
    expect(out).toEqual({ sale_id: "abc", url_params: { openrev_visitor_id: "v123" }, card: { type: "visa" }, tags: ["a", "b"], plain: "1" });
  });

  it("pairsToObject converts name/value lists", () => {
    expect(pairsToObject([{ name: "a", value: "1" }, { name: "b", value: 2 }, null])).toEqual({ a: "1", b: 2 });
    expect(pairsToObject([{ key: "k", value: "v" }], "key")).toEqual({ k: "v" });
    expect(pairsToObject("nope")).toEqual({});
  });

  it("asObject accepts objects and JSON object strings", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject('{"a":1}')).toEqual({ a: 1 });
    expect(asObject("[1]")).toBeNull();
    expect(asObject([])).toBeNull();
  });

  it("utcMs treats timezone-less timestamps as UTC", () => {
    expect(utcMs("2024-05-01T10:00:00")).toBe(Date.UTC(2024, 4, 1, 10, 0, 0));
    expect(utcMs("2024-05-01T10:00:00+02:00")).toBe(Date.UTC(2024, 4, 1, 8, 0, 0));
    expect(utcMs(1714557600)).toBe(1714557600000);
  });

  it("urlTokenMatches requires the exact token", () => {
    expect(urlTokenMatches(new URL("https://x.test/h?token=abc"), "abc")).toBe(true);
    expect(urlTokenMatches(new URL("https://x.test/h?token=abd"), "abc")).toBe(false);
    expect(urlTokenMatches(new URL("https://x.test/h"), "abc")).toBe(false);
    expect(urlTokenMatches(new URL("https://x.test/h?token="), "")).toBe(false);
  });
});

describe("parseForm safety", () => {
  it("ignores prototype-polluting keys", () => {
    const out = parseForm("__proto__[polluted]=yes&a[constructor][prototype][x]=1&ok=1");
    expect(out).toEqual({ ok: "1" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(pairsToObject([{ name: "__proto__", value: { polluted: 1 } }])).toEqual({});
  });
});
