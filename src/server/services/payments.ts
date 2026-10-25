import type { Runtime } from "../context";
import type { Database, Statement } from "../db/types";
import { convertMinor, getRates, isValidCurrency } from "../lib/currency";
import { isValidClientId, uuid } from "../lib/ids";
import type { Site } from "./sites";

export type PaymentType = "new" | "renewal" | "refund";

/** A payment as understood by OpenRev, produced by provider adapters or the Payments API. */
export interface NormalizedPayment {
  provider: string;
  transactionId: string;
  type: PaymentType;
  /** Amount in minor units of `currency` (always positive, refunds are stored as negative revenue). */
  amount: number;
  currency: string;
  /** Epoch milliseconds; defaults to now. */
  timestamp?: number | null;
  visitorId?: string | null;
  sessionId?: string | null;
  customerId?: string | null;
  email?: string | null;
  name?: string | null;
  /** Checkout reference (e.g. Stripe Checkout Session id) used to match visitors detected on the success page. */
  ref?: string | null;
  /** For refunds: the transaction (or ref) of the original payment. */
  relatedTransactionId?: string | null;
  subscriptionId?: string | null;
  description?: string | null;
  /**
   * When true, a later event for the same transaction replaces the amount instead of being ignored
   * (e.g. Stripe's `charge.refunded` reports the cumulative refunded amount).
   */
  cumulative?: boolean;
}

/** Reserved goals emitted by payment providers (free_trial, subscription_started, ...). */
export interface NormalizedGoal {
  name: string;
  visitorId?: string | null;
  customerId?: string | null;
  email?: string | null;
  ref?: string | null;
  timestamp?: number | null;
  props?: Record<string, string>;
}

export interface PaymentRow {
  id: string;
  site_id: string;
  provider: string;
  transaction_id: string;
  type: PaymentType;
  amount: number;
  currency: string;
  revenue: number;
  revenue_currency: string;
  ts: number;
  visitor_id: string | null;
  first_session_id: string | null;
  last_session_id: string | null;
  touch_session_id: string | null;
  customer_id: string | null;
  email: string | null;
  name: string | null;
  ref: string | null;
  subscription_id: string | null;
  description: string | null;
  created_at: number;
}

interface AttributionSessions {
  first: string | null;
  last: string | null;
  touch: string | null;
}

/** Finds the sessions that get credit for a conversion by `visitorId` at time `ts`. */
export async function attributionSessions(
  db: Database,
  siteId: string,
  visitorId: string,
  ts: number,
  preferredSession?: string | null,
): Promise<AttributionSessions> {
  // Allow a little clock skew between the provider and the tracker.
  const until = ts + 60 * 60 * 1000;
  const row = await db.first<{ first: string | null; last: string | null; touch: string | null; preferred: string | null }>(
    `SELECT
      (SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? ORDER BY started_at ASC LIMIT 1) AS first,
      (SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? AND started_at <= ? ORDER BY started_at DESC LIMIT 1) AS last,
      (SELECT id FROM sessions WHERE site_id = ? AND visitor_id = ? AND started_at <= ? AND channel <> 'Direct' ORDER BY started_at DESC LIMIT 1) AS touch,
      (SELECT id FROM sessions WHERE id = ? AND site_id = ? AND visitor_id = ?) AS preferred`,
    [siteId, visitorId, siteId, visitorId, until, siteId, visitorId, until, preferredSession ?? "", siteId, visitorId],
  );
  const last = row?.preferred ?? row?.last ?? row?.first ?? null;
  return {
    first: row?.first ?? last,
    last,
    touch: row?.touch ?? last,
  };
}

