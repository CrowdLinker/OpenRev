/**
 * Who sees revenue. A public share link with "Hide revenue on share links" turned on, and a member without "Can see
 * revenue", get every response with the revenue data left out: the server removes it, like personal data on share
 * links, and the dashboard only stops showing what isn't there. Customer and payment counts are revenue data too.
 */

/** Keys that hold revenue data wherever they appear in a response. Tests check responses against this list. */
export const REVENUE_FIELDS = [
  // Amounts
  "revenue",
  "refunds",
  "new_revenue",
  "renewal_revenue",
  "revenue_per_visitor",
  "amount",
  "revenue_currency",
  "credited_revenue",
  "organic_revenue",
  "ai_revenue",
  "ltv",
  "avg_ltv",
  // Payments and customers: a list of payments, or how many there were
  "payments",
  "recent_payments",
  "customers",
  "renewals",
  "repeat_rate",
  // MRR (its reports are refused as a whole; listed so nothing slips through)
  "mrr",
  "arr",
  "arpu",
  "mrr_start",
  "net_change",
  "new_mrr",
  "churned_mrr",
  "subscribers",
  "subscribers_start",
  "new_subscribers",
  "churned_subscribers",
  "churn_rate",
  "revenue_churn_rate",
  "net_revenue_retention",
  "expansion",
  "contraction",
  "reactivation",
  "churn",
] as const;

const FIELDS = new Set<string>(REVENUE_FIELDS);

/** Why a revenue report (payments, LTV, MRR) is refused to a member without "Can see revenue". */
export const REVENUE_HIDDEN = "You can't see revenue on this website. An owner, or an admin who can see revenue, can turn on “Can see revenue” for you in Settings → Team.";
/** Why a member without "Can see revenue" can't change it for anyone, themselves included. */
export const REVENUE_GRANT = "Only members who can see revenue can change who sees it";
/** Why a member without "Can see revenue" can't set up an alert that sends revenue. */
export const REVENUE_ALERT = "Only members who can see revenue can set up payment alerts and digests";
/** The same, on a public share link with "Hide revenue on share links". */
export const REVENUE_HIDDEN_PUBLIC = "Revenue is hidden on this dashboard";

/**
 * A copy of a response without its revenue data. With `purchaseConversion`, `conversion_rate` goes too wherever it sits
 * next to `revenue`: there it's the share of visitors who paid (the overview, breakdowns other than goals), while goal,
 * KPI and funnel conversion rates stay.
 */
export function withoutRevenue<T>(value: T, opts: { purchaseConversion?: boolean } = {}): T {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== "object") return v;
    const purchase = !!opts.purchaseConversion && "revenue" in v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (FIELDS.has(k) || (purchase && k === "conversion_rate")) continue;
      out[k] = strip(x);
    }
    return out;
  };
  return strip(value) as T;
}
