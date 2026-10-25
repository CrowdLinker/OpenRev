import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { getPeerIp, type AppEnv, type Runtime } from "../src/server/context";
import { isPublicIp, publicHttpsUrl } from "../src/server/lib/net";
import { matchPath } from "../src/server/lib/validate";

describe("outbound URL guard", () => {
  it("classifies IP literals", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "224.0.0.1"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("accepts only public https URLs", () => {
    expect(publicHttpsUrl("https://hooks.slack.com/services/T/B/x")?.hostname).toBe("hooks.slack.com");
    expect(publicHttpsUrl("https://8.8.8.8/hook")).not.toBeNull();
    for (const url of [
      "http://example.com/",
      "https://localhost/",
      "https://api.localhost/",
      "https://printer.local/",
      "https://metadata.google.internal/",
      "https://intranet/",
      "https://127.0.0.1/",
      "https://2130706433/", // 127.0.0.1 in decimal
      "https://0x7f.1/",
      "https://[::1]/",
      "https://[::ffff:169.254.169.254]/",
      "https://user:pass@example.com/",
      "not a url",
      null,
    ]) {
      expect(publicHttpsUrl(url), String(url)).toBeNull();
    }
  });
});

describe("peer address for rate limits", () => {
  const peer = async (rt: Partial<Runtime>, headers: Record<string, string>) => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("rt", { platform: "node", config: {}, ...rt } as Runtime);
      await next();
    });
    app.get("/", (c) => c.text(String(getPeerIp(c))));
    return (await app.request("/", { headers })).text();
  };
  const xff = { "X-Forwarded-For": "198.51.100.9, 203.0.113.4" };

  it("ignores forwarded headers on a directly exposed server", async () => {
    expect(await peer({ remoteAddress: () => "93.184.216.34" }, xff)).toBe("93.184.216.34");
  });
  it("uses the hop appended by a proxy on a private network", async () => {
    expect(await peer({ remoteAddress: () => "::ffff:172.18.0.1" }, xff)).toBe("203.0.113.4");
  });
  it("uses the socket when proxy trust is off", async () => {
    expect(await peer({ remoteAddress: () => "10.0.0.2", config: { trustProxy: false } as Runtime["config"] }, xff)).toBe("10.0.0.2");
  });
  it("uses CF-Connecting-IP on Workers", async () => {
    expect(await peer({ platform: "cloudflare" }, { ...xff, "CF-Connecting-IP": "192.0.2.77" })).toBe("192.0.2.77");
  });
});

describe("path patterns", () => {
  it("matches globs", () => {
    expect(matchPath("/admin/*", "/admin/users/1")).toBe(true);
    expect(matchPath("/blog/*/edit", "/blog/post/edit")).toBe(true);
    expect(matchPath("/blog/*/edit", "/blog/a/b/edit")).toBe(false);
    expect(matchPath("/docs/**", "/docs/a/b/c")).toBe(true);
    expect(matchPath("/**/private", "/x/y/private")).toBe(true);
    expect(matchPath("/a*c", "/abbbc")).toBe(true);
    expect(matchPath("/a*c", "/ab/c")).toBe(false);
    expect(matchPath("/exact", "/exact")).toBe(true);
    expect(matchPath("/exact", "/exactly")).toBe(false);
  });
  it("stays fast on adversarial patterns", () => {
    const start = performance.now();
    expect(matchPath("/**a**a**a**a**a**a**a**b", "/" + "a".repeat(499))).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
