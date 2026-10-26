import { useEffect, useRef, useState } from "react";
import { CodeBlock, cx } from "./ui";

type Theme = "light" | "dark" | "auto";

/** Loads /js/badge.js once so the preview renders the same element other sites embed. */
function useBadgeScript() {
  useEffect(() => {
    if (document.querySelector("script[data-openrev-badge-script]")) return;
    const s = document.createElement("script");
    s.src = "/js/badge.js";
    s.async = true;
    s.dataset.openrevBadgeScript = "";
    document.head.appendChild(s);
  }, []);
}

/** "Live badge" block under the public dashboard link: preview, theme and copy-paste snippets. */
export function LiveBadge({ token }: { token: string }) {
  const [theme, setTheme] = useState<Theme>("light");
  const preview = useRef<HTMLDivElement>(null);
  const origin = window.location.origin;
  useBadgeScript();

  useEffect(() => {
    const el = preview.current;
    if (!el) return;
    const badge = document.createElement("openrev-badge");
    badge.setAttribute("share", token);
    badge.setAttribute("theme", theme);
    el.replaceChildren(badge);
  }, [token, theme]);

  const html = `<script async src="${origin}/js/badge.js"></script>\n<openrev-badge share="${token}"${theme === "light" ? "" : ` theme="${theme}"`}></openrev-badge>`;
  const markdown = `[![Live visitors](${origin}/api/badge/${token}/badge.svg${theme === "dark" ? "?theme=dark" : ""})](${origin}/share/${token}?period=today)`;

  return (
    <div className="space-y-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-white">Live badge</p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Show visitors online and today on your site. It links to this public dashboard and shows nothing the dashboard doesn't.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div
          ref={preview}
          className={cx("flex min-h-[52px] flex-1 items-center rounded-xl px-4", theme === "dark" ? "bg-zinc-950" : "bg-zinc-50 dark:bg-zinc-900")}
        />
        <select className="input w-auto" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label="Badge theme">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="auto">Match the visitor's system</option>
        </select>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">Paste where the badge should appear:</p>
      <CodeBlock code={html} />
      <p className="text-xs text-zinc-500 dark:text-zinc-400">Or as an image, for a README or anywhere scripts can't run:</p>
      <CodeBlock code={markdown} />
    </div>
  );
}
