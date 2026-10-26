# Team, access & sharing

## Roles

| Role | Can |
|---|---|
| **Owner** | Everything, including deleting the website, resetting stats, granting the owner role and changing or removing other owners |
| **Admin** | Settings, revenue providers, API keys, alerts, funnels, notes, invite members |
| **Viewer** | View dashboards, realtime and visitors |

Owners always see revenue. Admins and viewers see it when they have **Can see revenue** (below).

Invite people from **Settings → Team**. You get an invitation link (valid 14 days, single-use, also emailed if email is configured), even when the person already has an account: account emails aren't verified, so only whoever opens the link joins. A link stops working when the person who created it is removed from the website, loses the admin role or has their account deleted. Accepting an invitation doesn't change the role of someone who is already a member: change roles in the members list. Only owners can change an owner's role or remove an owner, and the last owner can't be demoted, removed or leave. Instance admins (the first account, and anyone they promote in **Account → Instance administration**) can see every website and toggle public sign-ups.

## Who sees revenue

Each member has a **Can see revenue** toggle in **Settings → Team**. It's always on for owners, and it applies at once.
Only members who can see revenue themselves can change it for others: owners, and admins who have it. An admin without
it can't turn it on for anyone, themselves included, until someone who has it gives it to them. When you invite
someone, tick **Can see revenue** if they should see it: it's off by default, and only shown to members who have it.

A member without it gets no revenue anywhere: the dashboard, their account tokens (so the [CLI](../guides/cli.md)
and MCP), website keys they created, CSV exports (there's no payments export for them), visitor profiles and
[emailed alerts](alerts.md#email-and-can-see-revenue). The server leaves it out of every response, the same way as on
a share link that hides revenue (below), and the dashboard drops the Revenue and MRR tabs and the revenue cards and
columns. Revenue here means amounts, payments, customer counts, MRR, lifetime value, and the revenue estimated for
keywords, social posts and AI visits.

## Public dashboards

**Settings → General → Public dashboard** creates a read-only link (`/share/<token>`) showing the dashboard, realtime, revenue and funnels — handy for "open startup" pages or investors. Names, emails and individual visitor journeys are never exposed, and realtime and payment data leave out visitor, session, transaction, subscription and checkout ids. Disable the link at any time.

Turn on **Hide revenue on share links** (**Settings → General**) to share traffic without revenue. The link then
leaves out every revenue figure: revenue and refunds, revenue per visitor and customer counts in every report, MRR,
lifetime value, payments (in realtime too), funnel steps from the first payment on, and keyword, social and AI
revenue. It's removed on the server, and the page has no revenue cards, tabs or columns. The setting only applies to
share links: team members follow their own **Can see revenue**. The [live badge](live-badge.md) only shows visitor
counts, so it's the same either way.

With the link on, you can also embed a [live badge](live-badge.md) ("3 online · 1,297 visitors today · stats →") that links to it.

## API keys

Website keys (`or_…`) live in **Settings → API & MCP**; account tokens (`ort_…`) in **Account**. Keys act with their creator's role on each website: a viewer's account token can read data but can't send payments, goals or identities, or add notes over MCP. See the [API docs](../api/README.md).

Keys also follow their creator's **Can see revenue**: without it, the API and MCP leave revenue out, and turning it on
takes effect for the keys at once. Admins and owners can create website keys.
