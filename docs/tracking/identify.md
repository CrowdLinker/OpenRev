# Identify users

By default a visitor is an anonymous id. When someone signs up or logs in, call `identify` to attach who they are. You get:

- names, emails and avatars in **Visitors**, journeys and **Realtime**;
- one profile per user across devices (visitors with the same `user_id` are merged);
- better revenue attribution: payments that only carry the customer's email can be matched to the visitor.

## From the browser

Call it after signup or login, and on page loads while the user is logged in (calling it again is harmless).

```js
window.openrev("identify", {
  user_id: "usr_123",
  email: "jane@example.com",
  name: "Jane Doe",
  image: "https://example.com/avatars/jane.png",
  // anything else is stored as a custom property
  plan: "pro",
  company: "Acme",
});
```

| Field | Notes |
| --- | --- |
| `user_id` | Your internal user id (`userId` also works). Up to 200 characters. Used to merge devices. |
| `email` | Must be a valid email. If `user_id` is an email address, it's used as the email too. |
| `name` | Shown instead of the random visitor name. Up to 200 characters. |
| `image` | Avatar URL. Must start with `https://`, up to 250 characters; other values are ignored. |
| anything else | Custom properties, shown under **Properties** in the profile. Up to 10, same [limits as goal properties](goals.md#properties). New values overwrite old ones; properties you don't send are kept. |

Either `user_id` or `email` is required. If you call `identify` before the script has loaded, add the [queue snippet](script-reference.md#calling-the-api-before-the-script-loads).

Example: Next.js client component

```tsx
"use client";
import { useEffect } from "react";

export function IdentifyUser({ user }: { user: { id: string; email: string; name: string } | null }) {
  useEffect(() => {
    if (user) window.openrev?.("identify", { user_id: user.id, email: user.email, name: user.name });
  }, [user]);
  return null;
}
```

## From your server

Use `POST /api/v1/identify` when the browser isn't involved, for example after email verification or from a webhook. Create an API key in **Settings → API & MCP** (an account token only works for websites where you're an admin).

```bash
curl -X POST "https://analytics.example.com/api/v1/identify" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "openrev_visitor_id": "4f8c2a9e-1b7d-4c3e-9a51-2d6f0e8b7c11",
    "user_id": "usr_123",
    "email": "jane@example.com",
    "name": "Jane Doe",
    "plan": "pro"
  }'
```

- `openrev_visitor_id` is required (`visitor_id`, `visitorId` and `datafast_visitor_id` are accepted). Read it from the `openrev_visitor_id` cookie on the request, or store it on the user at signup. In [cookieless mode](privacy-and-cookies.md#cookieless-mode) there is no visitor id to read (OpenRev derives it on its side and never gives it to the browser), so server-side identify needs cookie mode; use the browser call instead.
- `user_id`, `email`, `name` and `image` work as in the browser. Every other field becomes a custom property.
- Response: `{"status":"success","data":{"visitor_id":"…"}}`.

Server-side identify only updates the visitor's profile — it never creates a visit, so it doesn't change visitor or session counts. It works even before the visitor's first tracked pageview. Prefer the browser call when you can: it's tied to the visitor's current session automatically. See the [API reference](../api/README.md) for authentication details.

## Profiles and journeys

Open **Visitors** and click someone to see their profile:

- **First touch**: the source, campaign and landing page of their first visit.
- **Properties**: the custom properties you sent.
- **Journey**: every session with its source, the pages viewed, goals completed and payments, in order.

Search the visitor list by name, email or user id, and use **Customers only** to list paying visitors.

### Cross-device profiles

Each browser or device has its own visitor id. When two visitor ids are identified with the same `user_id`, the profile shows them together: sessions, events and payments from all of them (up to 20 linked visitors).

The merge applies to the profile view. Dashboard visitor counts still count each device, and a payment is credited to the sessions of the visitor it's linked to.

## How identify helps revenue attribution

A payment is attributed when OpenRev knows which visitor made it. It looks, in order, for:

1. a visitor id in the checkout metadata (`openrev_visitor_id`, or a tagged Payment Link);
2. a checkout reference recorded on the success page (for example Stripe's `session_id=cs_…`);
3. the original payment, for refunds and renewals;
4. a known customer id from an earlier payment;
5. the customer's **email**: the visitor of an earlier payment with that email, otherwise the visitor identified with that email (or with that email as `user_id`). If several visitors were identified with it, for example on two devices, the payment stays unattributed rather than guessing.

`identify` with an email powers step 5:

- **Payments that arrive later** with only an email (common with Payment Links, invoices, some providers' webhooks) are matched to the identified visitor.
- **Payments that already arrived** without a visitor and with the same email are linked as soon as you identify. From the browser, only payments from the last 2 hours are linked, and the provider's customer isn't tied to the visitor, since anyone can call `identify` with any email; [server-side identify](#from-your-server) links older payments too. Their attribution is computed from the visitor's sessions that started before the payment.

If you don't want to identify users, `openrev("payment", { email })` on your thank-you page does the same matching for one purchase (with the same 2-hour limit for payments already received). Passing the visitor id in the checkout metadata is still the most reliable method; see [Revenue](../revenue/README.md).

## Privacy

Names, emails and custom properties are personal data. Only send what you need, cover it in your privacy policy, and don't identify users who haven't agreed where consent is required. Public share links hide names and emails. More in [Privacy & cookies](privacy-and-cookies.md).
