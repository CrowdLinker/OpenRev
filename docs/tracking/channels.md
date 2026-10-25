# Sources and channels

Every session gets a **source** (Google, Hacker News, newsletter…) and a **channel** (Organic Search, Paid Social, Email…). Revenue, goals and visitors are credited to them, so it's worth knowing how they're decided and how to tag your links.

## When attribution is decided

At the start of each session, from the landing URL and the referrer. A session ends after 30 minutes without activity. UTM tags or a different referrer later in the same session don't change it.

The dashboard shows it in the sources panel: **Channel**, **Referrer**, **Campaign**, **UTM source**, **Medium** and **Ref** tabs.

## Source

The first of these that exists:

1. a **known referrer**, shown by name (`google.com`, `google.de` → Google; `news.ycombinator.com` → Hacker News; `chatgpt.com` → ChatGPT);
2. any other **referrer domain** (`someblog.com`);
3. **`utm_source`**, with common values given a proper name (`twitter` / `x` → X, `fb` → Facebook, `ig` → Instagram, `hn` → Hacker News, `chatgpt.com` → ChatGPT, `newsletter` → Newsletter);
4. the app of an **in-app browser** (Instagram, Facebook, TikTok, LinkedIn, X, Snapchat, Pinterest, Reddit, Threads, WeChat, LINE, Telegram, Discord, YouTube) when there's no referrer;
5. the **`ref`**, **`via`** or **`source`** URL parameter;
6. otherwise **Direct**.

A visit with an external referrer keeps the referrer as its source, even if the link has a `utm_source`. The UTM values are still stored and shown in their own tabs.

## Channel

Rules are checked in this order; the first match wins.

| # | Channel | When |
| --- | --- | --- |
| 1 | **Paid Search** | Landing URL has `gclid`, `gbraid`, `wbraid` (Google Ads) or `msclkid` (Microsoft Ads); or a paid `utm_medium` (below) with a search engine source; or `utm_medium=paidsearch` / `paid_search` / `paid-search` / `sem` (any source) |
| 2 | **Paid Social** | Landing URL has `ttclid` (TikTok), `li_fat_id` (LinkedIn), `twclid` (X), `sccid` (Snapchat), `epik` (Pinterest) or `rdt_cid` (Reddit); or a paid `utm_medium` with a social source; or `utm_medium` like `paid_social`, `paid-social`, `paidsocial` |
| 3 | **Display** | `utm_medium` is `display`, `banner`, `cpm` or `programmatic` |
| 4 | **Paid Other** | Any other paid `utm_medium` |
| 5 | **Affiliate** | `utm_medium` is `affiliate`, `affiliates`, `partner` or `referral_program` |
| 6 | **Email** | `utm_medium` contains `email`, `e-mail` or `newsletter`; or `utm_source` is `newsletter` or `email`; or the referrer is webmail (Gmail, Outlook, Yahoo Mail, Proton Mail, Fastmail, iCloud Mail) |
| 7 | **AI** | The referrer (or, without a referrer, the `utm_source`) is an AI assistant: ChatGPT, Perplexity, Claude, Gemini, Copilot, DeepSeek, Grok, Meta AI, Mistral, Poe, You.com, Phind, Kimi, Qwen — e.g. `utm_source=chatgpt.com` |
| 8 | **Organic Search** | The referrer is a search engine (Google and its country domains, Bing, DuckDuckGo, Yahoo, Yandex, Baidu, Ecosia, Brave Search, Startpage, Qwant, Naver, Seznam, Sogou, Kagi, AOL, Ask, Mojeek, Daum); or `utm_source` names a search engine (`google`, `bing`, `duckduckgo`, `yahoo`… or its domain); or `utm_medium=organic` |
| 9 | **Organic Social** | The referrer is a social network or community (X, Facebook, Instagram, LinkedIn, Reddit, Hacker News, YouTube, TikTok, Pinterest, Threads, Bluesky, Mastodon, Product Hunt, Indie Hackers, Discord, Telegram, WhatsApp, Slack, Medium, Quora, Dev.to, Stack Overflow…); or `utm_source` names one of them (`x`, `twitter`, `facebook`, `fb`, `instagram`, `ig`, `linkedin`, `reddit`, `hn`, `producthunt`, `youtube`, `tiktok`, `snapchat`, `pinterest`, `threads`, `bluesky`… or its domain); or `utm_medium` is `social`, `social-media`, `social_media`, `social-network` or `sm` |
| 10 | **Referral** | Any other external referrer |
| 11 | **Organic Social** | No referrer, but the visit opened in a social app's in-app browser |
| 12 | **Referral** | No referrer, but the URL has a `utm_source` or a `ref` / `via` / `source` parameter |
| 13 | **Direct** | None of the above |

