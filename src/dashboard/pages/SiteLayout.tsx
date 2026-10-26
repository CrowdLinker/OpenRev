import { BarChart3, Bot, DollarSign, Filter as FunnelIcon, Radio, Repeat, Settings, Users } from "lucide-react";
import { Link, Route, Switch, useLocation } from "wouter";
import { cx, ErrorBox, Loading } from "../components/ui";
import { useApi } from "../lib/api";
import { canEdit, SiteContext } from "../lib/context";
import type { Role, Site, SiteMeta } from "../lib/types";
import { CrawlersPage } from "./Crawlers";
import { DashboardPage } from "./Dashboard";
import { FunnelsPage } from "./Funnels";
import { MrrPage } from "./Mrr";
import { RealtimePage } from "./Realtime";
import { RevenuePage } from "./Revenue";
import { SettingsPage } from "./Settings";
import { VisitorProfilePage, VisitorsPage } from "./Visitors";

export function SiteNav({ isPublic = false, role, hideRevenue, crawlers = true }: { isPublic?: boolean; role: Role | null; hideRevenue?: boolean; crawlers?: boolean }) {
  const [location] = useLocation();
  const items = [
    { href: "/", label: "Dashboard", icon: BarChart3, match: (l: string) => l === "/" || l === "" },
    { href: "/realtime", label: "Realtime", icon: Radio },
    ...(isPublic ? [] : [{ href: "/visitors", label: "Visitors", icon: Users }]),
    ...(hideRevenue
      ? []
      : [
          { href: "/revenue", label: "Revenue", icon: DollarSign },
          { href: "/mrr", label: "MRR", icon: Repeat },
        ]),
    { href: "/funnels", label: "Funnels", icon: FunnelIcon },
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

export function SiteLayout({ siteId }: { siteId: string }) {
  const site = useApi<{ site: Site; role: Role }>(`/api/sites/${siteId}`);
  const meta = useApi<SiteMeta>(`/api/sites/${siteId}/stats/meta`);
  if (site.loading && !site.data) return <Loading />;
  if (site.error) return <ErrorBox error={site.error} />;
  const ctx = {
    statsBase: `/api/sites/${siteId}/stats`,
    site: site.data?.site ?? null,
    meta: meta.data ?? null,
    role: site.data?.role ?? null,
    isPublic: false,
    reloadSite: site.reload,
    reloadMeta: meta.reload,
  };
  return (
    <SiteContext.Provider value={ctx}>
      <SiteNav role={ctx.role} hideRevenue={ctx.site?.settings.hideRevenue} />
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/realtime" component={RealtimePage} />
        <Route path="/visitors" component={VisitorsPage} />
        <Route path="/visitors/:visitorId">{(p) => <VisitorProfilePage visitorId={p.visitorId} />}</Route>
        <Route path="/revenue" component={RevenuePage} />
        <Route path="/mrr" component={MrrPage} />
        <Route path="/funnels" component={FunnelsPage} />
        <Route path="/crawlers" component={CrawlersPage} />
        <Route path="/settings/:tab?">{(p) => <SettingsPage tab={p.tab} />}</Route>
      </Switch>
    </SiteContext.Provider>
  );
}
