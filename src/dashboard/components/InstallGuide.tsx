import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { timeAgo } from "../lib/format";
import { Badge, CodeBlock, Tabs } from "./ui";

type Variant = "default" | "hash" | "cookieless" | "consent";

export function scriptUrl(variant: Variant = "default") {
  const file = variant === "default" ? "script.js" : `script.${variant}.js`;
  return `${window.location.origin}/js/${file}`;
}

export function snippet(site: { id: string; domain: string }, variant: Variant = "default") {
  return `<script
  defer
  data-website-id="${site.id}"
  data-domain="${site.domain}"
  src="${scriptUrl(variant)}"
></script>`;
}

export const QUEUE_SNIPPET = `<script>
  window.openrev = window.openrev || function () { (window.openrev.q = window.openrev.q || []).push(arguments); };
</script>`;

type Platform = "html" | "nextjs" | "react" | "wordpress" | "shopify" | "webflow" | "framer" | "gtm" | "other";

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "html", label: "HTML" },
  { value: "nextjs", label: "Next.js" },
  { value: "react", label: "React / Vite" },
  { value: "wordpress", label: "WordPress" },
  { value: "shopify", label: "Shopify" },
  { value: "webflow", label: "Webflow" },
  { value: "framer", label: "Framer" },
  { value: "gtm", label: "Google Tag Manager" },
  { value: "other", label: "Other" },
];

export function InstallGuide({ site, cookieless }: { site: { id: string; domain: string }; cookieless?: boolean }) {
  const [platform, setPlatform] = useState<Platform>("html");
  const variant = cookieless ? "cookieless" : "default";
  const tag = snippet(site, variant);
  const src = scriptUrl(variant);

  const guides: Record<Platform, { steps: string[]; code: string }> = {
    html: { steps: ["Paste this snippet in the <head> of every page of your website."], code: tag },
    nextjs: {
      steps: ["Add the script to your root layout (app/layout.tsx) with next/script."],
      code: `import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script
          defer
          data-website-id="${site.id}"
          data-domain="${site.domain}"
          src="${src}"
          strategy="afterInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}`,
    },
    react: { steps: ["Paste the snippet inside <head> in index.html. Route changes are tracked automatically."], code: tag },
    wordpress: {
      steps: [
        "Install a header-code plugin such as WPCode (Insert Headers and Footers).",
        "Go to Code Snippets → Header & Footer and paste the snippet in the Header box, then save.",
      ],
      code: tag,
    },
    shopify: {
      steps: [
        "Go to Online Store → Themes → ⋯ → Edit code and open layout/theme.liquid.",
        "Paste the snippet right before </head> and save. OpenRev automatically tags carts so orders are attributed.",
      ],
      code: tag,
    },
    webflow: { steps: ["Open Site settings → Custom code and paste the snippet in Head code. Publish your site."], code: tag },
    framer: { steps: ["Open Site Settings → General → Custom Code and paste the snippet in “End of <head> tag”. Publish."], code: tag },
    gtm: {
      steps: ["Create a Custom HTML tag with this code, trigger it on All Pages, then submit the container."],
      code: `<script>
  (function () {
    var s = document.createElement("script");
    s.defer = true;
    s.src = "${src}";
    s.setAttribute("data-website-id", "${site.id}");
    s.setAttribute("data-domain", "${site.domain}");
    document.head.appendChild(s);
  })();
</script>`,
    },
    other: { steps: ["Add this snippet to the <head> of your site (most builders have a “custom code” or “head code” setting)."], code: tag },
  };

  const g = guides[platform];
  return (
    <div>
      <Tabs tabs={PLATFORMS} value={platform} onChange={setPlatform} />
      <ol className="mt-4 mb-3 list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        {g.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <CodeBlock code={g.code} />
    </div>
  );
}

export function VerifyInstall({ siteId, onInstalled }: { siteId: string; onInstalled?: () => void }) {
  const { data } = useApi<{ installed: boolean; lastEvent: { ts: number; hostname: string; path: string } | null; events: number }>(
    `/api/sites/${siteId}/verify`,
    { poll: 3000 },
  );
  const installed = !!data?.installed;
  useEffect(() => {
    if (installed) onInstalled?.();
  }, [installed, onInstalled]);
  if (data?.installed) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-money-200 bg-money-50 px-4 py-3 text-sm text-money-800 dark:border-money-900 dark:bg-money-500/10 dark:text-money-300">
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        <div>
          <div className="font-medium">OpenRev is receiving data 🎉</div>
          <div className="text-xs opacity-80">
            Last event {timeAgo(data.lastEvent!.ts)} from {data.lastEvent!.hostname}
            {data.lastEvent!.path} · {data.events} events so far
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-500" />
      <div>
        <div className="font-medium text-zinc-800 dark:text-zinc-200">Waiting for the first visit…</div>
        <div className="text-xs">Open your website in a new tab. Ad blockers or localhost can prevent tracking — see the troubleshooting docs.</div>
      </div>
      <Badge color="amber">Not installed</Badge>
    </div>
  );
}
