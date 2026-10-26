import { VERSION } from "../context";

const rangeParams = [
  { name: "period", in: "query", schema: { type: "string", enum: ["today", "yesterday", "24h", "7d", "30d", "90d", "wtd", "mtd", "ytd", "12m", "all"] }, description: "Preset date range (default 7d)." },
  { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Custom range start (YYYY-MM-DD), use with `to`." },
  { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "Custom range end (inclusive)." },
  { name: "timezone", in: "query", schema: { type: "string" }, description: "IANA timezone, defaults to the website timezone." },
  { name: "filters", in: "query", schema: { type: "string" }, description: 'JSON array, e.g. [{"dim":"country","op":"is","values":["US"]}]. Ops: is, is_not, contains, not_contains.' },
  { name: "websiteId", in: "query", schema: { type: "string" }, description: "Required when using an account token (ort_...)." },
];

const ok = (description: string) => ({ 200: { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } } });

export function openApiSpec(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenRev API",
      version: VERSION,
      description:
        "Query analytics, visitors and revenue, and send server-side payments, goals and identities. Authenticate with `Authorization: Bearer <key>` using a website key (`or_...`) or an account token (`ort_...` + `websiteId`).",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Envelope: {
          type: "object",
          properties: { status: { type: "string", enum: ["success", "error"] }, data: {}, error: { type: "object", properties: { code: { type: "integer" }, message: { type: "string" } } } },
        },
        PaymentInput: {
          type: "object",
          required: ["amount", "currency", "transaction_id"],
          properties: {
            amount: { type: "number", description: "Amount in major units, e.g. 29.99" },
            currency: { type: "string", example: "USD" },
            transaction_id: { type: "string", description: "Unique id from your payment system (idempotency key)." },
            openrev_visitor_id: { type: "string", description: "Value of the openrev_visitor_id cookie. `visitor_id` and `datafast_visitor_id` are accepted too." },
            openrev_session_id: { type: "string" },
            email: { type: "string" },
            name: { type: "string" },
            customer_id: { type: "string" },
            renewal: { type: "boolean" },
            subscription_id: { type: "string", description: "Groups a subscription's payments (used for MRR)" },
            interval: { type: "string", description: "Billing interval: day, week, month or year (monthly, annually, quarterly… accepted)" },
            interval_count: { type: "integer", minimum: 1, description: "Intervals per payment, default 1; at most 3 years in all" },
            refunded: { type: "boolean" },
            timestamp: { type: "string", description: "ISO 8601 or unix timestamp; defaults to now." },
            description: { type: "string" },
            provider: { type: "string", description: "Label for the payment source (default `api`)." },
          },
        },
        GoalInput: {
          type: "object",
          required: ["name", "openrev_visitor_id"],
          properties: { name: { type: "string" }, openrev_visitor_id: { type: "string" }, metadata: { type: "object", additionalProperties: { type: "string" } } },
        },
        IdentifyInput: {
          type: "object",
          required: ["openrev_visitor_id", "user_id"],
          properties: { openrev_visitor_id: { type: "string" }, user_id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, image: { type: "string" } },
          additionalProperties: { type: "string" },
        },
      },
    },
    paths: {
      "/websites": { get: { summary: "List websites accessible with this key", responses: ok("Websites") } },
      "/analytics/overview": { get: { summary: "Visitors, revenue, conversion rate, bounce rate... with previous-period comparison", parameters: rangeParams, responses: ok("Overview metrics") } },
      "/analytics/timeseries": {
        get: {
          summary: "Metrics over time",
          parameters: [...rangeParams, { name: "interval", in: "query", schema: { type: "string", enum: ["hour", "day", "week", "month"] } }],
          responses: ok("Time series"),
        },
      },
      "/analytics/mrr": {
        get: {
          summary: "Monthly recurring revenue over time: MRR, ARR, subscribers, new/expansion/reactivation/contraction/churn MRR and churn rates",
          parameters: [...rangeParams, { name: "interval", in: "query", schema: { type: "string", enum: ["hour", "day", "week", "month"] } }],
          responses: ok("MRR report"),
        },
      },
      "/analytics/mrr/breakdown": {
        get: {
          summary: "Current MRR, new MRR and churned MRR by the channel, source, campaign or country that brought each subscription in",
          parameters: [...rangeParams, { name: "group", in: "query", schema: { type: "string", enum: ["channel", "source", "utm_campaign", "country"] } }],
          responses: ok("MRR by acquisition source"),
        },
      },
      "/analytics/realtime": { get: { summary: "Visitors online now, live sessions, recent events and payments", parameters: rangeParams.slice(-1), responses: ok("Realtime") } },
      "/analytics/breakdowns/{dimension}": {
        get: {
          summary: "Visitors and revenue broken down by a dimension",
          parameters: [
            {
              name: "dimension",
              in: "path",
              required: true,
              schema: {
                type: "string",
                enum: ["channel", "source", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "page", "entry_page", "exit_page", "hostname", "outbound", "country", "region", "city", "device", "browser", "os", "goal"],
              },
            },
            { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["visitors", "revenue", "conversion_rate", "completions"] } },
            ...rangeParams,
          ],
          responses: ok("Breakdown rows"),
        },
      },
      "/visitors": {
        get: {
          summary: "Visitors in the range (with identity, first source and revenue)",
          parameters: [...rangeParams, { name: "search", in: "query", schema: { type: "string" } }, { name: "customers", in: "query", schema: { type: "boolean" } }, { name: "goal", in: "query", schema: { type: "string" } }],
          responses: ok("Visitors"),
        },
      },
      "/visitors/{visitorId}": { get: { summary: "Visitor profile and full journey", parameters: [{ name: "visitorId", in: "path", required: true, schema: { type: "string" } }], responses: ok("Profile") } },
      "/payments": {
        get: { summary: "Payments in the range with attribution", parameters: rangeParams, responses: ok("Payments") },
        post: {
          summary: "Record a payment (any payment provider)",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PaymentInput" } } } },
          responses: { 201: { description: "Created" }, 200: { description: "Already recorded (idempotent)" } },
        },
      },
      "/payments/{id}": { delete: { summary: "Delete a payment by id or transaction id", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok("Deleted") } },
      "/goals": {
        get: { summary: "Goals with completions, conversion rate and revenue", parameters: rangeParams, responses: ok("Goals") },
        post: { summary: "Track a goal server-side", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GoalInput" } } } }, responses: { 201: { description: "Created" } } },
      },
      "/identify": { post: { summary: "Attach a user id, name, email and custom properties to a visitor", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/IdentifyInput" } } } }, responses: ok("Identified") } },
      "/funnels": { get: { summary: "List funnels", responses: ok("Funnels") } },
      "/funnels/{funnelId}": { get: { summary: "Funnel conversion results", parameters: [{ name: "funnelId", in: "path", required: true, schema: { type: "string" } }, ...rangeParams], responses: ok("Funnel results") } },
      "/ltv": { get: { summary: "Customer lifetime value by first-touch source", parameters: [...rangeParams, { name: "group", in: "query", schema: { type: "string", enum: ["source", "channel", "country", "utm_campaign"] } }], responses: ok("LTV") } },
    },
  };
}
