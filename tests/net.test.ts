import { describe, expect, it } from "vitest";
import { isPublicIp, publicHttpsUrl } from "../src/server/lib/net";

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
