/**
 * OpenRev tracking script.
 *
 *   <script defer data-website-id="YOUR_ID" data-domain="example.com" src="https://your-openrev/js/script.js"></script>
 *
 * Compatible with DataFast: `window.datafast(...)`, `data-fast-goal`, `data-fast-scroll`
 * and the `datafast_visitor_id` cookie are all understood, so switching is a one-line change.
 */

declare const __HASH_MODE__: boolean;
declare const __COOKIELESS__: boolean;
/** The consent build (script.consent.js): cookieless until the visitor consents. */
declare const __CONSENT__: boolean;

type Props = Record<string, unknown>;
type Fn = ((...args: unknown[]) => void) & { q?: unknown[][] };

interface Payload {
  type: string;
  websiteId: string;
  href: string;
  referrer?: string | null;
  visitorId?: string | null;
  sessionId?: string | null;
  screenWidth?: number;
  language?: string;
  hash?: boolean;
  [key: string]: unknown;
}

(function () {
  const w = window as unknown as Record<string, unknown> & Window;
  const d = document;
  const nav = navigator;
  const loc = location;

  if ((w as { __openrev_loaded?: boolean }).__openrev_loaded) return;
  (w as { __openrev_loaded?: boolean }).__openrev_loaded = true;

  // Page markup such as <img name="currentScript"> shadows document.currentScript and querySelector
  // (named properties override built-ins), so read both through Document.prototype and accept only a
  // real <script>: otherwise injected HTML could choose where events are sent.
  const proto = Document.prototype;
  const isScript = (el: unknown): el is HTMLScriptElement => el instanceof HTMLScriptElement;
  const current = Object.getOwnPropertyDescriptor(proto, "currentScript")?.get?.call(d) as unknown;
  const find = (selector: string) => {
    const el = proto.querySelector.call(d, selector) as unknown;
    return isScript(el) ? el : null;
  };
  const script: HTMLScriptElement | null =
    (isScript(current) ? current : null) || find("script[data-website-id][src*='script']") || find("script[data-website-id]");
  const attr = (name: string) => (script ? script.getAttribute("data-" + name) : null);
  const flag = (name: string) => attr(name) === "true";

  const websiteId = attr("website-id") || "";
  const rootDomain = (attr("domain") || "").replace(/^www\./, "");
  const allowedHostnames = (attr("allowed-hostnames") || "")
    .split(",")
    .map((h) => h.trim().replace(/^www\./, ""))
    .filter(Boolean);
  const src = script && script.src ? script.src : "";
  const hashMode = __HASH_MODE__ || flag("hash") || /\.hash\./.test(src);
  const alwaysCookieless = __COOKIELESS__ || flag("cookieless") || /\.cookieless\./.test(src);
  const disableConsole = flag("disable-console");
  const disablePayments = flag("disable-payments");
  const trackOutbound = attr("disable-outbound") !== "true";

  function log(...args: unknown[]) {
    if (!disableConsole && w.console) console.log("[OpenRev]", ...args);
  }

  function resolveApi(): string {
    const custom = attr("api-url") || attr("api");
    if (custom) {
      try {
        return new URL(custom, loc.href).href;
      } catch {
        /* fall through */
      }
    }
    try {
      return new URL(src).origin + "/api/events";
    } catch {
      return "/api/events";
    }
  }
  const api = resolveApi();

  // ---------------------------------------------------------------------------
  // Cookies & ids
  // ---------------------------------------------------------------------------
  const VISITOR_COOKIE = "openrev_visitor_id";
  const SESSION_COOKIE = "openrev_session_id";
  const CONSENT_COOKIE = "openrev_consent";
  const SESSION_TTL = 30 * 60;

  function cookieDomain(): string {
    const host = loc.hostname.replace(/^www\./, "");
    // Share cookies across subdomains of the root domain (not possible for single-label hosts like localhost).
    if (rootDomain && rootDomain.indexOf(".") > 0 && (host === rootDomain || host.endsWith("." + rootDomain))) return "; domain=." + rootDomain;
    return "";
  }
  function getCookie(name: string): string | null {
    const m = d.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name: string, value: string, maxAge: number) {
    const base = name + "=" + encodeURIComponent(value) + "; max-age=" + maxAge + "; path=/; SameSite=Lax" + (loc.protocol === "https:" ? "; Secure" : "");
    const domain = cookieDomain();
    d.cookie = base + domain;
    // Fall back to a host-only cookie if the browser rejected the domain cookie.
    if (domain && getCookie(name) !== value) d.cookie = base;
  }
  // The consent build stays cookieless until openrev("consent", true), or, with data-consent="google", until Google
  // Consent Mode grants analytics_storage. Until then it doesn't read or write any cookie but its own consent flag.
  let cookieless = __CONSENT__ ? alwaysCookieless || getCookie(CONSENT_COOKIE) !== "1" : alwaysCookieless;

  // In-memory ids keep events of this page consistent even if cookies are blocked.
  const mem: { v: string | null; s: string | null } = { v: null, s: null };
  function uuid(): string {
    if (w.crypto && (crypto as Crypto).randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  const validId = (id: string | null) => !!id && /^[A-Za-z0-9_-]{8,64}$/.test(id);

  // Cross-domain ids passed in the URL (_or_vid/_or_sid, or DataFast's _df_vid/_df_sid)
  (function readCrossDomainParams() {
    try {
      const url = new URL(loc.href);
      const vid = url.searchParams.get("_or_vid") || url.searchParams.get("_df_vid");
      const sid = url.searchParams.get("_or_sid") || url.searchParams.get("_df_sid");
      if (!vid && !sid) return;
      if (!cookieless) {
        // Only adopt ids for a browser we haven't seen yet, so a crafted link can't swap a known
        // visitor onto someone else's existing profile.
        if (validId(vid) && !getCookie(VISITOR_COOKIE)) {
          setCookie(VISITOR_COOKIE, vid!, 31536000);
          if (validId(sid)) setCookie(SESSION_COOKIE, sid!, SESSION_TTL);
        }
      } else if (validId(sid)) {
        sessionStorage.setItem(SESSION_COOKIE, sid!);
        sessionStorage.setItem(SESSION_COOKIE + "_t", String(Date.now()));
      }
      ["_or_vid", "_or_sid", "_df_vid", "_df_sid"].forEach((p) => url.searchParams.delete(p));
      history.replaceState(history.state, "", url.toString());
    } catch {
      /* ignore */
    }
  })();

  function visitorId(): string | null {
    if (cookieless) return null;
    let id = getCookie(VISITOR_COOKIE) || getCookie("datafast_visitor_id") || mem.v;
    if (!validId(id)) id = uuid();
    mem.v = id;
    setCookie(VISITOR_COOKIE, id!, 31536000);
    return id;
  }
  function sessionId(): string {
    let id: string | null;
    if (cookieless) {
      try {
        id = sessionStorage.getItem(SESSION_COOKIE);
        const last = Number(sessionStorage.getItem(SESSION_COOKIE + "_t") || 0);
        if (!validId(id) || Date.now() - last > SESSION_TTL * 1000) id = uuid();
        sessionStorage.setItem(SESSION_COOKIE, id!);
        sessionStorage.setItem(SESSION_COOKIE + "_t", String(Date.now()));
      } catch {
        id = uuid();
      }
      return id!;
    }
    id = getCookie(SESSION_COOKIE) || getCookie("datafast_session_id") || mem.s;
    if (!validId(id)) id = uuid();
    mem.s = id;
    setCookie(SESSION_COOKIE, id!, SESSION_TTL);
    return id!;
  }

  // ---------------------------------------------------------------------------
  // Should we track at all?
  // ---------------------------------------------------------------------------
  function ignoreReason(): string | null {
    if (!websiteId) return "missing data-website-id";
    try {
      if (localStorage.getItem("openrev_ignore") === "true" || localStorage.getItem("datafast_ignore") === "true")
        return "localStorage.openrev_ignore is set";
    } catch {
      /* storage blocked */
    }
    const ua = nav.userAgent || "";
    if ((nav as Navigator & { webdriver?: boolean }).webdriver || /headless|phantom|selenium|puppeteer|playwright|\bbot\b|bot\/|crawl|spider/i.test(ua) || w._phantom || w.__nightmare)
      return "bot detected";
    if (/^localhost$|^127(\.\d+){3}$|^\[::1\]$|\.localhost$/.test(loc.hostname) && !flag("allow-localhost")) return "localhost (set data-allow-localhost=\"true\")";
    if (loc.protocol === "file:" && !flag("allow-file-protocol")) return "file:// protocol";
    try {
      if (w !== w.parent && !flag("debug")) return "inside an iframe (set data-debug=\"true\")";
    } catch {
      /* cross-origin parent */
    }
    return null;
  }
  const ignored = ignoreReason();

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  function send(type: string, data: Props = {}, beacon = false) {
    if (ignored) {
      log("Ignoring event (" + ignored + "):", type);
      return;
    }
    const payload: Payload = {
      type,
      websiteId,
      href: loc.href,
      referrer: d.referrer || null,
      visitorId: visitorId(),
      sessionId: sessionId(),
      screenWidth: w.screen ? screen.width : undefined,
      language: nav.language,
      hash: hashMode || undefined,
      ...data,
    };
    const body = JSON.stringify(payload);
    try {
      if (beacon && nav.sendBeacon) {
        nav.sendBeacon(api, new Blob([body], { type: "text/plain" }));
        return;
      }
      fetch(api, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Pageviews + engagement
  // ---------------------------------------------------------------------------
  let lastPage: string | null = null;
  let visibleSince = d.visibilityState === "visible" ? Date.now() : 0;
  let engaged = 0;

  function flushEngagement() {
    if (visibleSince) {
      engaged += Date.now() - visibleSince;
      visibleSince = d.visibilityState === "visible" ? Date.now() : 0;
    }
    if (engaged > 1000 && lastPage) send("engagement", { engagedMs: engaged }, true);
    engaged = 0;
  }

  function currentPage() {
    return loc.pathname + (hashMode ? loc.hash : "");
  }

  function pageview() {
    const page = currentPage();
    if (page === lastPage) return;
    if (lastPage) flushEngagement();
    lastPage = page;
    visibleSince = d.visibilityState === "visible" ? Date.now() : 0;
    fired.clear();
    send("pageview");
    scanScrollTargets();
    if (!disablePayments) detectPaymentReturn();
  }

  const hist = history;
  ["pushState", "replaceState"].forEach((m) => {
    const orig = (hist as unknown as Record<string, (...a: unknown[]) => unknown>)[m];
    (hist as unknown as Record<string, unknown>)[m] = function (this: History, ...args: unknown[]) {
      const res = orig.apply(this, args);
      setTimeout(pageview, 0);
      return res;
    };
  });
  w.addEventListener("popstate", () => setTimeout(pageview, 0));
  if (hashMode) w.addEventListener("hashchange", pageview);

  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "hidden") {
      flushEngagement();
    } else {
      visibleSince = Date.now();
    }
  });
  w.addEventListener("pagehide", flushEngagement);

  // ---------------------------------------------------------------------------
  // Goals via data attributes, outbound links, cross-domain & payment link tagging
  // ---------------------------------------------------------------------------
  function dataProps(el: Element, prefixes: string[]): Props | undefined {
    const props: Props = {};
    let n = 0;
    for (const a of Array.from(el.attributes)) {
      for (const p of prefixes) {
        if (a.name.indexOf(p) === 0 && a.name.length > p.length) {
          const key = a.name.slice(p.length).replace(/-/g, "_");
          if (key === "threshold" || key === "delay") continue;
          props[key] = a.value;
          n++;
        }
      }
    }
    return n ? props : undefined;
  }

  function isOwnHost(host: string): boolean {
    const h = host.replace(/^www\./, "");
    const own = [loc.hostname.replace(/^www\./, ""), rootDomain].filter(Boolean);
    return own.some((o) => h === o || h.endsWith("." + o));
  }
  function isAllowedCrossDomain(host: string): boolean {
    const h = host.replace(/^www\./, "");
    return allowedHostnames.some((a) => h === a || h.endsWith("." + a));
  }

  function decorateLink(a: HTMLAnchorElement) {
    let url: URL;
    try {
      url = new URL(a.href, loc.href);
    } catch {
      return;
    }
    const vid = visitorId();
    const sid = sessionId();
    let changed = false;
    if (isAllowedCrossDomain(url.hostname) && !isOwnHost(url.hostname)) {
      if (vid) url.searchParams.set("_or_vid", vid);
      url.searchParams.set("_or_sid", sid);
      changed = true;
    }
    if (!disablePayments && vid) {
      const host = url.hostname;
      if (/(^|\.)buy\.stripe\.com$/.test(host) && !url.searchParams.has("client_reference_id")) {
        url.searchParams.set("client_reference_id", vid);
        changed = true;
      } else if ((/lemonsqueezy\.com$/.test(host) || (!isOwnHost(host) && /^\/checkout\/buy\//.test(url.pathname))) && /\/checkout/.test(url.pathname) && !url.searchParams.has("checkout[custom][openrev_visitor_id]")) {
        url.searchParams.set("checkout[custom][openrev_visitor_id]", vid);
        url.searchParams.set("checkout[custom][openrev_session_id]", sid);
        changed = true;
      } else if ((/(^|\.)gumroad\.com$/.test(host) || host === "gum.co") && !url.searchParams.has("openrev_visitor_id")) {
        url.searchParams.set("openrev_visitor_id", vid);
        changed = true;
      }
    }
    if (changed) a.href = url.toString();
  }

  function onClick(e: Event) {
    const target = e.target as Element | null;
    if (!target || !target.closest) return;
    const goalEl = target.closest("[data-openrev-goal],[data-fast-goal]");
    if (goalEl && e.type === "click") {
      const name = goalEl.getAttribute("data-openrev-goal") || goalEl.getAttribute("data-fast-goal");
      if (name) track(name, dataProps(goalEl, ["data-openrev-goal-", "data-fast-goal-"]), true);
    }
    const a = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    decorateLink(a);
    const middleClick = e.type === "auxclick" && (e as MouseEvent).button === 1;
    if ((e.type === "click" || middleClick) && trackOutbound) {
      try {
        const url = new URL(a.href, loc.href);
        if (/^https?:$/.test(url.protocol) && !isOwnHost(url.hostname) && !isAllowedCrossDomain(url.hostname)) {
          send("outbound", { url: url.origin + url.pathname }, true);
        }
      } catch {
        /* ignore */
      }
    }
  }
  d.addEventListener("mousedown", onClick, true);
  d.addEventListener("touchstart", onClick, { capture: true, passive: true });
  d.addEventListener("click", onClick, true);
  d.addEventListener("auxclick", onClick, true);

  // ---------------------------------------------------------------------------
  // Scroll goals (data-openrev-scroll / data-fast-scroll)
  // ---------------------------------------------------------------------------
  const observed = new WeakSet<Element>();
  let observer: IntersectionObserver | null = null;
  const fired = new Set<string>();
  function scanScrollTargets() {
    if (!("IntersectionObserver" in w)) return;
    const els = d.querySelectorAll("[data-openrev-scroll],[data-fast-scroll]");
    els.forEach((el) => {
      if (observed.has(el)) return;
      observed.add(el);
      const threshold = Number(el.getAttribute("data-openrev-scroll-threshold") || el.getAttribute("data-fast-scroll-threshold") || 0.5);
      const delay = Number(el.getAttribute("data-openrev-scroll-delay") || el.getAttribute("data-fast-scroll-delay") || 0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const name = el.getAttribute("data-openrev-scroll") || el.getAttribute("data-fast-scroll");
            if (!name) return;
            if (entry.isIntersecting) {
              timer = setTimeout(() => {
                const key = lastPage + "|" + name;
                if (fired.has(key)) return;
                fired.add(key);
                track(name, dataProps(el, ["data-openrev-scroll-", "data-fast-scroll-"]));
              }, delay);
            } else if (timer) {
              clearTimeout(timer);
            }
          });
        },
        { threshold: Math.min(1, Math.max(0, threshold)) },
      );
      io.observe(el);
      observer = io;
    });
  }
  if ("MutationObserver" in w) {
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        scanScrollTargets();
      }, 500);
    }).observe(d.documentElement, { childList: true, subtree: true });
  }
  void observer;

  // ---------------------------------------------------------------------------
  // Payment detection on checkout success pages
  // ---------------------------------------------------------------------------
  function detectPaymentReturn() {
    try {
      const p = new URL(loc.href).searchParams;
      const stripe = p.get("session_id");
      if (stripe && /^cs_/.test(stripe)) send("payment", { provider: "stripe", ref: stripe });
      const checkout = p.get("checkout_id");
      if (checkout) send("payment", { provider: "auto", ref: checkout });
      const payment = p.get("payment_id");
      if (payment && /succeeded|success|paid/i.test(p.get("status") || "")) send("payment", { provider: "dodo", ref: payment });
    } catch {
      /* ignore */
    }
  }

  // Shopify storefronts: attach the visitor id to the cart so orders can be attributed.
  function shopify() {
    const shop = (w as { Shopify?: { shop?: string } }).Shopify;
    if (!shop || !shop.shop || disablePayments || ignored) return;
    const vid = visitorId();
    if (!vid) return;
    try {
      if (sessionStorage.getItem("openrev_cart") === vid) return;
      fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: { openrev_visitor_id: vid, openrev_session_id: sessionId() } }),
      }).then(() => sessionStorage.setItem("openrev_cart", vid)).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Consent mode (consent build only)
  // ---------------------------------------------------------------------------
  const setConsent = __CONSENT__
    ? (granted: boolean) => {
        if (alwaysCookieless || granted === !cookieless) return;
        if (granted) {
          // Keep the visit going: the cookieless session becomes the cookie session, and the server moves it to the new
          // visitor id sent with the consent event.
          const sid = sessionId();
          cookieless = false;
          setCookie(CONSENT_COOKIE, "1", 31536000);
          mem.s = sid;
          setCookie(SESSION_COOKIE, sid, SESSION_TTL);
          send("consent");
          log("Consent given: using cookies");
        } else {
          [VISITOR_COOKIE, SESSION_COOKIE, CONSENT_COOKIE].forEach((name) => setCookie(name, "", 0));
          mem.v = mem.s = null;
          cookieless = true;
          log("Consent withdrawn: cookies removed, cookieless from now on");
        }
      }
    : null;

  // Google Consent Mode: gtag("consent", "default" | "update", { analytics_storage }) pushes onto dataLayer. Updates
  // apply both ways; a "default" can only grant, so a denied default at page load can't wipe the cookies of a visitor
  // who consented on an earlier visit (their banner sends an update right after).
  const watchGoogleConsent = __CONSENT__
    ? () => {
        const dl = ((w as { dataLayer?: unknown[] }).dataLayer = (w as { dataLayer?: unknown[] }).dataLayer || []);
        const check = (item: unknown) => {
          const a = item as ArrayLike<unknown> | null;
          if (!a || typeof a !== "object" || a[0] !== "consent") return;
          const state = ((a[2] || {}) as { analytics_storage?: string }).analytics_storage;
          if (state === "granted") setConsent!(true);
          else if (state === "denied" && a[1] === "update") setConsent!(false);
        };
        for (let i = 0; i < dl.length; i++) check(dl[i]);
        const push = dl.push;
        dl.push = function (...items: unknown[]) {
          items.forEach(check);
          return push.apply(this, items);
        };
      }
    : null;

  // ---------------------------------------------------------------------------
  // Public API: openrev("goal_name", {props}) / openrev("identify", {...}) / openrev("payment", {email})
  // ---------------------------------------------------------------------------
  function track(name: string, props?: Props, beacon = false) {
    send("goal", { name, props }, beacon);
  }

  function call(...args: unknown[]) {
    const [cmd, data] = args as [string, Props | undefined];
    if (typeof cmd !== "string") return;
    if (cmd === "identify") {
      const p = { ...(data || {}) } as Props;
      const { user_id, userId, email, name, image, ...rest } = p as Record<string, unknown>;
      send("identify", { userId: user_id ?? userId, email, name, image, props: { ...rest, name, image } });
    } else if (cmd === "payment") {
      send("payment", { email: data && data.email, ref: data && (data.ref || data.transaction_id), provider: data && data.provider });
    } else if (cmd === "pageview") {
      lastPage = null;
      pageview();
    } else if (cmd === "consent") {
      // openrev("consent", true | false | "granted" | "denied"); ignored outside the consent build.
      if (__CONSENT__) setConsent!((data as unknown) === true || (data as unknown) === "granted");
    } else {
      track(cmd, data);
    }
  }

  const api$ = call as Fn & {
    visitorId?: () => string | null;
    sessionId?: () => string;
    getVisitorId?: () => string | null;
    getSessionId?: () => string;
  };
  api$.visitorId = api$.getVisitorId = visitorId;
  api$.sessionId = api$.getSessionId = sessionId;

  const queued: unknown[][] = [];
  ["openrev", "datafast"].forEach((k) => {
    const existing = w[k] as Fn | undefined;
    if (existing && existing.q) queued.push(...existing.q);
  });
  w.openrev = api$;
  if (!w.datafast || (w.datafast as Fn).q) w.datafast = api$;

  if (ignored) log("Tracking disabled: " + ignored);

  if (__CONSENT__) {
    // Consent given before the script loaded applies before the first pageview.
    for (const args of queued) if (args[0] === "consent") call(...(Array.from(args as ArrayLike<unknown>)));
    if ((attr("consent") || "").toLowerCase() === "google") watchGoogleConsent!();
  }
  pageview();
  shopify();
  for (const args of queued) if (!__CONSENT__ || args[0] !== "consent") call(...(Array.from(args as ArrayLike<unknown>)));
})();
