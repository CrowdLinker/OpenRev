/**
 * Known crawlers, by the token in their user agent. AI crawlers don't run JavaScript, so the tracker never sees them;
 * the website's server reports their requests (POST /api/v1/crawls) and OpenRev counts them here.
 *
 * Categories:
 * - `ai_training`: collects pages to train AI models.
 * - `ai_search`: indexes pages for an AI search or answer engine.
 * - `ai_user`: fetches a page because a person asked an AI assistant about it, the closest thing to a visit.
 * - `search`: classic search engines, for comparison.
 *
 * Sources: each operator's published crawler documentation. User agents can be spoofed: counts are by user agent.
 */

export const CRAWLER_CATEGORIES = ["ai_training", "ai_search", "ai_user", "search"] as const;
export type CrawlerCategory = (typeof CRAWLER_CATEGORIES)[number];

export interface Crawler {
  /** The user agent token, also the name stored and shown. */
  name: string;
  operator: string;
  category: CrawlerCategory;
}

export const CRAWLERS: Crawler[] = [
  { name: "GPTBot", operator: "OpenAI", category: "ai_training" },
  { name: "OAI-SearchBot", operator: "OpenAI", category: "ai_search" },
  { name: "ChatGPT-User", operator: "OpenAI", category: "ai_user" },
  { name: "ClaudeBot", operator: "Anthropic", category: "ai_training" },
  { name: "Claude-SearchBot", operator: "Anthropic", category: "ai_search" },
  { name: "Claude-User", operator: "Anthropic", category: "ai_user" },
  { name: "anthropic-ai", operator: "Anthropic", category: "ai_training" },
  { name: "PerplexityBot", operator: "Perplexity", category: "ai_search" },
  { name: "Perplexity-User", operator: "Perplexity", category: "ai_user" },
  { name: "Google-CloudVertexBot", operator: "Google", category: "ai_user" },
  { name: "meta-externalagent", operator: "Meta", category: "ai_training" },
  { name: "meta-externalfetcher", operator: "Meta", category: "ai_user" },
  { name: "MistralAI-User", operator: "Mistral", category: "ai_user" },
  { name: "DuckAssistBot", operator: "DuckDuckGo", category: "ai_search" },
  { name: "Amazonbot", operator: "Amazon", category: "ai_training" },
  { name: "Bytespider", operator: "ByteDance", category: "ai_training" },
  { name: "CCBot", operator: "Common Crawl", category: "ai_training" },
  { name: "cohere-ai", operator: "Cohere", category: "ai_training" },
  { name: "AI2Bot", operator: "Allen Institute for AI", category: "ai_training" },
  { name: "Diffbot", operator: "Diffbot", category: "ai_training" },
  { name: "YouBot", operator: "You.com", category: "ai_search" },
  { name: "Timpibot", operator: "Timpi", category: "ai_training" },
  { name: "Googlebot", operator: "Google", category: "search" },
  { name: "bingbot", operator: "Microsoft", category: "search" },
  { name: "Applebot", operator: "Apple", category: "search" },
  { name: "DuckDuckBot", operator: "DuckDuckGo", category: "search" },
  { name: "YandexBot", operator: "Yandex", category: "search" },
  { name: "Baiduspider", operator: "Baidu", category: "search" },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longer names first, so "Claude-SearchBot" wins over a shorter token it contains.
const ORDERED = [...CRAWLERS].sort((a, b) => b.name.length - a.name.length);
// A name is a whole token: "Googlebot-Image" counts as Googlebot, "NotGooglebot" doesn't.
const MATCHERS = ORDERED.map((c) => ({ crawler: c, re: new RegExp(`(?:^|[^a-z0-9])${escape(c.name)}(?:[^a-z0-9]|$)`, "i") }));

/** The crawler a user agent belongs to, or null. */
export function matchCrawler(userAgent: string | null | undefined): Crawler | null {
  if (!userAgent) return null;
  for (const m of MATCHERS) if (m.re.test(userAgent)) return m.crawler;
  return null;
}

export function crawlerByName(name: string): Crawler | null {
  return CRAWLERS.find((c) => c.name === name) ?? null;
}

/**
 * One case-insensitive regular expression (source) matching every known crawler, for server middleware to decide
 * which requests to report. OpenRev matches the user agent again, so a loose pre-filter does no harm.
 */
export const CRAWLER_PATTERN = ORDERED.map((c) => escape(c.name)).join("|");
