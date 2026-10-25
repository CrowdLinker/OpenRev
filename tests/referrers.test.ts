import { describe, expect, it } from "vitest";
import { classify } from "../src/server/lib/referrers";

const utm = (source?: string, medium?: string) => ({ utm: { source, medium } });

describe("channel classification", () => {
  it("classifies referrers", () => {
    expect(classify({ referrer: "https://www.google.de/", utm: {} })).toMatchObject({ source: "Google", channel: "Organic Search" });
    expect(classify({ referrer: "https://t.co/abc", utm: {} })).toMatchObject({ source: "X", referrerDomain: "x.com", channel: "Organic Social" });
    expect(classify({ referrer: "https://chatgpt.com/", utm: {} })).toMatchObject({ source: "ChatGPT", channel: "AI" });
    expect(classify({ referrer: "https://mail.google.com/", utm: {} })).toMatchObject({ source: "Gmail", channel: "Email" });
    expect(classify({ referrer: "https://some-blog.dev/post", utm: {} })).toMatchObject({ source: "some-blog.dev", channel: "Referral" });
    expect(classify({ referrer: "android-app://com.google.android.gm", utm: {} })).toMatchObject({ source: "Gmail", channel: "Email" });
  });

  it("treats self-referrals and checkout returns as direct", () => {
    expect(classify({ referrer: "https://app.example.com/x", ownHosts: ["example.com"], utm: {} })).toMatchObject({ source: "Direct", channel: "Direct" });
    expect(classify({ referrer: "https://checkout.stripe.com/c/pay/cs_1", utm: {} })).toMatchObject({ channel: "Direct" });
  });

  it("classifies UTM-only traffic", () => {
    expect(classify(utm("chatgpt.com"))).toMatchObject({ source: "ChatGPT", channel: "AI" });
    expect(classify(utm("perplexity"))).toMatchObject({ channel: "AI" });
    expect(classify(utm("claude"))).toMatchObject({ channel: "AI" });
    expect(classify(utm("hn"))).toMatchObject({ source: "Hacker News", channel: "Organic Social" });
    expect(classify(utm("producthunt"))).toMatchObject({ channel: "Organic Social" });
    expect(classify(utm("snapchat"))).toMatchObject({ source: "Snapchat", channel: "Organic Social" });
    expect(classify(utm("duckduckgo"))).toMatchObject({ channel: "Organic Search" });
    expect(classify(utm("newsletter"))).toMatchObject({ channel: "Email" });
    expect(classify(utm("partner-site"))).toMatchObject({ source: "partner-site", channel: "Referral" });
  });

  it("classifies paid traffic", () => {
    expect(classify(utm("google", "cpc"))).toMatchObject({ channel: "Paid Search" });
    expect(classify(utm("whatever", "paid-search"))).toMatchObject({ channel: "Paid Search" });
    expect(classify(utm("facebook", "paid_social"))).toMatchObject({ channel: "Paid Social" });
    expect(classify(utm("facebook", "cpc"))).toMatchObject({ channel: "Paid Social" });
    expect(classify(utm("partner", "cpc"))).toMatchObject({ channel: "Paid Other" });
    expect(classify({ utm: {}, clickIds: ["gclid"] })).toMatchObject({ channel: "Paid Search" });
    expect(classify(utm("tiktok", "display"))).toMatchObject({ channel: "Display" });
    expect(classify(utm("partner", "affiliate"))).toMatchObject({ channel: "Affiliate" });
  });

  it("uses in-app browsers when there is no referrer", () => {
    expect(classify({ utm: {}, inApp: "Instagram" })).toMatchObject({ source: "Instagram", channel: "Organic Social" });
    expect(classify({ utm: {} })).toMatchObject({ source: "Direct", channel: "Direct" });
  });
});
