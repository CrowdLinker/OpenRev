/**
 * Referrer normalisation and marketing channel classification.
 */

export const CHANNELS = [
  "Direct",
  "Organic Search",
  "Paid Search",
  "Organic Social",
  "Paid Social",
  "AI",
  "Email",
  "Referral",
  "Affiliate",
  "Display",
  "Paid Other",
] as const;
export type Channel = (typeof CHANNELS)[number];

type Kind = "search" | "social" | "ai" | "email" | "checkout" | "referral";

interface KnownSource {
  name: string;
  kind: Kind;
  /** canonical domain used for icons and grouping */
  domain: string;
}

// Matched against the hostname (without "www.") — exact match or suffix match on "." boundary.
const KNOWN: [string, KnownSource][] = [];
function add(kind: Kind, name: string, domain: string, ...hosts: string[]) {
  for (const h of [domain, ...hosts]) KNOWN.push([h, { name, kind, domain }]);
}

// Search engines
add("search", "Google", "google.com");
add("search", "Bing", "bing.com", "cn.bing.com");
add("search", "DuckDuckGo", "duckduckgo.com");
add("search", "Yahoo", "search.yahoo.com", "yahoo.com", "yahoo.co.jp");
add("search", "Yandex", "yandex.ru", "yandex.com", "ya.ru");
add("search", "Baidu", "baidu.com");
add("search", "Ecosia", "ecosia.org");
add("search", "Brave Search", "search.brave.com");
add("search", "Startpage", "startpage.com");
add("search", "Qwant", "qwant.com");
add("search", "Naver", "naver.com");
add("search", "Seznam", "seznam.cz");
add("search", "Sogou", "sogou.com");
add("search", "Kagi", "kagi.com");
add("search", "AOL", "search.aol.com");
add("search", "Ask", "ask.com");
add("search", "Mojeek", "mojeek.com");
add("search", "Daum", "daum.net");

// AI assistants
add("ai", "ChatGPT", "chatgpt.com", "chat.openai.com", "openai.com");
add("ai", "Perplexity", "perplexity.ai");
add("ai", "Claude", "claude.ai");
add("ai", "Gemini", "gemini.google.com", "bard.google.com");
add("ai", "Copilot", "copilot.microsoft.com", "copilot.cloud.microsoft");
add("ai", "DeepSeek", "chat.deepseek.com", "deepseek.com");
add("ai", "Grok", "grok.com", "x.ai");
add("ai", "Meta AI", "meta.ai");
add("ai", "Mistral", "chat.mistral.ai");
add("ai", "Poe", "poe.com");
add("ai", "You.com", "you.com");
add("ai", "Phind", "phind.com");
add("ai", "Kimi", "kimi.com", "kimi.moonshot.cn");
add("ai", "Qwen", "chat.qwen.ai");

// Social networks & communities
add("social", "X", "x.com", "twitter.com", "t.co", "mobile.twitter.com");
add("social", "Facebook", "facebook.com", "fb.com", "fb.me", "m.facebook.com", "l.facebook.com", "lm.facebook.com");
add("social", "Instagram", "instagram.com", "l.instagram.com");
add("social", "LinkedIn", "linkedin.com", "lnkd.in");
add("social", "Reddit", "reddit.com", "old.reddit.com", "out.reddit.com", "redd.it");
add("social", "Hacker News", "news.ycombinator.com");
add("social", "YouTube", "youtube.com", "youtu.be", "m.youtube.com");
add("social", "TikTok", "tiktok.com");
add("social", "Pinterest", "pinterest.com", "pin.it");
add("social", "Threads", "threads.net", "threads.com");
add("social", "Bluesky", "bsky.app", "go.bsky.app");
add("social", "Mastodon", "mastodon.social", "mastodon.online");
add("social", "Product Hunt", "producthunt.com");
add("social", "Indie Hackers", "indiehackers.com");
add("social", "Discord", "discord.com", "discord.gg", "discordapp.com");
add("social", "Telegram", "t.me", "telegram.org", "web.telegram.org");
add("social", "WhatsApp", "whatsapp.com", "wa.me", "web.whatsapp.com");
add("social", "Snapchat", "snapchat.com");
add("social", "Quora", "quora.com");
add("social", "Medium", "medium.com");
add("social", "Tumblr", "tumblr.com");
add("social", "VK", "vk.com");
add("social", "Weibo", "weibo.com");
add("social", "Slack", "slack.com", "app.slack.com");
add("social", "Lobsters", "lobste.rs");
add("social", "Dev.to", "dev.to");
add("social", "Stack Overflow", "stackoverflow.com");
add("social", "Twitch", "twitch.tv");

// Well-known referral sites (named for nicer display)
add("referral", "GitHub", "github.com");
add("referral", "Google Docs", "docs.google.com");
add("referral", "Google Drive", "drive.google.com");
add("referral", "Google Sites", "sites.google.com");
add("referral", "Notion", "notion.so", "notion.site");
add("referral", "Substack", "substack.com");
add("referral", "Wikipedia", "wikipedia.org");
add("referral", "Beehiiv", "beehiiv.com");

