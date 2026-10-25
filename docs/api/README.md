# OpenRev API

Query analytics and revenue, and send payments, goals and identities from your backend. The API is part of every OpenRev instance at `https://YOUR-OPENREV/api/v1`. A machine-readable OpenAPI 3.1 spec is served at `/api/v1/openapi.json`.

- [Authentication](#authentication)
- [Conventions](#conventions) — date ranges, filters, money
- [Analytics](#analytics) — overview, timeseries, breakdowns, realtime
- [Visitors](#visitors)
- [Payments](#payments) — list, create, delete
- [Goals](#goals) · [Identify](#identify) · [Funnels](#funnels) · [LTV](#lifetime-value) · [Websites](#websites)
- [MCP server for AI agents](#mcp-server)

## Authentication

Create a key in the dashboard and send it as a bearer token:

```bash
curl https://analytics.example.com/api/v1/analytics/overview \
  -H "Authorization: Bearer or_xxxxxxxxxxxxxxxxxxxxxxxx"
```

| Key | Prefix | Created in | Scope |
|---|---|---|---|
| Website key | `or_` | Website → Settings → API & MCP | One website (inferred). |
| Account token | `ort_` | Account → Account tokens | Every website you can access — add `websiteId=<id>` to each request. |

Keys inherit the permissions of the user who created them (viewers can read; deleting payments requires admin). Keep keys server-side.

Responses use an envelope:

```json
{ "status": "success", "data": { ... } }
{ "status": "error", "error": { "code": 401, "message": "Missing or invalid API key" } }
```

## Conventions

**Date range** (all analytics endpoints):

| Param | Example | Notes |
|---|---|---|
| `period` | `today`, `yesterday`, `24h`, `7d` (default), `30d`, `90d`, `wtd`, `mtd`, `ytd`, `12m`, `all` | Relative to the website timezone |
| `from` & `to` | `2026-01-01` & `2026-01-31` | Custom range, inclusive |
| `timezone` | `Europe/Paris` | Override the website timezone |
| `interval` | `hour`, `day`, `week`, `month` | Timeseries bucket (auto by default) |

**Filters**: either a JSON array in `filters`

```
filters=[{"dim":"country","op":"is","values":["US","CA"]},{"dim":"page","op":"contains","values":["/blog"]}]
```

or shorthand params `filter_<dimension>=<value>` (`filter_source=Google`, `filter_page=contains:/blog`, `filter_country=US|CA`). Operators: `is`, `is_not`, `contains`, `not_contains`.

**Dimensions**: `channel`, `source` (referrer name), `referrer` (domain), `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `ref`, `page`, `entry_page`, `exit_page`, `hostname`, `outbound`, `country`, `region`, `city`, `device`, `browser`, `os`, `goal`.

**Money**: amounts are integers in **minor units** (cents) of the website currency, which is returned as `currency`. Payment inputs use major units (`29.99`).

## Analytics

### `GET /analytics/overview`

```json
{
  "status": "success",
  "data": {
    "visitors": 1532, "new_visitors": 1290, "returning_visitors": 242,
    "sessions": 1904, "pageviews": 4711, "bounce_rate": 0.41, "avg_session_duration": 73.2,
    "revenue": 412300, "refunds": 4900, "new_revenue": 298000, "renewal_revenue": 119200,
    "payments": 38, "customers": 35, "conversion_rate": 0.021, "revenue_per_visitor": 269.1,
    "kpi": { "goal": "signup", "conversions": 96, "visitors": 91, "conversion_rate": 0.059 },
    "currency": "USD"
  },
  "previous": { "...": "same metrics for the previous period" },
  "range": { "period": "30d", "from": 1790000000000, "to": 1792600000000, "fromDate": "2026-09-26", "toDate": "2026-10-25", "interval": "day", "timezone": "America/New_York" }
}
```

`conversion_rate` = visitors who made a first purchase ÷ visitors (renewals are excluded). `revenue_per_visitor` = revenue ÷ visitors. Add `compare=0` to skip the previous period.

### `GET /analytics/timeseries`

Returns `data: [{ date, start, visitors, sessions, pageviews, bounce_rate, avg_session_duration, revenue, payments, customers, conversions? }]` — one point per bucket, including empty ones.

### `GET /analytics/breakdowns/{dimension}`

```bash
curl "$OPENREV/api/v1/analytics/breakdowns/source?period=30d&sort=revenue&limit=20" -H "Authorization: Bearer $KEY"
```

Each row: `value`, `meta` (favicon domain for sources, country code for regions/cities), `visitors`, `revenue`, `payments`, `customers`, `conversion_rate`, `revenue_per_visitor`, and when relevant `sessions`, `pageviews`, `bounce_rate`, `avg_session_duration`, `completions` (goals). `sort` = `visitors` (default), `revenue`, `conversion_rate`, `completions`. Revenue that couldn't be linked to a visitor appears as `__unattributed__`.

DataFast-style aliases also work: `/analytics/pages`, `/analytics/referrers`, `/analytics/countries`, `/analytics/regions`, `/analytics/cities`, `/analytics/devices`, `/analytics/browsers`, `/analytics/operating-systems`, `/analytics/campaigns`, `/analytics/hostnames`, `/analytics/exit-clicks`, `/analytics/channels`, `/analytics/goals`.

### `GET /analytics/realtime`

Visitors active in the last 5 minutes, live sessions (current page, source, location, buyer-intent score), recent events and payments.

## Visitors

### `GET /visitors`

Visitors seen in the range, with identity, first-touch source and lifetime revenue. Params: date range, filters, `search` (name, email, user id or visitor id), `customers=1` (paying only), `goal=<name>` (completed a goal), `limit`, `offset`.

### `GET /visitors/{visitorId}`

Full profile: `visitor` (identity and custom properties), `sessions`, `events` (pageviews, goals, outbound clicks), `payments`, `revenue`. Visitors identified with the same `user_id` are merged (cross-device).

## Payments

### `POST /payments`

Record a payment from any payment system — call it from your backend after a successful charge. Idempotent on `transaction_id`.

```bash
curl -X POST "$OPENREV/api/v1/payments" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "amount": 29.99,
    "currency": "USD",
    "transaction_id": "txn_98hj",
    "openrev_visitor_id": "3cff4252-…",
    "email": "jane@example.com",
    "name": "Jane",
    "customer_id": "cus_123",
    "renewal": false,
    "refunded": false,
    "timestamp": "2026-10-25T10:00:00Z",
    "description": "Pro plan"
  }'
```

| Field | Required | Notes |
|---|---|---|
| `amount` | ✓ | Major units (`29.99`). |
| `currency` | ✓ | ISO 4217. Converted to the website currency. |
| `transaction_id` | ✓ | Unique per payment; re-sending is a no-op (`200` instead of `201`). |
| `openrev_visitor_id` | | Value of the `openrev_visitor_id` cookie. `visitor_id` and `datafast_visitor_id` are accepted. Without it, OpenRev tries the customer id and email. |
| `openrev_session_id` | | Optional, the `openrev_session_id` cookie. |
| `email`, `name`, `customer_id` | | Used to link renewals and identify customers. |
| `renewal` | | `true` for recurring charges. |
| `refunded` | | `true` for refunds (`amount` = refunded amount). Use `related_transaction_id` to inherit the original attribution. |
| `timestamp` | | ISO 8601 or unix seconds/ms. Defaults to now. |
| `provider` | | Label shown in the dashboard (default `api`). |

### `GET /payments`

Payments in the range with the attributed session (`source`, `channel`, `country`, `utm_campaign`…).

### `DELETE /payments/{id}`

Delete by OpenRev id or `transaction_id` (admin keys).

## Goals

### `POST /goals`

```json
{ "name": "trial_started", "openrev_visitor_id": "3cff4252-…", "metadata": { "plan": "pro" } }
```

Goal names: lowercase letters, numbers, `_`, `-`, `:` (max 64). Up to 10 metadata properties (values ≤ 255 chars). Optional `timestamp` (ISO 8601 or unix seconds/ms). The visitor must have a recorded visit, otherwise `422`.

### `GET /goals`

Goals with visitors, completions, conversion rate and revenue from visitors who completed them.

## Identify

### `POST /identify`

```json
{ "openrev_visitor_id": "3cff4252-…", "user_id": "usr_123", "name": "Jane Doe", "email": "jane@example.com", "image": "https://…/avatar.png", "plan": "pro" }
```

Extra keys are stored as custom properties (shallow-merged). Identifying with an email links any unattributed payments made with that email. Identify never creates visits, so it doesn't affect traffic stats.

## Funnels

- `GET /funnels` — list funnels.
- `GET /funnels/{id}` — results per step: `visitors`, `conversion_rate` (from step 1), `step_conversion_rate`, `dropoff`, `revenue`.

## Lifetime value

`GET /ltv?group=source|channel|country|utm_campaign` — customers acquired in the range grouped by their first-touch source, with lifetime revenue, average LTV, renewals and repeat-purchase rate.

## Websites

`GET /websites` — websites accessible with the key (`id`, `domain`, `name`, `timezone`, `currency`).

## MCP server

OpenRev includes a [Model Context Protocol](https://modelcontextprotocol.io) server (Streamable HTTP) at `https://YOUR-OPENREV/mcp`, so AI assistants can answer questions like *"Which channels drove the most revenue last month?"* or *"Show me the journey of my last 5 customers"*.

**Claude Code**

```bash
claude mcp add --transport http openrev https://analytics.example.com/mcp --header "Authorization: Bearer or_xxx"
```

**Cursor / Claude Desktop / other clients** (`mcp.json`)

```json
{
  "mcpServers": {
    "openrev": {
      "url": "https://analytics.example.com/mcp",
      "headers": { "Authorization": "Bearer or_xxx" }
    }
  }
}
```

Tools: `list_websites`, `get_overview`, `get_timeseries`, `get_breakdown`, `get_realtime`, `list_visitors`, `get_visitor`, `list_payments`, `get_ltv`, `list_funnels`, `get_funnel`, `add_note`. With an account token (`ort_`), pass `websiteId` to each tool (use `list_websites` first).
