/** Goal/event names: lowercase letters, numbers, `_`, `-` and `:` (max 64 chars). DataFast-compatible. */
export function sanitizeGoalName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_:\-]/g, "")
    .slice(0, 64);
  return cleaned.length ? cleaned : null;
}

/** Custom properties: up to 10 keys (`[a-z0-9_-]`, 64 chars), string values up to 255 chars. */
export function sanitizeProps(props: unknown, maxKeys = 10): Record<string, string> | null {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(props as Record<string, unknown>)) {
    if (count >= maxKeys) break;
    const key = rawKey
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_\-]/g, "_")
      .slice(0, 64);
    if (!key || rawValue === undefined || rawValue === null) continue;
    const value = (typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue))
      .replace(/[<>]/g, "")
      .slice(0, 255);
    out[key] = value;
    count++;
  }
  return count ? out : null;
}

export function clampString(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

/**
 * Matches a path against a pattern supporting `*` (within one segment) and `**` (anything).
 * Runs in O(pattern × path) time: patterns are site settings and paths come from visitors, so a
 * backtracking regex could be made to stall the server.
 */
export function matchPath(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!pattern.includes("*")) return false;
  // `/blog/*` should also match nested paths like DataFast does.
  if (pattern.endsWith("/*") && path.startsWith(pattern.slice(0, -1))) return true;
  const tokens: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      tokens.push("**");
      while (pattern[i + 1] === "*") i++;
    } else tokens.push(pattern[i]);
  }
  // can[j]: the tokens seen so far can match path.slice(0, j)
  let can = new Array<boolean>(path.length + 1).fill(false);
  can[0] = true;
  for (const t of tokens) {
    const next = new Array<boolean>(path.length + 1).fill(false);
    if (t === "*" || t === "**") {
      for (let j = 0; j <= path.length; j++) next[j] = can[j] || (j > 0 && next[j - 1] && (t === "**" || path[j - 1] !== "/"));
    } else {
      for (let j = 1; j <= path.length; j++) next[j] = can[j - 1] && path[j - 1] === t;
    }
    can = next;
  }
  return can[path.length];
}

export function ipMatches(rule: string, ip: string): boolean {
  rule = rule.trim();
  if (!rule) return false;
  if (rule === ip) return true;
  if (rule.endsWith("*")) return ip.startsWith(rule.slice(0, -1));
  const cidr = rule.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (cidr && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const toInt = (a: string) => a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const bits = Number(cidr[2]);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(cidr[1]) & mask) === (toInt(ip) & mask);
  }
  return false;
}