// Webmail
add("email", "Gmail", "mail.google.com");
add("email", "Outlook", "outlook.live.com", "outlook.office.com", "outlook.office365.com");
add("email", "Yahoo Mail", "mail.yahoo.com");
add("email", "Proton Mail", "mail.proton.me");
add("email", "Fastmail", "app.fastmail.com");
add("email", "iCloud Mail", "icloud.com");

// Payment / checkout pages: a visitor coming back from a checkout is not a new acquisition source.
add("checkout", "Stripe Checkout", "checkout.stripe.com", "billing.stripe.com", "buy.stripe.com", "pay.stripe.com", "invoice.stripe.com");
add("checkout", "Lemon Squeezy", "lemonsqueezy.com");
add("checkout", "Polar", "polar.sh", "buy.polar.sh", "sandbox.polar.sh");
add("checkout", "Paddle", "paddle.com", "checkout.paddle.com", "buy.paddle.com");
add("checkout", "PayPal", "paypal.com");
add("checkout", "Gumroad", "gumroad.com");
add("checkout", "Dodo Payments", "dodopayments.com", "checkout.dodopayments.com");
add("checkout", "Creem", "creem.io");
add("checkout", "Shopify Checkout", "checkout.shopify.com", "shop.app");
add("checkout", "Paystack", "checkout.paystack.com", "paystack.com");
add("checkout", "Razorpay", "razorpay.com", "rzp.io");

// Android app referrers (android-app://<package>)
const ANDROID_APPS: Record<string, KnownSource> = {
  "com.google.android.gm": { name: "Gmail", kind: "email", domain: "mail.google.com" },
  "com.google.android.googlequicksearchbox": { name: "Google", kind: "search", domain: "google.com" },
  "com.google.android.youtube": { name: "YouTube", kind: "social", domain: "youtube.com" },
  "com.twitter.android": { name: "X", kind: "social", domain: "x.com" },
  "com.linkedin.android": { name: "LinkedIn", kind: "social", domain: "linkedin.com" },
  "com.reddit.frontpage": { name: "Reddit", kind: "social", domain: "reddit.com" },
  "com.slack": { name: "Slack", kind: "social", domain: "slack.com" },
  "org.telegram.messenger": { name: "Telegram", kind: "social", domain: "t.me" },
  "com.whatsapp": { name: "WhatsApp", kind: "social", domain: "whatsapp.com" },
  "com.facebook.katana": { name: "Facebook", kind: "social", domain: "facebook.com" },
  "com.instagram.android": { name: "Instagram", kind: "social", domain: "instagram.com" },
  "com.discord": { name: "Discord", kind: "social", domain: "discord.com" },
  "com.microsoft.office.outlook": { name: "Outlook", kind: "email", domain: "outlook.live.com" },
};

const KNOWN_MAP = new Map(KNOWN);

const COUNTRY_SEARCH: Record<string, string> = {
  google: "google.com",
  bing: "bing.com",
  yandex: "yandex.ru",
  yahoo: "search.yahoo.com",
  baidu: "baidu.com",
  duckduckgo: "duckduckgo.com",
};

export function lookupHost(host: string): KnownSource | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  // Exact and parent-domain matches first, so mail.google.com or gemini.google.com win over google.com.
  let probe = h;
  while (probe.includes(".")) {
    const hit = KNOWN_MAP.get(probe);
    if (hit) return hit;
    probe = probe.slice(probe.indexOf(".") + 1);
  }
  // Country-specific search engine domains: google.de, google.co.uk, bing.co.jp, yandex.kz ...
  const m = h.match(/^(?:[a-z0-9-]+\.)*(google|bing|yandex|yahoo|baidu|duckduckgo)\.(?:com?\.)?[a-z]{2,3}$/);
  if (m) return KNOWN_MAP.get(COUNTRY_SEARCH[m[1]]) ?? null;
  return null;
}

const UTM_SOURCE_NAMES: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  twitter: "X",
  x: "X",
  "x.com": "X",
  facebook: "Facebook",
  fb: "Facebook",
  instagram: "Instagram",
  ig: "Instagram",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  youtube: "YouTube",
  tiktok: "TikTok",
  hackernews: "Hacker News",
  hn: "Hacker News",
  producthunt: "Product Hunt",
  chatgpt: "ChatGPT",
  "chatgpt.com": "ChatGPT",
  openai: "ChatGPT",
  perplexity: "Perplexity",
  claude: "Claude",
  newsletter: "Newsletter",
  bluesky: "Bluesky",
  threads: "Threads",
  pinterest: "Pinterest",
  discord: "Discord",
  telegram: "Telegram",
  email: "Email",
};

