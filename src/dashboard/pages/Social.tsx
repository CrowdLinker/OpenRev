import { ExternalLink, Heart, Info, MessageCircle, Megaphone, Repeat2, Eye } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { PeriodPicker } from "../components/Filters";
import { HnLogo, XLogo } from "../components/Social";
import { Avatar, Card, Empty, ErrorBox, Spinner, Tabs } from "../components/ui";
import { useApi } from "../lib/api";
import { canEdit, useSite } from "../lib/context";
import { money, num, timeAgo } from "../lib/format";
import { toSearch, useDashQuery } from "../lib/query";

type Platform = "x" | "hn";

interface SocialPostRow {
  platform: Platform;
  id: string;
  url: string;
  author: string | null;
  author_name: string | null;
  author_image: string | null;
  text: string | null;
  created_at: number;
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
  links: string[];
  sessions: number;
  visitors: number;
  revenue: number;
  customers: number;
}

interface PlatformSummary {
  mentions: number;
  visits: number;
  credited_visits: number;
  revenue: number;
  credited_revenue: number;
}

interface SocialResponse {
  currency: string;
  range: { from: number; to: number };
  summary: { mentions: number; x?: PlatformSummary; hn?: PlatformSummary };
  posts: SocialPostRow[];
  profiles: SocialPostRow[];
}

const PLATFORM_LABEL: Record<Platform, string> = { x: "𝕏", hn: "Hacker News" };

