// OpenRev for mobile apps: the platform-agnostic client. index.js wires it to React Native; tests use it directly.

// The same as package.json (a test checks): React Native bundles can't read the package file at run time.
export const VERSION = "0.1.0";
const SESSION_TIMEOUT = 30 * 60_000;
/** A link can hand its visitor id to an install this young, as cross-domain links do for new browsers. */
const ADOPT_WINDOW = 24 * 3_600_000;
const KEYS = { visitor: "openrev:visitor", session: "openrev:session", optOut: "openrev:opt_out", referrer: "openrev:install_referrer" };
const CAMPAIGN_PARAMS = /^(utm_[a-z]+|ref|via|source|gclid|gbraid|wbraid|msclkid|fbclid|ttclid|li_fat_id|twclid|sccid|epik|rdt_cid)$/;
// Same as the server accepts.
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A random v4 UUID from the platform's secure random source. React Native has none built in: index.js loads
 * react-native-get-random-values, which provides crypto.getRandomValues.
 */
function uuid() {
  const c = globalThis.crypto;
  if (c.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function readJson(storage, key) {
  try {
    const raw = await storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeJson(storage, key, value) {
  try {
    const p = storage.setItem(key, JSON.stringify(value));
    if (p && p.catch) p.catch(() => {});
  } catch {
    /* storage unavailable */
  }
}

/** The query string of a URL or of an install referrer ("utm_source=x&_or_vid=…"), as a map. */
function queryOf(input) {
  const text = String(input || "");
  const q = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text.includes("=") ? text : "";
  const params = new URLSearchParams(q.split("#")[0]);
  const out = {};
  params.forEach((v, k) => (out[k] = v));
  return out;
}

/**
 * Creates a client.
 * - host: your OpenRev address; websiteId: the website's id; appId: the iOS bundle id or Android package name, listed
 *   in Settings → Tracking code → Mobile apps.
 * - storage: { getItem, setItem } (AsyncStorage); platform: { os, osVersion, device, screenWidth, language }.
 */
export function createClient(options) {
  const { host, websiteId, appVersion = null, storage, platform = {}, debug = false } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  if (!host || !websiteId || !options.appId) throw new Error("OpenRev: host, websiteId and appId are required");
  if (!storage) throw new Error("OpenRev: pass a storage with getItem and setItem");
  if (!globalThis.crypto?.randomUUID && !globalThis.crypto?.getRandomValues) {
    throw new Error("OpenRev: no secure random source for ids. In React Native, install react-native-get-random-values.");
  }
  const appId = String(options.appId).toLowerCase();
  // Trailing slashes are trimmed without a regular expression, which a long run of slashes would make slow.
  let base = String(host);
  while (base.endsWith("/")) base = base.slice(0, -1);
  const endpoint = `${base}/api/events`;
  const log = (...args) => debug && console.log("[OpenRev]", ...args);

  let visitor = null; // { id, createdAt }
  let session = null; // { id, last }
  let optedOut = false;
  let screen = "/";
  let campaign = null; // campaign params from the link that opened the app, for the next session's first screen
  let foregroundAt = now();
  const retry = [];

  const persistSession = () => writeJson(storage, KEYS.session, session);

  function applyLink(params, from) {
    const vid = params._or_vid || params._df_vid;
    if (vid && ID.test(vid) && visitor && vid !== visitor.id && now() - visitor.createdAt < ADOPT_WINDOW) {
      // The visitor from the website: the app continues their journey (funnels and first-touch revenue).
      visitor = { id: vid, createdAt: visitor.createdAt };
      writeJson(storage, KEYS.visitor, visitor);
      session = null;
      log(`visitor id from ${from}`, vid);
    }
    const found = Object.keys(params).filter((k) => CAMPAIGN_PARAMS.test(k));
    if (found.length) {
      campaign = Object.fromEntries(found.map((k) => [k, params[k]]));
      // A campaign starts a new visit, as landing on a website from one does.
      session = null;
    }
  }

  const ready = (async () => {
    visitor = await readJson(storage, KEYS.visitor);
    if (!visitor || !ID.test(visitor.id)) {
      visitor = { id: uuid(), createdAt: now() };
      writeJson(storage, KEYS.visitor, visitor);
    }
    session = await readJson(storage, KEYS.session);
    optedOut = (await readJson(storage, KEYS.optOut)) === true;
    // The link that opened the app comes before the first screen, so that screen already carries it.
    try {
      const url = await options.initialURL;
      if (url) applyLink(queryOf(url), "the opening link");
    } catch {
      /* no initial URL */
    }
  })();

  function sessionId() {
    const t = now();
    if (!session || !ID.test(session.id) || t - session.last > SESSION_TIMEOUT) session = { id: uuid(), last: t };
    else session.last = t;
    persistSession();
    return session.id;
  }

  async function post(payload) {
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": `openrev-react-native/${VERSION}` },
        body: JSON.stringify(payload),
      });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      if (body && body.ok === false) log("ignored by the server:", body.reason);
      return true;
    } catch (err) {
      log("send failed, will retry:", err?.message ?? err);
      return false;
    }
  }

  async function send(type, data = {}, path = screen) {
    await ready;
    if (optedOut) return;
    // Events that couldn't be sent go first, in order.
    while (retry.length) {
      if (!(await post(retry[0]))) break;
      retry.shift();
    }
    const sid = sessionId();
    let query = "";
    if (type === "pageview" && campaign) {
      query = `?${new URLSearchParams(campaign)}`;
      campaign = null;
    }
    const payload = {
      type,
      websiteId,
      href: `app://${appId}${path}${query}`,
      referrer: null,
      visitorId: visitor.id,
      sessionId: sid,
      screenWidth: platform.screenWidth,
      language: platform.language,
      app: { version: appVersion, os: platform.os, osVersion: platform.osVersion, device: platform.device === "tablet" ? "tablet" : "phone" },
      ...data,
    };
    log(type, payload.href, data.name ?? "");
    if (!(await post(payload)) && retry.length < 50) retry.push(payload);
  }

  return {
    ready,
    /** A screen view, like a pageview: "Home", "Settings/Billing" or "/pricing". */
    screen(name) {
      const path = String(name || "/").trim();
      screen = (path.startsWith("/") ? path : `/${path}`).slice(0, 300);
      return send("pageview");
    },
    /** A goal, with up to 10 properties. */
    track(name, props) {
      return send("goal", { name: String(name), props });
    },
    /** Attaches a user to this visitor: { user_id, email, name, image, ...props }. */
    identify(user = {}) {
      const { user_id, userId, email, name, image, ...rest } = user;
      return send("identify", { userId: user_id ?? userId, email, name, image, props: { ...rest, name, image } });
    },
    /** Tells OpenRev this visitor just paid with this email (or checkout ref), so the provider's payment can be matched. */
    payment(hint = {}) {
      return send("payment", { email: hint.email, ref: hint.ref ?? hint.transaction_id, provider: hint.provider });
    },
    /** A deep link (universal link, app link or custom scheme): its visitor id and campaign parameters. */
    async handleURL(url) {
      await ready;
      applyLink(queryOf(url), "a link");
    },
    /** The Play Store install referrer (Android), once per install. */
    async setInstallReferrer(referrer) {
      await ready;
      if (!referrer || (await readJson(storage, KEYS.referrer))) return;
      writeJson(storage, KEYS.referrer, true);
      applyLink(queryOf(decodeURIComponent(String(referrer))), "the install referrer");
    },
    /** Engaged time: call when the app goes to the background and comes back (index.js does it). */
    background() {
      const ms = now() - foregroundAt;
      if (ms > 1000 && session) send("engagement", { engagedMs: Math.min(ms, SESSION_TIMEOUT) });
    },
    foreground() {
      foregroundAt = now();
    },
    /** Stops (true) or resumes (false) tracking on this device. */
    async optOut(value = true) {
      await ready;
      optedOut = !!value;
      writeJson(storage, KEYS.optOut, optedOut);
    },
    /** The visitor id, to pass to your backend (Payments API, checkout metadata). */
    async visitorId() {
      await ready;
      return visitor.id;
    },
    async sessionId() {
      await ready;
      return sessionId();
    },
  };
}