const SOCIAL_SOURCES = new Set(["X", "Facebook", "Instagram", "LinkedIn", "Reddit", "YouTube", "TikTok", "Pinterest", "Snapchat", "Threads", "Bluesky"]);
const SEARCH_SOURCES = new Set(["Google", "Bing", "DuckDuckGo", "Yahoo", "Yandex", "Baidu", "Ecosia", "Brave Search"]);

export interface Attribution {
  referrer: string | null;
  referrerDomain: string | null;
  source: string;
  channel: Channel;
}

export interface AttributionInput {
  referrer?: string | null;
  /** Hostnames that belong to the website itself (self-referrals are treated as Direct). */
  ownHosts?: string[];
  utm: { source?: string | null; medium?: string | null; campaign?: string | null };
  /** Click ids present on the landing URL (gclid, fbclid, msclkid, ...). */
  clickIds?: string[];
  /** In-app browser detected from the user agent (e.g. "Instagram"). */
  inApp?: string | null;
  ref?: string | null;
}

function isOwnHost(host: string, ownHosts: string[] = []) {
  const h = host.replace(/^www\./, "");
  return ownHosts.some((o) => {
    const own = o.replace(/^www\./, "");
    return h === own || h.endsWith("." + own);
  });
}

export function classify(input: AttributionInput): Attribution {
  const medium = (input.utm.medium || "").toLowerCase().trim();
  const utmSource = (input.utm.source || "").trim();
  const clickIds = input.clickIds ?? [];

  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  let known: KnownSource | null = null;

  if (input.referrer) {
    try {
      const url = new URL(input.referrer);
      if (url.protocol === "android-app:") {
        known = ANDROID_APPS[url.hostname] ?? null;
        referrerDomain = known?.domain ?? url.hostname;
        referrer = input.referrer.slice(0, 500);
      } else if (url.protocol === "http:" || url.protocol === "https:") {
        const host = url.hostname.toLowerCase();
        if (!isOwnHost(host, input.ownHosts)) {
          known = lookupHost(host);
          referrerDomain = known?.domain ?? host.replace(/^www\./, "");
          referrer = (url.origin + url.pathname).slice(0, 500);
        }
      }
    } catch {
      // ignore malformed referrers
    }
  }

  // A visitor returning from a checkout page keeps the original attribution.
  if (known?.kind === "checkout") {
    return { referrer, referrerDomain, source: known.name, channel: "Direct" };
  }

  const utmName = utmSource ? UTM_SOURCE_NAMES[utmSource.toLowerCase()] ?? utmSource : null;
  const source = known?.name ?? referrerDomain ?? utmName ?? (input.inApp ? input.inApp : null) ?? (input.ref || null) ?? "Direct";

  // Paid traffic
  const paidMedium = /^(cpc|ppc|paid|paidsearch|paid_search|paid-search|cpv|cpa|cpm|paid_social|paidsocial|paid-social|ads?|sponsored)$/.test(
    medium,
  );
  const hasSearchClick = clickIds.some((c) => c === "gclid" || c === "gbraid" || c === "wbraid" || c === "msclkid");
  const hasSocialClick = clickIds.some((c) => ["ttclid", "li_fat_id", "twclid", "sccid", "epik", "rdt_cid"].includes(c));
  const kind = known?.kind ?? (utmName && SOCIAL_SOURCES.has(utmName) ? "social" : utmName && SEARCH_SOURCES.has(utmName) ? "search" : null);

  let channel: Channel;
  if (hasSearchClick || (paidMedium && kind === "search") || medium === "paidsearch" || medium === "paid_search") {
    channel = "Paid Search";
  } else if (hasSocialClick || (paidMedium && kind === "social") || /paid[_-]?social/.test(medium)) {
    channel = "Paid Social";
  } else if (/^(display|banner|cpm|programmatic)$/.test(medium)) {
    channel = "Display";
  } else if (paidMedium) {
    channel = "Paid Other";
  } else if (/^(affiliate|affiliates|partner|referral_program)$/.test(medium)) {
    channel = "Affiliate";
  } else if (/e-?mail|newsletter/.test(medium) || kind === "email" || utmName === "Newsletter" || utmName === "Email") {
    channel = "Email";
  } else if (kind === "ai") {
    channel = "AI";
  } else if (kind === "search" || medium === "organic") {
    channel = "Organic Search";
  } else if (kind === "social" || /^(social|social-network|social-media|sm|social_media)$/.test(medium)) {
    channel = "Organic Social";
  } else if (referrerDomain) {
    channel = "Referral";
  } else if (input.inApp) {
    channel = "Organic Social";
  } else if (utmName || input.ref) {
    channel = "Referral";
  } else {
    channel = "Direct";
  }

  return { referrer, referrerDomain, source, channel };
}

export const CLICK_ID_PARAMS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "ttclid", "li_fat_id", "twclid", "sccid", "epik", "rdt_cid"];
