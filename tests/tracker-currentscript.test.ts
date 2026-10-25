// Regression test: the tracker must take its configuration only from its own <script> element.
// In browsers `document` has [LegacyOverrideBuiltIns], so host-page markup such as an <img> whose
// name attribute is "currentScript" becomes an own property of `document` that shadows the
// Document.prototype.currentScript getter. The fake DOM below models exactly that: the prototype
// getter returns the real tracker <script>, and an own property on the document instance returns
// an injected non-script element.
import { buildSync } from "esbuild";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const PAGE = "https://customer.example/account?order=dummy-123#frag";
const TRACKER_SRC = "https://openrev.example/js/script.js";
const OTHER = "https://collector.invalid";

const trackerCode = buildSync({
  entryPoints: ["src/tracker/script.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: ["es2017"],
  define: { __HASH_MODE__: "false", __COOKIELESS__: "false" },
}).outputFiles[0].text;

class FakeElement {
  constructor(
    public tagName: string,
    private attrs: Record<string, string>,
  ) {}
  getAttribute(n: string) {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }
  get src() {
    return this.attrs.src ? new URL(this.attrs.src, PAGE).href : "";
  }
}
class HTMLScriptElement extends FakeElement {}
class HTMLImageElement extends FakeElement {}

function run(injected: Record<string, string> | null) {
  const realScript = new HTMLScriptElement("SCRIPT", { src: TRACKER_SRC, "data-website-id": "site-real", "data-domain": "customer.example" });
  const jar = new Map<string, string>();
  class Document {
    get currentScript() {
      return realScript;
    }
    get cookie() {
      return Array.from(jar, ([k, v]) => k + "=" + v).join("; ");
    }
    set cookie(v: string) {
      const [kv] = v.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    referrer = "";
    visibilityState = "visible";
    documentElement = {};
    querySelector(sel: string) {
      return sel.startsWith("script") ? realScript : null;
    }
    querySelectorAll() {
      return [];
    }
    addEventListener() {}
  }
  const doc = new Document();
  if (injected) {
    // Named property of `document` (LegacyOverrideBuiltIns): an own property shadowing the prototype getter.
    Object.defineProperty(doc, "currentScript", { value: new HTMLImageElement("IMG", injected), enumerable: true, configurable: true });
  }
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const queue = Object.assign(function () {}, {
    q: [["identify", { user_id: "dummy-user-1", email: "dummy@example.test", name: "Dummy Visitor" }]],
  });
  const g: Record<string, unknown> = {
    document: doc,
    Document,
    HTMLScriptElement,
    location: new URL(PAGE),
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36", language: "en", webdriver: false, sendBeacon: () => true },
    history: { state: null, pushState() {}, replaceState() {} },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null, setItem() {} },
    screen: { width: 1280 },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    fetch: (url: string, init: { body: string }) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return Promise.resolve();
    },
    console: { log() {} },
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    addEventListener() {},
    openrev: queue,
  };
  g.window = g;
  g.parent = g;
  vm.runInNewContext(trackerCode, g);
  return sent;
}

describe("tracker configuration element", () => {
  it("control: sends to the script origin with the script's website id", () => {
    const sent = run(null);
    expect(sent.map((s) => s.body.type)).toEqual(["pageview", "identify"]);
    for (const s of sent) {
      expect(s.url).toBe("https://openrev.example/api/events");
      expect(s.body.websiteId).toBe("site-real");
    }
  });

  it("ignores a non-script element that shadows document.currentScript (data-api-url)", () => {
    const sent = run({ name: "currentScript", "data-website-id": "site-from-markup", "data-api-url": OTHER + "/collect" });
    expect(sent.length).toBe(2);
    for (const s of sent) {
      expect(s.url).toBe("https://openrev.example/api/events");
      expect(s.body.websiteId).toBe("site-real");
    }
  });

  it("ignores a non-script element that shadows document.currentScript (src origin)", () => {
    const sent = run({ name: "currentScript", "data-website-id": "site-from-markup", src: OTHER + "/pixel.png" });
    expect(sent.length).toBe(2);
    for (const s of sent) {
      expect(s.url).toBe("https://openrev.example/api/events");
      expect(s.body.websiteId).toBe("site-real");
    }
  });
});