async function resolveVisitor(db: Database, site: Site, p: NormalizedPayment): Promise<string | null> {
  if (isValidClientId(p.visitorId)) return p.visitorId;
  if (p.ref) {
    const hint = await db.first<{ visitor_id: string }>("SELECT visitor_id FROM checkout_refs WHERE site_id = ? AND ref = ?", [
      site.id,
      p.ref,
    ]);
    if (hint) return hint.visitor_id;
  }
  if (p.relatedTransactionId) {
    const original = await db.first<{ visitor_id: string | null }>(
      "SELECT visitor_id FROM payments WHERE site_id = ? AND provider = ? AND (transaction_id = ? OR ref = ?) AND visitor_id IS NOT NULL LIMIT 1",
      [site.id, p.provider, p.relatedTransactionId, p.relatedTransactionId],
    );
    if (original?.visitor_id) return original.visitor_id;
  }
  if (p.customerId) {
    const c = await db.first<{ visitor_id: string | null }>(
      "SELECT visitor_id FROM customers WHERE site_id = ? AND provider = ? AND customer_id = ?",
      [site.id, p.provider, p.customerId],
    );
    if (c?.visitor_id) return c.visitor_id;
    const prev = await db.first<{ visitor_id: string | null }>(
      "SELECT visitor_id FROM payments WHERE site_id = ? AND customer_id = ? AND visitor_id IS NOT NULL ORDER BY ts ASC LIMIT 1",
      [site.id, p.customerId],
    );
    if (prev?.visitor_id) return prev.visitor_id;
  }
  if (p.email) {
    const email = p.email.toLowerCase();
    const v = await db.first<{ id: string }>(
      "SELECT id FROM visitors WHERE site_id = ? AND (LOWER(email) = ? OR LOWER(user_id) = ?) ORDER BY last_seen DESC LIMIT 1",
      [site.id, email, email],
    );
    if (v) return v.id;
    const prev = await db.first<{ visitor_id: string | null }>(
      "SELECT visitor_id FROM payments WHERE site_id = ? AND LOWER(email) = ? AND visitor_id IS NOT NULL ORDER BY ts ASC LIMIT 1",
      [site.id, email],
    );
    if (prev?.visitor_id) return prev.visitor_id;
  }
  return null;
}

export interface RecordResult {
  payment: PaymentRow;
  created: boolean;
}

/** Records (or merges) a payment and attributes it to the visitor's sessions. Idempotent per transaction id. */
export async function recordPayment(rt: Runtime, site: Site, input: NormalizedPayment): Promise<RecordResult> {
  const db = rt.db;
  const currency = (input.currency || site.currency).toUpperCase();
  if (!isValidCurrency(currency)) throw new Error(`Invalid currency: ${input.currency}`);
  if (!input.transactionId) throw new Error("transactionId is required");
  const ts = input.timestamp && Number.isFinite(input.timestamp) ? Math.round(input.timestamp) : Date.now();
  const amountAbs = Math.abs(Math.round(input.amount));
  const signed = input.type === "refund" ? -amountAbs : amountAbs;

  const existing = await db.first<PaymentRow>(
    "SELECT * FROM payments WHERE site_id = ? AND provider = ? AND transaction_id = ?",
    [site.id, input.provider, input.transactionId],
  );

  const visitorId = existing?.visitor_id ?? (await resolveVisitor(db, site, input));
  let sessions: AttributionSessions = {
    first: existing?.first_session_id ?? null,
    last: existing?.last_session_id ?? null,
    touch: existing?.touch_session_id ?? null,
  };
  if (visitorId && !sessions.last) {
    if (input.type === "refund" && input.relatedTransactionId) {
      const original = await db.first<PaymentRow>(
        "SELECT * FROM payments WHERE site_id = ? AND provider = ? AND (transaction_id = ? OR ref = ?) LIMIT 1",
        [site.id, input.provider, input.relatedTransactionId, input.relatedTransactionId],
      );
      if (original?.last_session_id) {
        sessions = { first: original.first_session_id, last: original.last_session_id, touch: original.touch_session_id };
      }
    }
    if (!sessions.last) sessions = await attributionSessions(db, site.id, visitorId, ts, input.sessionId);
  }

  const rates = currency === site.currency ? {} : await getRates(db);
  const revenue = convertMinor(signed, currency, site.currency, rates);
  const id = existing?.id ?? uuid();
  const now = Date.now();
  const email = input.email ? input.email.trim().toLowerCase().slice(0, 254) : null;

  const statements: Statement[] = [
    {
      sql: `INSERT INTO payments (id, site_id, provider, transaction_id, type, amount, currency, revenue, revenue_currency, ts,
              visitor_id, first_session_id, last_session_id, touch_session_id, customer_id, email, name, ref, subscription_id, description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (site_id, provider, transaction_id) DO UPDATE SET
              visitor_id = COALESCE(payments.visitor_id, excluded.visitor_id),
              first_session_id = COALESCE(payments.first_session_id, excluded.first_session_id),
              last_session_id = COALESCE(payments.last_session_id, excluded.last_session_id),
              touch_session_id = COALESCE(payments.touch_session_id, excluded.touch_session_id),
              customer_id = COALESCE(payments.customer_id, excluded.customer_id),
              email = COALESCE(payments.email, excluded.email),
              name = COALESCE(payments.name, excluded.name),
              ref = COALESCE(payments.ref, excluded.ref),
              subscription_id = COALESCE(payments.subscription_id, excluded.subscription_id),
              description = COALESCE(payments.description, excluded.description)`,
      params: [
        id,
        site.id,
        input.provider,
        input.transactionId.slice(0, 200),
        input.type,
        signed,
        currency,
        revenue,
        site.currency,
        ts,
        visitorId,
        sessions.first,
        sessions.last,
        sessions.touch,
        input.customerId?.slice(0, 200) ?? null,
        email,
        input.name?.slice(0, 200) ?? null,
        input.ref?.slice(0, 200) ?? null,
        input.subscriptionId?.slice(0, 200) ?? null,
        input.description?.slice(0, 300) ?? null,
        now,
      ],
    },
  ];

  if (input.customerId) {
    statements.push({
      sql: `INSERT INTO customers (site_id, provider, customer_id, visitor_id, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (site_id, provider, customer_id) DO UPDATE SET
              visitor_id = COALESCE(customers.visitor_id, excluded.visitor_id),
              email = COALESCE(customers.email, excluded.email),
              name = COALESCE(customers.name, excluded.name)`,
      params: [site.id, input.provider, input.customerId.slice(0, 200), visitorId, email, input.name ?? null, now],
    });
  }
  if (visitorId && (email || input.name)) {
    statements.push({
      sql: "UPDATE visitors SET email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE site_id = ? AND id = ?",
      params: [email, input.name ?? null, site.id, visitorId],
    });
  }
  if (existing && input.cumulative && Number(existing.amount) !== signed) {
    statements.push({
      sql: "UPDATE payments SET amount = ?, revenue = ?, ts = ? WHERE id = ?",
      params: [signed, revenue, ts, existing.id],
    });
  }
  await db.batch(statements);

  const payment = (await db.first<PaymentRow>("SELECT * FROM payments WHERE id = ?", [id])) as PaymentRow;
  return { payment, created: !existing };
}

