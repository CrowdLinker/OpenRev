import { creem } from "./creem";
import { custom } from "./custom";
import { dodo } from "./dodo";
import { gumroad } from "./gumroad";
import { lemonsqueezy } from "./lemonsqueezy";
import { paddle } from "./paddle";
import { paystack } from "./paystack";
import { polar } from "./polar";
import { razorpay } from "./razorpay";
import { shopify } from "./shopify";
import { stripe } from "./stripe";
import type { PaymentProvider } from "./types";
import { woocommerce } from "./woocommerce";

/**
 * Registry of payment providers. To add a provider, implement `PaymentProvider`
 * in its own file and add it to this list — see docs/revenue/custom-provider.md.
 */
export const PROVIDERS: PaymentProvider[] = [
  stripe,
  lemonsqueezy,
  paddle,
  polar,
  dodo,
  creem,
  shopify,
  woocommerce,
  gumroad,
  paystack,
  razorpay,
  custom,
];

export function getProvider(id: string): PaymentProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Public description of providers for the dashboard (no functions). */
export function providerCatalog() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    website: p.website,
    description: p.description,
    fields: p.fields,
    events: p.events,
    metadataHint: p.metadataHint ?? null,
    supportsImport: typeof p.importHistory === "function",
  }));
}
