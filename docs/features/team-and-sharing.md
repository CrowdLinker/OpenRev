# Team, access & sharing

## Roles

| Role | Can |
|---|---|
| **Owner** | Everything, including deleting the website, resetting stats and granting the owner role |
| **Admin** | Settings, revenue providers, API keys, alerts, funnels, notes, invite members |
| **Viewer** | View dashboards, realtime, visitors and revenue |

Invite people from **Settings → Team**. Existing users are added immediately; otherwise you get an invitation link (valid 14 days, also emailed if email is configured). Instance admins (the first account, and anyone they promote in **Account → Instance administration**) can see every website and toggle public sign-ups.

## Public dashboards

**Settings → General → Public dashboard** creates a read-only link (`/share/<token>`) showing the dashboard, realtime, revenue and funnels — handy for "open startup" pages or investors. Names, emails and individual visitor journeys are never exposed. Disable the link at any time.

## API keys

Website keys (`or_…`) live in **Settings → API & MCP**; account tokens (`ort_…`) in **Account**. See the [API docs](../api/README.md).
