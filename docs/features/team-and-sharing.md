# Team, access & sharing

## Roles

| Role | Can |
|---|---|
| **Owner** | Everything, including deleting the website, resetting stats, granting the owner role and changing or removing other owners |
| **Admin** | Settings, revenue providers, API keys, alerts, funnels, notes, invite members |
| **Viewer** | View dashboards, realtime, visitors and revenue |

Invite people from **Settings → Team**. You get an invitation link (valid 14 days, single-use, also emailed if email is configured), even when the person already has an account: account emails aren't verified, so only whoever opens the link joins. A link stops working when the person who created it is removed from the website, loses the admin role or has their account deleted. Accepting an invitation doesn't change the role of someone who is already a member: change roles in the members list. Only owners can change an owner's role or remove an owner, and the last owner can't be demoted, removed or leave. Instance admins (the first account, and anyone they promote in **Account → Instance administration**) can see every website and toggle public sign-ups.

## Public dashboards

**Settings → General → Public dashboard** creates a read-only link (`/share/<token>`) showing the dashboard, realtime, revenue and funnels — handy for "open startup" pages or investors. Names, emails and individual visitor journeys are never exposed, and realtime and payment data leave out visitor, session, transaction, subscription and checkout ids. Disable the link at any time.

## API keys

Website keys (`or_…`) live in **Settings → API & MCP**; account tokens (`ort_…`) in **Account**. Keys act with their creator's role on each website: a viewer's account token can read data but can't send payments, goals or identities, or add notes over MCP. See the [API docs](../api/README.md).
