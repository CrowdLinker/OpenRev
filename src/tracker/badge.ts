/**
 * OpenRev live badge: <openrev-badge share="TOKEN"></openrev-badge>
 *
 * Shows "● 3 online · 1,297 visitors today · stats →" and links to the site's public dashboard. Loads from the
 * OpenRev instance that serves this script, refreshes every minute, and stays hidden if the numbers can't be
 * loaded. Styles live in a shadow root, so the host page's CSS can't break the badge and vice versa.
 *
 * Attributes: share (required, the share link token), theme ("light" | "dark" | "auto", default "light"),
 * host (optional, the OpenRev URL when this script is served from somewhere else, such as a proxy).
 */
((w: Window, d: Document) => {
  if (!w.customElements || w.customElements.get("openrev-badge")) return;

  // Same rule as the tracker: read the script element through Document.prototype, because page markup such as
  // <img name="currentScript"> can shadow document.currentScript and pick where requests go.
  const proto = Document.prototype;
  const isScript = (el: unknown): el is HTMLScriptElement => el instanceof HTMLScriptElement;
  const current = Object.getOwnPropertyDescriptor(proto, "currentScript")?.get?.call(d) as unknown;
  const found = proto.querySelector.call(d, "script[src*='/js/badge']") as unknown;
  const script = isScript(current) ? current : isScript(found) ? found : null;
  // An empty value must stay empty: resolved against the page it would become the page's own origin.
  const httpOrigin = (url: string | null | undefined) => {
    if (!url) return null;
    try {
      const u = new URL(url, w.location.href);
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const scriptOrigin = httpOrigin(script && script.src);

  const CSS = `
:host{display:none;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;vertical-align:middle}
:host([data-ready]){display:inline-block}
a{--bg:#fff;--border:#e4e4e7;--text:#52525b;--strong:#16a34a;--link:#18181b;display:inline-flex;align-items:center;gap:6px;
 padding:7px 13px 7px 11px;border:1px solid var(--border);border-radius:999px;background:var(--bg);color:var(--text);
 text-decoration:none;white-space:nowrap;transition:border-color .15s,box-shadow .15s}
a:hover{border-color:#a1a1aa;box-shadow:0 1px 2px rgba(0,0,0,.06)}
a:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
:host([theme=dark]) a{--bg:#18181b;--border:#3f3f46;--text:#a1a1aa;--strong:#4ade80;--link:#fafafa}
@media (prefers-color-scheme:dark){:host([theme=auto]) a{--bg:#18181b;--border:#3f3f46;--text:#a1a1aa;--strong:#4ade80;--link:#fafafa}}
.dot{position:relative;width:8px;height:8px;margin-right:2px;border-radius:50%;background:#22c55e}
.dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;background:#22c55e;opacity:.35;animation:p 2s ease-out infinite}
@keyframes p{0%{transform:scale(.5);opacity:.45}100%{transform:scale(1.4);opacity:0}}
@media (prefers-reduced-motion:reduce){.dot::after{animation:none}}
.online{color:var(--strong);font-weight:600}
.stats{color:var(--link)}`;

  let sheet: CSSStyleSheet | null = null;
  const fmt = new Intl.NumberFormat();

  class OpenRevBadge extends HTMLElement {
    private timer = 0;
    private link: HTMLAnchorElement | null = null;

    connectedCallback() {
      const token = this.getAttribute("share") || "";
      const origin = httpOrigin(this.getAttribute("host")) || scriptOrigin;
      if (!/^[a-z0-9]{10,40}$/.test(token) || !origin) return;
      if (!this.link) this.build(origin, token);
      const load = () => {
        fetch(`${origin}/api/badge/${token}`, { credentials: "omit" })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { online: number; today: number } | null) => (data ? this.show(data) : this.removeAttribute("data-ready")))
          .catch(() => {});
      };
      load();
      this.timer = w.setInterval(load, 60_000);
    }

    disconnectedCallback() {
      w.clearInterval(this.timer);
    }

    private build(origin: string, token: string) {
      const root = this.attachShadow({ mode: "open" });
      // Constructable stylesheets aren't subject to the host page's style-src CSP; <style> is the fallback.
      if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
        if (!sheet) {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(CSS);
        }
        root.adoptedStyleSheets = [sheet];
      } else {
        const style = d.createElement("style");
        style.textContent = CSS;
        root.appendChild(style);
      }
      const a = d.createElement("a");
      a.href = `${origin}/share/${token}?period=today`;
      a.target = "_blank";
      a.rel = "noopener";
      a.setAttribute("part", "badge");
      for (const cls of ["dot", "online", "sep", "today", "sep", "stats"]) {
        const span = d.createElement("span");
        span.className = cls;
        if (cls === "sep") span.textContent = "·";
        if (cls === "stats") span.textContent = "stats →";
        if (cls === "dot" || cls === "sep") span.setAttribute("aria-hidden", "true");
        a.appendChild(span);
      }
      root.appendChild(a);
      this.link = a;
    }

    private show(data: { online: number; today: number }) {
      const a = this.link;
      if (!a) return;
      const online = `${fmt.format(Number(data.online) || 0)} online`;
      const today = `${fmt.format(Number(data.today) || 0)} ${Number(data.today) === 1 ? "visitor" : "visitors"} today`;
      (a.querySelector(".online") as HTMLElement).textContent = online;
      (a.querySelector(".today") as HTMLElement).textContent = today;
      a.setAttribute("aria-label", `${online}, ${today}. Open the public analytics dashboard.`);
      this.setAttribute("data-ready", "");
    }
  }

  w.customElements.define("openrev-badge", OpenRevBadge);
})(window, document);
