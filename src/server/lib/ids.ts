const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function uuid(): string {
  return crypto.randomUUID();
}

/** Random lowercase alphanumeric id, e.g. for website ids and share tokens. */
export function randomId(length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Visitor and session ids sent by clients: uuid-like strings. */
export function isValidClientId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}
