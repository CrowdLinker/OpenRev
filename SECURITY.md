# Security policy

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/CrowdLinker/OpenRev/security/advisories/new) rather than public issues. We aim to respond within a few days.

## Design notes

- Passwords are hashed with PBKDF2-SHA256; sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies. Mutating dashboard requests are rejected when their `Origin` doesn't match.
- API keys are stored as SHA-256 hashes and shown once.
- Payment-provider credentials are encrypted with AES-GCM using `OPENREV_SECRET`.
- Every provider webhook is verified with the provider's signature scheme (or a secret URL token where the provider doesn't sign requests), with constant-time comparisons and replay windows.
- Visitor IP addresses are used for geolocation and exclusions but never stored. Cookieless mode hashes IP and user agent with a salt that rotates daily.
