# Google Search Console: keywords to revenue

Connect Google Search Console to see the searches that bring visitors from Google, next to an estimate of the revenue
each keyword earns. The dashboard gets a **Search keywords** card: clicks, click-through rate, average position, the
landing page, and estimated revenue.

> **Beta.** Tested against the responses Google documents, not yet against a live Search Console property. If the
> numbers don't match Search Console's own, please [open an issue](https://github.com/CrowdLinker/OpenRev/issues).

## How revenue is estimated

Search Console reports clicks per keyword and landing page, but it doesn't say who clicked, so no single payment can be
tied to a keyword. OpenRev estimates it from landing pages instead:

1. For each landing page, OpenRev adds up the revenue from visits that came from **Google organic search** and entered
   the site on that page. It uses your website's attribution model, as the rest of the dashboard does.
2. That revenue is shared between the keywords that brought clicks to the page, in proportion to their clicks.

If `/pricing` earned $99 from Google organic visits, and "openrev pricing" brought 90 of its 100 clicks, that keyword is
credited $89.10. Each estimate depends on the period: pick a range long enough to include several payments.

Search Console leaves out rare searches to protect privacy (it calls them anonymized queries). Their clicks aren't in
the shares, so the estimates lean a little toward the keywords it does show.

## Set up

Search Console is read with a Google Cloud **service account**: a robot Google account that you create and add as a
user on your property. If you already made one to [import Google Analytics](../guides/import-history.md#google-analytics-4),
reuse it.

1. In the [Google Cloud console](https://console.cloud.google.com/), pick a project, then go to **APIs & Services →
   Library**, search for **Google Search Console API** and select **Enable**.
2. Go to **IAM & Admin → Service accounts → Create service account**, give it a name and select **Done**. Open it,
   then **Keys → Add key → Create new key → JSON**. Your browser downloads the key file.
3. In [Search Console](https://search.google.com/search-console), open your property, then **Settings → Users and
   permissions → Add user**. Paste the service account's email (it ends in `.iam.gserviceaccount.com`) and choose
   **Restricted** permission.
4. In OpenRev, open **Settings → General → Google Search Console**, choose the JSON key file and select **Connect**.
   OpenRev picks the property that matches your website's domain (a domain property first). If none matches, it lists
   the properties the key can read so you can choose.

## Syncing

- After you connect, OpenRev syncs the last few days, then the history: Search Console keeps 16 months. The settings
  page syncs while it's open (select **Sync history now** to continue); otherwise the history fills in a few days at a
  time in the background.
- Every 6 hours OpenRev syncs the latest days again, because Search Console keeps revising them for about two days.
- On an instance with many connected websites, each background run syncs as many days as fit in one run, starting
  from a different website each time, so the history can take longer to fill in.
- OpenRev stores up to 10,000 keyword and landing page pairs per day, the ones with the most clicks first. Pages that
  differ only by protocol or query string are added together, and landing pages are stored as paths, like entry pages.
- Changing the website's timezone deletes the synced days and syncs them again, so each day starts at midnight in the
  new timezone.
- The key is stored encrypted with `OPENREV_SECRET`. **Disconnect** deletes it and the synced data.

## Limits

- Search Console data can't be filtered by OpenRev's filters (country, campaign…). The card asks you to clear filters.
- Days follow Search Console's own dates (Pacific time).
- The card shows Google web search only, not Images, News or Discover.

## API and MCP

- `GET /api/v1/analytics/search-keywords?period=30d&sort=revenue` returns the keywords and totals. `sort` is `clicks`
  (default), `revenue` or `impressions`. See the [REST API](../api/README.md#get-analyticssearch-keywords).
- AI assistants can use the MCP tool `get_search_keywords`, for example: *"Which Google keywords brought the most
  revenue last quarter?"*
