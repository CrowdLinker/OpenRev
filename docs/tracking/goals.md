# Goals

Goals are the actions you care about: signups, trial starts, demo requests, button clicks, a pricing section seen. OpenRev shows how many visitors complete each goal, which sources drive them, and how much revenue those visitors bring.

You can record a goal four ways:

- [From JavaScript](#javascript)
- [With HTML attributes](#html-attributes) (no code)
- [When an element scrolls into view](#scroll-goals)
- [From your server](#server-side-goals) with the REST API

## JavaScript

```js
window.openrev("signup");

// with custom properties
window.openrev("signup", { plan: "pro", billing: "yearly" });
```

If the call can run before the script has loaded (inline scripts in `<head>`, early framework code), add the queue snippet before the OpenRev script. Calls made before loading are then kept and sent once it's ready:

```html
<script>
  window.openrev = window.openrev || function () { (window.openrev.q = window.openrev.q || []).push(arguments); };
</script>
<script defer data-website-id="YOUR_WEBSITE_ID" data-domain="example.com" src="https://analytics.example.com/js/script.js"></script>
```

Without the queue snippet, guard the call so it doesn't throw when the script is blocked: `window.openrev?.("signup")`.

Example: a React form

```tsx
async function onSubmit(data: FormData) {
  await createAccount(data);
  window.openrev?.("signup", { plan: String(data.get("plan")) });
}
```

## HTML attributes

Add `data-openrev-goal` to any clickable element. Add properties with `data-openrev-goal-<key>`:

```html
<button data-openrev-goal="start_trial" data-openrev-goal-plan="pro">Start trial</button>

<a href="/demo" data-openrev-goal="book_demo" data-openrev-goal-button-location="hero">Book a demo</a>
```

The second example records `book_demo` with `{ "button_location": "hero" }` (dashes in the key become underscores).

- The goal fires on click, including clicks on child elements (an icon inside the button).
- It's sent with `navigator.sendBeacon`, so it isn't lost when the click navigates to another page.
- Put the attribute on the submit **button**, not on the `<form>`: any click inside an element with the attribute counts, so a form would fire on clicks into its fields.

## Scroll goals

Fire a goal when an element becomes visible:

```html
<section id="pricing" data-openrev-scroll="pricing_seen">…</section>

<!-- 80% of the element visible for at least 1 second, with a property -->
<div
  data-openrev-scroll="testimonials_read"
  data-openrev-scroll-threshold="0.8"
  data-openrev-scroll-delay="1000"
  data-openrev-scroll-variant="b"
>…</div>
```

| Attribute | Default | Meaning |
| --- | --- | --- |
| `data-openrev-scroll` | | Goal name |
| `data-openrev-scroll-threshold` | `0.5` | Fraction of the element that must be visible, from 0 to 1 |
| `data-openrev-scroll-delay` | `0` | Milliseconds it must stay visible. If it leaves the screen earlier, nothing is sent. |
| `data-openrev-scroll-<key>` | | Custom property |

- Each scroll goal fires at most once per page view. In single-page apps it can fire again after a route change.
- Elements added to the page later (lazy-loaded sections, client-rendered components) are picked up automatically.
- The threshold is a share of the **element's** area. An element more than twice as tall as the screen can never be 50% visible: use a low threshold such as `0.1`, or put the attribute on a smaller element like the section heading.

## Server-side goals

Record goals that happen on your backend (email verified, onboarding finished, a webhook from another tool) with `POST /api/v1/goals`. Create an API key in **Settings → API & MCP**.

```bash
curl -X POST "https://analytics.example.com/api/v1/goals" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "onboarding_completed",
    "openrev_visitor_id": "4f8c2a9e-1b7d-4c3e-9a51-2d6f0e8b7c11",
    "metadata": { "plan": "pro", "seats": 5 }
  }'
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Goal name (`goal` is accepted too). Same [naming rules](#naming-rules). |
| `openrev_visitor_id` | yes | The visitor id. `visitor_id`, `visitorId` and `datafast_visitor_id` are accepted too. |
| `metadata` | no | Properties (`props` or `properties` also work). Same [limits](#properties). |
| `timestamp` | no | Unix time in milliseconds. Defaults to now. |

Response: `201 {"status":"success","data":{"name":"onboarding_completed","visitor_id":"…"}}`. A missing or invalid key returns `401`, a bad name or visitor id `422`. Account-level API tokens also need `?websiteId=YOUR_WEBSITE_ID`. See the [API reference](../api/README.md).

**Where to get the visitor id:** read the `openrev_visitor_id` cookie in the request your backend receives (the cookie is first-party on your domain), or send `openrev.visitorId()` from the browser along with the form. Save it on the user record if the goal happens later.

The goal is attached to the visitor's most recent session, so it's credited to that session's source.

## Naming rules

Goal names may contain lowercase letters, numbers, `_`, `-` and `:`, up to 64 characters. OpenRev normalizes names instead of rejecting them:

- uppercase is lowercased: `Signup` → `signup`;
- spaces become underscores: `Start Trial` → `start_trial`;
- any other character is removed: `checkout.started!` → `checkoutstarted`;
- names are cut at 64 characters.

A name that ends up empty is rejected (`invalid_goal_name`). Prefer short verbs in `snake_case`: `signup`, `start_trial`, `book_demo`, `add_to_cart`. Use `:` to group related goals, such as `newsletter:subscribe` and `newsletter:confirm`.

## Properties

- Up to 10 properties per event. Extra ones are ignored.
- Keys: `camelCase` becomes `snake_case`, everything is lowercased, other characters become `_`, max 64 characters.
- Values are stored as strings (numbers and booleans are converted, objects are JSON-encoded), `<` and `>` are removed, max 255 characters. `null` and `undefined` values are skipped.

Don't put personal data (emails, names) in goal properties. Use [identify](identify.md) for that.

## Where goals show up

- **Dashboard → Goals**: visitors who completed each goal and, when revenue is enabled, the revenue they brought. Click a goal to see its completions, conversion rate, customers and a breakdown of its custom properties. From there you can filter the whole dashboard to visitors who completed it, or set it as your #1 KPI.
- **Visitors**: every goal appears in the visitor's journey, with its properties.
- **Realtime**: goals appear in the live feed.
- **Funnels**: goals can be funnel steps.
- **Settings → Alerts**: create a **Goal completed** alert to get notified on Slack, Discord, Telegram, email or a webhook.

## #1 KPI

Pick one goal as your main conversion metric. It's shown as a headline card next to revenue: the share of visitors who completed it (conversion rate), the number of visitors who did, and the change versus the previous period.

Set it in either place:

- **Dashboard → Goals**: click the goal, then **Set as #1 KPI**.
- **Settings → General → #1 KPI**.

## Funnels

The **Funnels** page shows how many visitors go from one step to the next, for example landing page → pricing → signup → payment.

- Up to 10 steps. Each step is a **Page**, a **Goal** or a **Payment** (the visitor paid).
- Page steps match the path with **equals**, **starts with** or **contains**.
- Goal steps match the goal name exactly. `*` works as a wildcard (`newsletter:*`).
- A visitor counts for a step only if they completed the previous step first, within the selected date range. Each step shows the visitors, drop-off, conversion rate and the revenue of those visitors.

## Reserved goals from payment providers

When a payment provider is connected, OpenRev records these goals automatically from its webhooks, as long as it can find the visitor:

| Goal | Meaning | Providers |
| --- | --- | --- |
| `free_trial` | A checkout started a subscription without charging (free trial) | Stripe, Polar |
| `trial_started` | A subscription entered a trial | Stripe, Lemon Squeezy, Paddle, Polar, Creem |
| `trial_converted` | A trial became a paid subscription | Stripe |
| `subscription_cancel_scheduled` | The customer canceled, effective at the end of the period | Stripe, Lemon Squeezy, Polar, Creem |
| `subscription_ended` | The subscription ended | Stripe, Lemon Squeezy, Paddle, Polar, Creem |

Don't use these names for your own goals. You can use them like any other goal: as funnel steps (`/pricing` → `trial_started` → Payment), as your #1 KPI, or in alerts. Setting up providers is covered in [Revenue](../revenue/README.md).
