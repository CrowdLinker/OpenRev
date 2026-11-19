import { toMinor } from "../lib/currency";
import type { PaymentProvider } from "./types";
import { asObject, num, parseJson, pickSessionId, pickVisitorId, str, toMs, verifyHmacSignature } from "./util";

export const yolfi: PaymentProvider = {
  id: "yolfi",
  name: "Yolfi",
  website: "https://yolfi.com",
  description:
    "Confirmed one-time crypto payments. Revenue is the merchant receivable in USD after fees. Pass the visitor id in checkout metadata for attribution.",
  fields: [
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "password",
      required: true,
      secret: true,
      help: "The signing secret returned when creating or rotating this Yolfi webhook endpoint, not your organization API key.",
    },
  ],
  events: ["payment.confirmed"],
  metadataHint: "metadata: { openrev_visitor_id, openrev_session_id }",

  async verify(req, config) {
    return verifyHmacSignature({
      algorithm: "sha256",
      secret: config.webhookSecret,
      data: req.rawBody,
      signature: req.headers.get("X-Yolfi-Signature"),
      encoding: "base64",
    });
  },

  async parse(req) {
    const event = asObject(parseJson(req.rawBody));
    const data = asObject(event?.data);
    if (!event || !data) return { payments: [], ignored: "invalid payload" };
    if (event.type !== "payment.confirmed") return { payments: [], ignored: `unhandled event ${str(event.type) ?? "unknown"}` };
    if (event.livemode === false) return { payments: [], ignored: "sandbox payment" };
    // The native payload does not distinguish the first recurring charge from a renewal.
    if (data.paymentType !== "ONE_TIME" || str(data.subscriptionId)) {
      return { payments: [], ignored: "only one-time payments are supported" };
    }
    const invoiceId = str(data.invoiceId);
    const amountUsd = num(data.amountUsd);
    if (!invoiceId || amountUsd === null) return { payments: [], ignored: "missing invoice or USD amount" };
    const amount = toMinor(amountUsd, "USD");
    if (amount <= 0 || !Number.isSafeInteger(amount)) return { payments: [], ignored: "invalid USD amount" };
    const customer = asObject(data.customer);
    const metadata = asObject(data.metadata);
    return {
      payments: [
        {
          provider: "yolfi",
          transactionId: invoiceId,
          type: "new",
          amount,
          currency: "USD",
          timestamp: toMs(event.created) ?? toMs(data.updatedAt),
          visitorId: pickVisitorId(metadata),
          sessionId: pickSessionId(metadata),
          customerId: str(data.customerId) ?? str(customer?.clientReferenceId),
          email: str(customer?.email),
          name: str(customer?.name),
          ref: str(data.checkoutSessionId) ?? invoiceId,
        },
      ],
    };
  },
};