function PlatformIcon({ platform }: { platform: Platform }) {
  return platform === "x" ? <XLogo className="h-3.5 w-3.5" /> : <HnLogo className="h-3.5 w-3.5" />;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "money" }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular ${tone === "money" ? "text-money-600 dark:text-money-400" : ""}`}>{value}</div>
      <div className="h-4 truncate text-xs text-zinc-500">{sub}</div>
    </div>
  );
}

function Metric({ icon: Icon, value, label }: { icon: typeof Heart; value: number | null; label: string }) {
  if (value === null || value === undefined) return null;
  return (
    <span className="flex items-center gap-1" title={label}>
      <Icon className="h-3.5 w-3.5" />
      {num(value)}
    </span>
  );
}

function Results({ p, cur, hideRevenue }: { p: SocialPostRow; cur: string; hideRevenue?: boolean }) {
  return (
    <div className="shrink-0 text-right">
      <div className="text-sm font-semibold tabular">{num(p.visitors, false)}</div>
      <div className="text-xs text-zinc-500">{p.visitors === 1 ? "visitor" : "visitors"}</div>
      {!hideRevenue && p.revenue !== 0 && <div className="mt-1 text-sm font-semibold tabular text-money-600 dark:text-money-400">{money(p.revenue, cur)}</div>}
    </div>
  );
}

function PostRow({ p, cur, hideRevenue }: { p: SocialPostRow; cur: string; hideRevenue?: boolean }) {
  const name = p.platform === "x" ? (p.author ? `@${p.author}` : "𝕏 post") : (p.author ?? "Hacker News");
  return (
    <li className="flex gap-3 border-t border-zinc-100 py-3 first:border-0 first:pt-0 dark:border-zinc-800">
      <div className="relative shrink-0">
        {p.platform === "x" ? <Avatar name={p.author_name ?? p.author ?? "X"} image={p.author_image} size={36} /> : <HnLogo className="h-9 w-9 text-base" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
          {p.author_name && <span className="font-medium">{p.author_name}</span>}
          <span className={p.author_name ? "text-zinc-500" : "font-medium"}>{name}</span>
          <span className="text-zinc-400">·</span>
          <a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            <PlatformIcon platform={p.platform} /> {timeAgo(p.created_at)} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {p.text && <p className="mt-0.5 line-clamp-3 text-sm break-words whitespace-pre-line text-zinc-700 dark:text-zinc-300">{p.text}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          <Metric icon={Heart} value={p.likes} label={p.platform === "hn" ? "Points" : "Likes"} />
          {p.platform === "x" && <Metric icon={Repeat2} value={p.reposts} label="Reposts" />}
          <Metric icon={MessageCircle} value={p.replies} label={p.platform === "hn" ? "Comments" : "Replies"} />
          <Metric icon={Eye} value={p.views} label="Views" />
          {p.links.map((l) => (
            <span key={l} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {l}
            </span>
          ))}
        </div>
      </div>
      <Results p={p} cur={cur} hideRevenue={hideRevenue} />
    </li>
  );
}

export function SocialPage() {
  const { statsBase, meta, role, isPublic } = useSite();
  const [q] = useDashQuery();
  const [platform, setPlatform] = useState<"all" | Platform>("all");
  const report = useApi<SocialResponse>(`${statsBase}/social?${toSearch(q, { platform: platform === "all" ? undefined : platform })}`);
  const d = report.data;
  const cur = d?.currency ?? meta?.site.currency ?? "USD";
  const hideRevenue = meta?.site.hideRevenue;
  const editor = !isPublic && canEdit(role);
  const s = d?.summary;
  const both = [s?.x, s?.hn].filter(Boolean) as PlatformSummary[];
  const creditedRevenue = both.reduce((n, x) => n + x.credited_revenue, 0);
  const credited = both.reduce((n, x) => n + x.credited_visits, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Social</h2>
          <p className="text-xs text-zinc-500">Posts on 𝕏 and Hacker News that mention or link to your website, and what they bring</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            tabs={[
              { value: "all", label: "All" },
              { value: "x", label: "𝕏" },
              { value: "hn", label: "Hacker News" },
            ]}
            value={platform}
            onChange={(v) => setPlatform(v as "all" | Platform)}
          />
          <PeriodPicker range={d?.range as never} storageKey={meta?.site.id ?? "site"} />
        </div>
      </div>

      {report.loading && !d ? (
        <Spinner />
      ) : report.error ? (
        <ErrorBox error={report.error} />
      ) : d && s ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Mentions" value={num(s.mentions, false)} sub="posts and comments in this period" />
            {s.x && <Tile label="Visits from 𝕏" value={num(s.x.visits, false)} sub={`${num(s.x.credited_visits, false)} matched to a post or profile`} />}
            {s.hn && <Tile label="Visits from Hacker News" value={num(s.hn.visits, false)} sub={`${num(s.hn.credited_visits, false)} matched to a post`} />}
            {!hideRevenue && <Tile label="Revenue from posts" value={money(creditedRevenue, cur)} sub={`from ${num(credited, false)} matched visits`} tone="money" />}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">Posts</h3>
              {!d.posts.length ? (
                <Empty title="No posts in this period" icon={<Megaphone className="h-6 w-6" />}>
                  {editor ? (
                    <>
                      Watch 𝕏 and Hacker News in{" "}
                      <Link href="/settings/general" className="font-medium text-brand-600 hover:underline">
                        Settings → General
                      </Link>
                      .
                    </>
                  ) : null}
                </Empty>
              ) : (
                <ul>
                  {d.posts.map((p) => (
                    <PostRow key={`${p.platform}:${p.id}`} p={p} cur={cur} hideRevenue={hideRevenue} />
                  ))}
                </ul>
              )}
            </Card>

            <div className="space-y-4">
              <Card className="p-4">
                <h3 className="mb-1 text-sm font-semibold">Link in bio</h3>
                <p className="mb-3 text-xs text-zinc-500">Visits from 𝕏 profiles whose bio links to your website</p>
                {!d.profiles.length ? (
                  <p className="text-sm text-zinc-500">{editor ? "Add your handles in Settings → General → Social." : "No profiles."}</p>
                ) : (
                  <ul className="space-y-3">
                    {d.profiles.map((p) => (
                      <li key={p.id} className="flex items-center gap-3">
                        <Avatar name={p.author_name ?? p.author ?? "X"} image={p.author_image} size={32} />
                        <div className="min-w-0 flex-1">
                          <a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
                            @{p.author}
                          </a>
                          <div className="truncate font-mono text-[11px] text-zinc-500">{p.links.join(" ") || "no link to this website"}</div>
                        </div>
                        <Results p={p} cur={cur} hideRevenue={hideRevenue} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <p className="flex items-start gap-1.5 text-xs text-zinc-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  𝕏 hides which post a visitor clicked, so a visit is credited to the latest post (within 7 days) that links to the page it landed on, or to a profile
                  whose bio links there. Hacker News visits are matched the same way. {PLATFORM_LABEL.x} metrics are from when OpenRev found the post.
                </span>
              </p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
