# Security policy

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/CrowdLinker/OpenRev/security/advisories/new) rather than public issues. We aim to respond within a few days.

## Design notes

- Passwords are hashed with PBKDF2-SHA256; sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies. Mutating dashboard requests are rejected when their `Origin` doesn't match.
- Failed logins are limited per account (10 per 15 minutes) and per client address (20 per 15 minutes); past a limit, logins are refused with `429` until the 15 minutes are over. The address is `CF-Connecting-IP` on Workers; on Node it's the last `X-Forwarded-For` entry, which your reverse proxy appends, or the socket address with `TRUST_PROXY=false`. Counters are kept in memory, per process (per isolate on Workers).
- API keys are stored as SHA-256 hashes and shown once. They act with their creator's current role: a viewer's account token is read-only.
- Only owners can change or remove an owner, and a website always keeps at least one owner.
- Payment-provider credentials are encrypted with AES-GCM using `OPENREV_SECRET`.
- Every provider webhook is verified with the provider's signature scheme (or a secret URL token where the provider doesn't sign requests), with constant-time comparisons and replay windows.
- Alert destinations (Slack, Discord, webhooks) must be public `https://` URLs: localhost, internal hostnames and private, loopback or link-local addresses are refused when the alert is saved and before each delivery (Node also resolves the hostname). Redirects aren't followed and deliveries time out after 10 seconds.
- CSV exports prefix cells that start with `=`, `+`, `-` or `@` with an apostrophe, so spreadsheet apps don't run them as formulas.
- Visitor IP addresses are used for geolocation and exclusions but never stored. Cookieless mode hashes IP and user agent with a salt that rotates daily.