**Paid `utm_medium` values:** `cpc`, `ppc`, `paid`, `paidsearch`, `paid_search`, `paid-search`, `cpv`, `cpa`, `cpm`, `paid_social`, `paidsocial`, `paid-social`, `ad`, `ads`, `sponsored`. Matching is case-insensitive.

### Special cases

- **Your own domains** (your domain, its subdomains and your [additional domains](cross-domain.md)) are never a referrer. A visit "from" your own site with no tags is Direct.
- **Checkout pages:** a new session whose referrer is a payment page (Stripe Checkout, Lemon Squeezy, Polar, Paddle, PayPal, Gumroad, Dodo Payments, Creem, Shopify checkout, Paystack, Razorpay) is classified as **Direct**, with the checkout as its source. With the default *last non-direct* attribution model, the purchase stays credited to the source that brought the buyer, not to the checkout.
- **`fbclid`** is recorded but doesn't make a visit paid: Facebook adds it to organic link clicks too. Tag Meta ads with `utm_medium=paid_social` (or `cpc` with `utm_source=facebook`).
- **Android apps:** referrers like `android-app://com.google.android.gm` are recognized (Gmail, Google, YouTube, X, LinkedIn, Reddit, Slack, Telegram, WhatsApp, Facebook, Instagram, Discord, Outlook).

## Tagging links: best practices

Use UTM parameters on every link you control: newsletters, ads, social posts, partner links.

```text
https://example.com/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=2026-10-launch
```

| Parameter | Use it for | Tips |
| --- | --- | --- |
| `utm_source` | Where the link lives | Lowercase, consistent names: `google`, `facebook`, `linkedin`, `x`, `reddit`, `newsletter`, `producthunt`. Pick one spelling and stick to it. |
| `utm_medium` | The type of traffic, which decides the channel | `cpc` for paid search, `paid_social` for social ads, `email` for emails, `social` for organic posts, `affiliate` for partners, `display` for banners |
| `utm_campaign` | The campaign | `2026-10-launch`, `black-friday`. Shown in the **Campaign** tab. |
| `utm_term`, `utm_content` | Keyword, ad variant or link position | Optional |

- Tag **paid** links with a paid `utm_medium`. Google Ads and Microsoft Ads auto-tagging (`gclid`, `msclkid`) is enough for those.
- **Don't** tag links between pages of your own site. Within a session the tags are ignored, but if a visitor clicks one after 30 idle minutes, the new session takes your internal tags as its source.
- A `utm_source` that names a known site (or is its domain, like `news.ycombinator.com`) sets the channel on its own. Unknown values land in **Referral** when the browser sends no referrer — add `utm_medium=social` (or `email`, `cpc`…) to choose the channel.
- AI assistants often add `utm_source=chatgpt.com` (or similar) to links. The visit is **AI** whether or not the browser also sends the assistant as referrer.

## The `ref` parameter

`?ref=`, `?via=` and `?source=` are a lightweight alternative to UTM tags, common for launches and affiliate tools:

```text
https://example.com/?ref=producthunt
```

- The value is stored as the session's **Ref** (dashboard **Ref** tab), whatever the referrer.
- It's used as the source only when there's no referrer, no `utm_source` and no in-app browser. The channel is then **Referral**.
- To credit affiliates to the **Affiliate** channel, add `utm_medium=affiliate` as well.
- If your site already uses a `source` query parameter for something else, those values show up under Ref too.

## Attribution models

Which session gets credit for a payment is set in **Settings → General → Revenue attribution model**:

- **Last non-direct touch** (recommended): the most recent session before the payment that wasn't Direct, or the last session if all were Direct.
- **Last touch**: the most recent session before the payment.
- **First touch**: the visitor's first session.

More in [Revenue](../revenue/README.md).
