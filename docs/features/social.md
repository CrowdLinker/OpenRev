# Social: 𝕏 and Hacker News

See the posts on 𝕏 and Hacker News that mention or link to your website, and the visitors and revenue each one
brings. The **Social** page lists the posts with their likes, reposts, replies and views, and next to each one the
visits it sent and what those visitors paid. A **Link in bio** card does the same for the 𝕏 profiles whose bio links
to your website: yours, a founder's, or a partner's.

## How visits are matched to posts

When someone clicks a link on 𝕏, the link goes through t.co, and browsers only tell your website that the visit came
from `https://t.co/`. Your analytics see "X" as the source, but not which post. OpenRev works it out from the page the
visitor landed on:

1. A visit from 𝕏 is credited to the **latest post that links to the page it landed on**, if that post was published
   in the 7 days before the visit.
2. Otherwise, to a listed **profile whose bio links to that page**.
3. Otherwise it stays unmatched. The tiles show how many visits were matched.

If one post links to `/pricing` and another, two days later, links to `/pricing` too, visits after the second post go
to the second. A query string or a trailing slash doesn't matter: pages are compared like entry pages.

Hacker News visits are matched the same way, to stories and comments that link to the page.

Revenue is what the matched visits went on to pay, following your website's
[attribution model](../revenue/README.md). Posts are listed by revenue, then visitors.

## Set up

Open **Settings → General → Social: 𝕏 and Hacker News**.

### Hacker News

Turn on **Watch Hacker News** and select **Start watching**. That's all: OpenRev uses the free
[HN Search API](https://hn.algolia.com/api) and needs no account.

- It finds stories that link to your domain, comments that mention it, and stories and comments with your keywords.
  The first check looks back 30 days.
- It checks every hour, and refreshes the points and comment counts of the last 3 days.
- On an instance with many websites, each background run checks as many as fit in one run, starting from a
  different website each time, so a check can come a little later than the hour. Social checks and Search Console
  syncs share each run and take turns going first.

### 𝕏

> **Beta.** 𝕏 search is tested against the responses 𝕏 documents, not yet with a live token. Hacker News search has
> been checked against the live API. If 𝕏 results look wrong, please [open an issue](https://github.com/CrowdLinker/OpenRev/issues).

𝕏 search needs an 𝕏 API app of your own. 𝕏 bills reads from prepaid credits, about **$0.005 per post** read (see 𝕏's
[pricing](https://docs.x.com/x-api/getting-started/pricing)). OpenRev never buys anything for you.

1. In the [𝕏 Developer Console](https://console.x.com), create a project and an app, and add credits.
2. Copy the app's **bearer token** (Keys and tokens). Paste it in OpenRev as it is shown, `%` characters included.
3. Optionally, add **keywords**: your brand or product names, `@handles` or `#hashtags`. Posts that link to your
   domain are found without them.
4. Optionally, add **link-in-bio handles**: 𝕏 accounts whose profile links to your website. Only add accounts that do;
   their visits are matched to the page their bio links to.
5. Set a **monthly limit** on posts read (2,000 by default, about $10), then select **Save**.

What OpenRev reads:

| What | How often | Cost |
| --- | --- | --- |
| Recent search: posts linking to your domain, or with a keyword, reposts left out | Every 6 hours, only posts newer than the last one found; up to 200 per check. The first check goes back 7 days, the most 𝕏 allows. | About $0.005 per post |
| The listed profiles, for their bio links | When you change the handles, then once a week | About $0.01 per profile |

- **Check now** looks right away, but not more than once every 5 minutes for 𝕏.
- When the posts read this month reach your limit, OpenRev pauses 𝕏 until the next month (UTC) or until you raise
  it. The settings show how many posts were read this month.
- Changing the keywords starts the search again from 7 days back, so some posts may be read (and billed) again.
- Likes, reposts, replies and views are the ones 𝕏 reported when OpenRev found the post. They aren't refreshed,
  because each read costs.
- The token is stored encrypted with `OPENREV_SECRET`, and never sent back to the browser. **Remove 𝕏 token**
  deletes it; **Stop and delete posts** deletes everything.

## Link-in-bio pages

Visits from link-in-bio pages show as their own sources under Organic Social: Linktree, Beacons, Bio.link, Lnk.Bio,
Stan, Linkin.bio (Later), Taplink, Campsite, Solo.to, Milkshake, Hoo.be, Snipfeed and Komi. Instagram and TikTok bio
links appear as Instagram and TikTok.

To tell apart several links that land on the same page (a bio link and a post, or two campaigns), add a parameter to
each one, like `?ref=bio` or `?utm_campaign=launch-post`. They show in the **Ref** and **Campaign** tabs of the
dashboard's sources card.

## Limits

- Matching is an estimate: a visitor who saw two posts linking to the same page is credited to the latest one.
- 𝕏's recent search only covers the last 7 days, so posts from before you connected aren't found.
- Filters don't apply to the Social page.
- Shared dashboards show the Social page once a post was found.

## API and MCP

- `GET /api/v1/analytics/social?period=30d` returns `summary`, `posts` and `profiles`. `platform` (`x` or `hn`)
  narrows it to one platform. See the [REST API](../api/README.md#get-analyticssocial).
- AI assistants can use the MCP tool `get_social_posts`, for example: *"Which posts brought us customers last month?"*
