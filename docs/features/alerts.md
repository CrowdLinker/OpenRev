# Alerts & digests

**Settings → Alerts** sends notifications to **Slack, Discord, Telegram, email or any webhook**.

| Alert | When | Message |
|---|---|---|
| New sale / refund | A payment is recorded | Amount (and original currency), product, source & channel, campaign, location & device, landing page, journey (visits, pageviews, days to convert), customer, provider |
| Goal completed | A visitor completes the chosen goal | Goal, source, location, visitor |
| Traffic spike | A source sends ≥ N× (default 4×) its usual hourly visitors, with at least M visitors (default 20) | Source, visitors last hour vs. average, landing page |
| Daily / weekly digest | At the chosen hour in the website timezone (weekly: Mondays) | Visitors, revenue, payments, conversion rate, revenue/visitor, top sources — compared with the previous period |

Use **Send test** to check a destination. The last 50 deliveries (and errors) are listed under the alerts.

## Channels

- **Slack** — an [incoming webhook](https://api.slack.com/messaging/webhooks) URL.
- **Discord** — channel settings → Integrations → Webhooks → copy URL.
- **Telegram** — create a bot with [@BotFather](https://t.me/BotFather), send it a message, then get your chat id from `https://api.telegram.org/bot<token>/getUpdates`.
- **Email** — requires `RESEND_API_KEY` on the instance ([configuration](../self-hosting/configuration.md)).
- **Webhook** — OpenRev POSTs JSON:

```json
{
  "event": "payment.created",
  "website": { "id": "abc123", "domain": "example.com", "name": "Example" },
  "title": "💰 New sale: $49",
  "text": "📣 Source: Hacker News (Organic Social)\n…",
  "url": "https://analytics.example.com/sites/abc123/visitors/…",
  "data": { "amount": 49, "currency": "USD", "source": "Hacker News", "channel": "Organic Social", "country": "US", "visitor_id": "…" }
}
```

Events: `payment.created`, `payment.refunded`, `goal.completed`, `traffic.spike`, `digest`, `test`. Use it with Zapier, Make, n8n or your own backend.

Set `PUBLIC_URL` so messages link to your dashboard.