/**
 * Called when the tracker learns something that links a visitor to a payment that
 * may already be stored (checkout session id on the success page, email, identify...).
 */
export async function attachVisitorToPayments(
  rt: Runtime,
  site: Site,
  link: { visitorId: string; sessionId?: string | null; ref?: string | null; email?: string | null; customerId?: string | null },
): Promise<number> {
  const db = rt.db;
  const conditions: string[] = [];
  const params: (string | null)[] = [site.id];
  if (link.ref) {
    conditions.push("ref = ?");
    params.push(link.ref);
  }
  if (link.email) {
    conditions.push("LOWER(email) = ?");
    params.push(link.email.toLowerCase());
  }
  if (link.customerId) {
    conditions.push("customer_id = ?");
    params.push(link.customerId);
  }
  if (!conditions.length) return 0;
  const rows = await db.all<PaymentRow>(
    `SELECT * FROM payments WHERE site_id = ? AND visitor_id IS NULL AND (${conditions.join(" OR ")}) LIMIT 100`,
    params,
  );
  for (const p of rows) {
    const s = await attributionSessions(db, site.id, link.visitorId, Number(p.ts), link.sessionId);
    await db.batch([
      {
        sql: `UPDATE payments SET visitor_id = ?, first_session_id = ?, last_session_id = ?, touch_session_id = ? WHERE id = ? AND visitor_id IS NULL`,
        params: [link.visitorId, s.first, s.last, s.touch, p.id],
      },
      ...(p.customer_id
        ? [
            {
              sql: "UPDATE customers SET visitor_id = COALESCE(visitor_id, ?) WHERE site_id = ? AND provider = ? AND customer_id = ?",
              params: [link.visitorId, site.id, p.provider, p.customer_id],
            },
          ]
        : []),
    ]);
  }
  return rows.length;
}

export async function deletePayment(db: Database, siteId: string, idOrTransaction: string): Promise<boolean> {
  const res = await db.run("DELETE FROM payments WHERE site_id = ? AND (id = ? OR transaction_id = ?)", [
    siteId,
    idOrTransaction,
    idOrTransaction,
  ]);
  return res.changes > 0;
}

/** Recomputes site-currency revenue for every payment (used when a site's currency changes). */
export async function recomputeRevenue(rt: Runtime, site: Site): Promise<void> {
  const rates = await getRates(rt.db);
  const rows = await rt.db.all<{ id: string; amount: number; currency: string }>(
    "SELECT id, amount, currency FROM payments WHERE site_id = ? AND revenue_currency <> ?",
    [site.id, site.currency],
  );
  const statements: Statement[] = rows.map((r) => ({
    sql: "UPDATE payments SET revenue = ?, revenue_currency = ? WHERE id = ?",
    params: [convertMinor(Number(r.amount), r.currency, site.currency, rates), site.currency, r.id],
  }));
  for (let i = 0; i < statements.length; i += 50) await rt.db.batch(statements.slice(i, i + 50));
}
