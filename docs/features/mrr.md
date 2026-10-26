# MRR and churn

The **MRR** tab shows monthly recurring revenue and what moved it. It also shows which channels and campaigns bring in
subscribers who stay.

- **MRR and ARR:** at the end of the selected period.
- **Subscribers** and **revenue per subscriber.**
- **Movements:**
  - **New:** first subscriptions.
  - **Expansion:** upgrades.
  - **Reactivation:** subscribers who come back.
  - **Contraction:** downgrades.
  - **Churn:** cancellations.

  Each is shown for the period and per day, week or month on the chart.
- **Subscriber churn:** the share of subscribers at the start of the period who had churned by its end.
- **Revenue churn:** MRR lost to churn and contraction from those subscribers, as a share of the MRR at the start.
- **Net revenue retention:** what those subscribers pay at the end of the period compared with the start, upgrades
  included. Above 100% means expansion outweighs churn.
- **MRR by acquisition:** current MRR, MRR won and MRR lost, by the channel, referrer, campaign or country that brought
  each subscriber in. Each subscription is credited to the session of its first payment, using the website's
  attribution model.

Filters work here too: filter by country or campaign, for example, to see the MRR of subscribers who came from it.

## Where the numbers come from

MRR is built from subscription payments only: payments with a subscription id, from any
[payment provider](../revenue/README.md) or the [Payments API](../api/README.md#post-payments). There's nothing extra to
connect, and imported history counts too.

- **One payment pays for one billing period.** A $120 yearly payment is $10 of MRR, a $30 quarterly one $10.
- **A subscription stays active** while renewals keep coming. A renewal up to 7 days late (card retries, dunning) doesn't
  count as churn.
- **When no renewal comes,** the subscription churns at the end of the period it paid for. A cancelled yearly plan keeps
  its MRR until the year it paid for ends.
- **A later payment** with the same subscription id counts as a reactivation.
- **Upgrades and downgrades** show up as expansion or contraction when a payment for a new amount arrives.
- **Refunds don't change MRR.** It measures recurring commitments; [Revenue](dashboard.md) shows refunds.
- **Mid-cycle proration charges** (for example Stripe with `proration_behavior: always_invoice`) count as the subscription's
  MRR until its next full renewal. With Stripe's default, prorations are added to the next invoice instead, and MRR is
  only off for that one period.

### Billing intervals

To spread a payment over its period, OpenRev needs to know how often the subscription bills. Most providers say so, and
OpenRev stores it with each payment:

| Provider | Interval from |
| --- | --- |
| Stripe | The invoice line's price (`recurring.interval`), or the line's billing period |
| Paddle | The price's `billing_cycle`, or the transaction's `billing_period` |
| Polar | The subscription's or product's `recurring_interval` |
| Gumroad | The membership's `recurrence` |
| Paystack | The plan's `interval` |
| Dodo Payments | `payment_frequency_interval` and `payment_frequency_count` |
| Creem | The product's `billing_period`, or the subscription's current period |
| Razorpay | The subscription's current billing cycle |
| Custom webhook | The **Billing interval path** you configure |
| Payments API | The `interval` and `interval_count` fields |

For other payments, OpenRev infers the interval from the gaps between a subscription's payments. It snaps them to
weekly, monthly, quarterly, half-yearly or yearly. A subscription with a single payment and no interval is assumed to be
monthly until its next payment shows otherwise. The MRR tab says how many subscriptions that applies to.

## API and MCP

- `GET /api/v1/analytics/mrr` returns the summary and the time series.
- `GET /api/v1/analytics/mrr/breakdown?group=channel|source|utm_campaign|country` returns MRR by acquisition.

See the [REST API](../api/README.md#get-analyticsmrr). AI assistants can ask through the MCP tools `get_mrr` and
`get_mrr_breakdown`, for example: *"How much MRR did we lose to churn last month, and which channel's subscribers churn
most?"*
