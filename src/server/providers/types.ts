import type { NormalizedGoal, NormalizedPayment } from "../services/payments";

export interface ProviderField {
  key: string;
  label: string;
  type: "text" | "password" | "textarea" | "select";
  required?: boolean;
  placeholder?: string;
  /** Short help text shown under the field (plain text, may contain `code`). */
  help?: string;
  options?: { value: string; label: string }[];
  /** Secret values are encrypted at rest and never sent back to the browser. */
  secret?: boolean;
}

export interface WebhookRequest {
  /** Raw request body exactly as received (needed for signature verification). */
  rawBody: string;
  headers: Headers;
  url: URL;
  method: string;
}

export type ProviderConfig = Record<string, string | undefined>;

export interface ProviderResult {
  payments: NormalizedPayment[];
  /** Reserved goals such as `free_trial`, `trial_started`, `subscription_ended`. */
  goals?: NormalizedGoal[];
  /** Set when the event was valid but not relevant (shown in the integration log). */
  ignored?: string;
}

export interface ImportPage {
  payments: NormalizedPayment[];
  nextCursor: string | null;
}

export interface PaymentProvider {
  /** Stable identifier, also used in webhook URLs and the `payments.provider` column. */
  id: string;
  name: string;
  website: string;
  /** One-paragraph explanation shown in the dashboard. */
  description: string;
  /** Configuration fields rendered in the dashboard. */
  fields: ProviderField[];
  /** Webhook events the user must subscribe to in the provider dashboard. */
  events: string[];
  /** Metadata key(s) the developer should attach at checkout (shown in setup instructions). */
  metadataHint?: string;
  /** Returns true when the request is authentic. */
  verify(req: WebhookRequest, config: ProviderConfig): Promise<boolean>;
  /** Converts a webhook payload into normalized payments / goals. */
  parse(req: WebhookRequest, config: ProviderConfig): Promise<ProviderResult>;
  /** Optional: import historical payments with API credentials (paginated). */
  importHistory?(config: ProviderConfig, cursor: string | null): Promise<ImportPage>;
}
