# Security policy

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/CrowdLinker/OpenRev/security/advisories/new) rather than public issues. We aim to respond within a few days.

## Design notes

- Passwords are hashed with PBKDF2-SHA256; sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies. Mutating dashboard requests are rejected when their `Origin` doesn't match.
- Failed logins are limited per account (10 per 15 minutes) and per client address (20 per 15 minutes); past a limit, logins are refused with `429` until the 15 minutes are over. The address is `CF-Connecting-IP` on Workers. On Node it's the connection's address; only when the connection comes from a trusted proxy is the last `X-Forwarded-For` entry, which that proxy appends, used instead. By default any private or loopback peer is trusted; `TRUST_PROXY` can list the proxy addresses (IPs or IPv4 CIDRs) to trust instead, or be `false` to trust none. Counters are kept in memory, per process (per isolate on Workers).
- Changing an account's email requires the current password. Changing the password signs out every other session of that account. Wrong current passwords are limited to 10 per account per 15 minutes, then refused with `429`.
- API keys are stored as SHA-256 hashes and shown once. They act with their creator's current role: a viewer's account token is read-only.
- Only owners can change or remove an owner, and a website always keeps at least one owner.
- Invitations are single-use links, also for people who already have an account (account emails aren't verified). A link stops working when its creator is removed from the website, loses the admin role or is deleted.
- Payment-provider credentials are encrypted with AES-GCM using `OPENREV_SECRET`.
- Every provider webhook is verified with the provider's signature scheme (or a secret URL token where the provider doesn't sign requests), with constant-time comparisons and replay windows.
- Alert destinations (Slack, Discord, webhooks) must be public `https://` URLs: localhost, internal hostnames and private, loopback or link-local addresses are refused when the alert is saved and before each delivery. On Node the hostname is resolved when connecting and the request goes to the address that was checked, so DNS can't switch it to an internal one in between. Redirects aren't followed and deliveries time out after 10 seconds. Visitor-supplied text in Slack and Discord messages is escaped, and Discord mentions are disabled.
- Payment hints from the tracking script (`identify` or `openrev("payment")` with an email or checkout reference) are unauthenticated, so they only link unattributed payments from the last 2 hours, and an email alone never links the provider's customer record. When several visitors claim the same email and no earlier payment with it is linked, a payment matched only by that email stays unattributed.
- Public share links leave out names, emails and visitor, session, transaction, subscription and checkout ids.
- Request bodies are limited to 2 MB (32 KB for tracker events) before they're read.
- CSV exports prefix cells that start with `=`, `+`, `-` or `@` with an apostrophe, so spreadsheet apps don't run them as formulas.
- The setup wizard writes `.env` and `.openrev.json`, which can hold secrets and database credentials, with mode `0600`.
- Visitor IP addresses are used for geolocation and exclusions but never stored. Cookieless mode hashes IP and user agent with a salt that rotates daily.
