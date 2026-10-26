# Import history from Plausible or Google Analytics

Bring the traffic history you collected before OpenRev, so your charts don't start on the day you switched. Imports
live in **Settings → Data → Import history** and need the admin or owner role.

Imported days are daily totals, not individual visits. They're added to:

- the dashboard's **totals** (visitors, visits, pageviews, bounce rate, visit duration) and **chart**;
- the **top lists**: channels, referrers, UTM tags, pages, entry and exit pages, countries, devices, browsers, operating
  systems, goals and outbound links;
- the same numbers in the [REST API](../api/README.md), the [MCP server](../api/README.md#mcp-server) and
  [public dashboards](../features/team-and-sharing.md).

They're left out of:

- **Filtered views.** Totals per day can't be combined (for example, visitors from Google *and* in Germany), so the
  dashboard says when filters leave imported days out.
- **Funnels, journeys, visitor profiles and realtime**, which need individual visits.
- **Revenue.** Import past payments from your payment provider instead, under **Settings → Revenue**.

Two more things to know:

- **Visitors are counted per day.** Each imported day counts the visitors of that day, so over a month a visitor who came on
  three days counts three times. OpenRev's own data counts unique visitors over the whole range.
- **Visitors are summed across rows.** Within a day, a visitor who came from two sources counts once in each of them.

## Dates

- An import has to **end before the first day OpenRev recorded a visit**, so no day is counted twice. The dashboard
  suggests that date for you.
- **Imports can't overlap.** Delete one import before importing the same days again, for example from another tool.
- Days are taken as they are in the export: Plausible uses your site's timezone, Google Analytics the property's.

Delete an import at any time from the list under **Import history**: its days disappear from every report.

## Plausible

1. In Plausible, open your site's **Site settings → Imports & exports** and select **Export data**. Plausible emails
   you a link to a ZIP file (or, on a self-hosted Community Edition, offers it for download).
2. In OpenRev, open **Settings → Data → Import history → Plausible** and choose the ZIP. You can also choose the CSV
   files from inside it.
3. Check the dates OpenRev found and select **Import**.

The ZIP is read in your browser. Only the daily totals are sent to OpenRev, a few thousand rows at a time; a retried
upload doesn't count anything twice.

What comes across:

| Plausible | OpenRev |
| --- | --- |
| Visitors, visits, pageviews, bounces, visit duration | Totals and chart |
| Sources, referrers, UTM tags | Channels, referrers, UTM tags. Sources are classified with OpenRev's own rules, so they match your newer data |
| Pages, entry pages, exit pages | The same |
| Countries | Countries. Regions and cities aren't imported: Plausible exports them as codes, and OpenRev stores names |
| Devices, browsers, operating systems | The same, renamed to OpenRev's names (for example Mac → macOS, Laptop → desktop) |
| Custom events | Goals. **Outbound Link: Click** events become outbound links |
| Custom properties | Not imported |

## Google Analytics 4

OpenRev reads your GA4 reports through the Google Analytics Data API, signed in as a **service account**: a robot
Google account that you create and give read access to your property. You don't need an OAuth app, and OpenRev never
sees your Google password.

### 1. Create the service account and its key

1. Open the [Google Cloud console](https://console.cloud.google.com/) and pick a project, or create one (any name).
2. Enable the API: **APIs & Services → Library**, search for **Google Analytics Data API** and select **Enable**.
3. Go to **IAM & Admin → Service accounts → Create service account**. Give it a name such as `openrev-import` and
   select **Done**. It doesn't need any Google Cloud roles.
4. Open the new service account, go to **Keys → Add key → Create new key**, choose **JSON** and select **Create**. Your
   browser downloads the key file.
5. Copy the service account's email address, which ends in `.iam.gserviceaccount.com`.

### 2. Give it access to your property

1. In [Google Analytics](https://analytics.google.com/), open **Admin** and, under your property, **Property access
   management**.
2. Select **+ → Add users**, paste the service account's email, choose the **Viewer** role, and select **Add**. You can
   untick "Notify new users by email".
3. Note the **property ID**: **Admin → Property settings → Property details**, a number like `123456789`. It isn't
   the `G-…` measurement ID.

### 3. Import

1. In OpenRev, open **Settings → Data → Import history → Google Analytics**.
2. Enter the property ID, choose the JSON key file, and pick the dates. The end date defaults to the day before
   OpenRev's first visit.
3. Select **Check access and import**. OpenRev first checks the key and the property, then imports one report at a
   time. Keep the page open until the progress bar finishes.

The key is stored encrypted while the import runs and deleted when it finishes. You can then delete the key in Google
Cloud, or remove the service account from your property.

If you close the page before it finishes, the import shows as **Incomplete**: select **Continue the import** to pick up
where it stopped. When Google's hourly quota runs out on a large property, OpenRev waits and retries a few times; if it
still can't continue, come back later and select **Continue the import**.

What comes across:

| Google Analytics 4 | OpenRev |
| --- | --- |
| Total users, sessions, views, engaged sessions, average session duration | Visitors, visits, pageviews, bounces (sessions that weren't engaged), visit duration |
| Session source, medium and campaign | Channels and referrers, classified with OpenRev's own rules (google / organic → Google, Organic Search). UTM source, medium and campaign are filled in for sessions with a campaign name |
| Page path, landing page | Pages, entry pages. Google Analytics has no exit pages |
| Country, region, city | The same |
| Device category, browser, operating system | The same, renamed to OpenRev's names |
| Events | Goals, except the events GA4 records on its own: `page_view`, `session_start`, `first_visit`, `user_engagement`, `scroll` and `click` |

### Troubleshooting

| Message | What to do |
| --- | --- |
| "The service account can't read property …" | Add the service account's email as a Viewer on that property (step 2), and check the property ID. |
| "The API isn't enabled for the service account's Google Cloud project" | Enable the Google Analytics Data API in the project the key comes from, wait a minute, and try again. |
| "That's a measurement ID" | Use the numeric property ID, not the `G-…` ID. |
| "Google rejected the key" | The key was deleted or disabled. Create a new JSON key. |
| "Property … has no data between …" | Pick dates when the property collected data. |

## In the API

Analytics endpoints include imported days by default, with the same rules as the dashboard. Add `imported=false` to
leave them out, for example to compare a period with OpenRev's own data only.
