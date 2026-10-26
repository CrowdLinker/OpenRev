import { BarChart3, Bot, DollarSign, EyeOff, Megaphone, Filter as FunnelIcon, Radio, Repeat, Settings, Users } from "lucide-react";
import type { ComponentType } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { cx, Empty, ErrorBox, Loading } from "../components/ui";
import { useApi } from "../lib/api";
import { canEdit, SiteContext, useSite } from "../lib/context";
import type { Role, Site, SiteMeta } from "../lib/types";
import { CrawlersPage } from "./Crawlers";
import { DashboardPage } from "./Dashboard";
import { FunnelsPage } from "./Funnels";
import { MrrPage } from "./Mrr";
import { RealtimePage } from "./Realtime";
import { RevenuePage } from "./Revenue";
import { SocialPage } from "./Social";
import { SettingsPage } from "./Settings";
import { VisitorProfilePage, VisitorsPage } from "./Visitors";

export function SiteNav({
  isPublic = false,
  role,
  hideRevenue,
  crawlers = true,
  social = true,
  visitors = !isPublic,
}: {
  isPublic?: boolean;
  role: Role | null;
  hideRevenue?: boolean;
  crawlers?: boolean;
  social?: boolean;
  /** Share links have no Visitors tab, except on a demo instance. */
  visitors?: boolean;
}) {
  const [location] = useLocation();
  const items = [
    { href: "/", label: "Dashboard", icon: BarChart3, match: (l: string) => l === "/" || l === "" },
    { href: "/realtime", label: "Realtime", icon: Radio },
    ...(visitors ? [{ href: "/visitors", label: "Visitors", icon: Users }] : []),
    ...(hideRevenue
      ? []
      : [
          { href: "/revenue", label: "Revenue", icon: DollarSign },
          { href: "/mrr", label: "MRR", icon: Repeat },
        ]),
    { href: "/funnels", label: "Funnels", icon: FunnelIcon },
    ...(social ? [{ href: "/social", label: "Social", icon: Megaphone }] : []),
    ...(crawlers ? [{ href: "/crawlers", label: "Crawlers", icon: Bot }] : []),
    ...(!isPublic && canEdit(role) ? [{ href: "/settings", label: "Settings", icon: Settings }] : []),
  ];
  return (
    <nav className="scrollbar-thin -mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      {items.map((item) => {
        const active = item.match ? item.match(location) : location.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cx(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition",
              active ? "border-brand-600 text-zinc-900 dark:text-white" : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
            )}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A revenue page (Revenue, MRR), or a note for viewers who can't see revenue and opened its address. */
export function RevenueOnly({ page: Page }: { page: ComponentType }) {
  const { canSeeRevenue, isPublic } = useSite();
  if (canSeeRevenue) return <Page />;
  return (
    <Empty title="Revenue is hidden" icon={<EyeOff className="h-6 w-6" />}>
      {isPublic ? "This dashboard doesn't share revenue." : "An owner, or an admin who can see revenue, can turn on “Can see revenue” for you in Settings → Team."}
    </Empty>
  );
}

export function SiteLayout({ siteId }: { siteId: string }) {
  const site = useApi<{ site: Site; role: Role; canSeeRevenue: boolean }>(`/api/sites/${siteId}`);
  const meta = useApi<SiteMeta>(`/api/sites/${siteId}/stats/meta`);
  if (site.loading && !site.data) return <Loading />;
  if (site.error) return <ErrorBox error={site.error} />;
  const ctx = {
    statsBase: `/api/sites/${siteId}/stats`,
    site: site.data?.site ?? null,
    meta: meta.data ?? null,
    role: site.data?.role ?? null,
    isPublic: false,
    // The member's own "Can see revenue" (always on for owners); "Hide revenue on share links" doesn't apply here.
    canSeeRevenue: !!site.data?.canSeeRevenue,
    reloadSite: site.reload,
    reloadMeta: meta.reload,
  };
  return (
    <SiteContext.Provider value={ctx}>
      <SiteNav role={ctx.role} hideRevenue={!ctx.canSeeRevenue} />
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/realtime" component={RealtimePage} />
        <Route path="/visitors" component={VisitorsPage} />
        <Route path="/visitors/:visitorId">{(p) => <VisitorProfilePage visitorId={p.visitorId} />}</Route>
        <Route path="/revenue">{() => <RevenueOnly page={RevenuePage} />}</Route>
        <Route path="/mrr">{() => <RevenueOnly page={MrrPage} />}</Route>
        <Route path="/funnels" component={FunnelsPage} />
        <Route path="/social" component={SocialPage} />
        <Route path="/crawlers" component={CrawlersPage} />
        <Route path="/settings/:tab?">{(p) => <SettingsPage tab={p.tab} />}</Route>
      </Switch>
    </SiteContext.Provider>
  );
}
