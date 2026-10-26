import { Route, Switch } from "wouter";
import { Logo, useTheme } from "../components/Shell";
import { ErrorBox, Favicon, Loading } from "../components/ui";
import { useApi } from "../lib/api";
import { SiteContext } from "../lib/context";
import type { SiteMeta } from "../lib/types";
import { Moon, Sun } from "lucide-react";
import { CrawlersPage } from "./Crawlers";
import { DashboardPage } from "./Dashboard";
import { FunnelsPage } from "./Funnels";
import { RealtimePage } from "./Realtime";
import { MrrPage } from "./Mrr";
import { RevenuePage } from "./Revenue";
import { SocialPage } from "./Social";
import { RevenueOnly, SiteNav } from "./SiteLayout";
import { VisitorProfilePage, VisitorsPage } from "./Visitors";

/** Public, read-only dashboard: /share/:token */
export function SharePage({ token }: { token: string }) {
  const meta = useApi<SiteMeta>(`/api/share/${token}/stats/meta`);
  const [dark, toggle] = useTheme();
  if (meta.loading && !meta.data) return <Loading className="min-h-screen" />;
  if (meta.error) {
    return (
      <div className="mx-auto max-w-md py-24">
        <ErrorBox error={meta.error} />
      </div>
    );
  }
  const ctx = {
    statsBase: `/api/share/${token}/stats`,
    site: null,
    meta: meta.data ?? null,
    role: null,
    isPublic: true,
    // Off when "Hide revenue on share links" is on: the server leaves revenue out of every response.
    canSeeRevenue: !!meta.data?.canSeeRevenue,
    reloadSite: () => {},
    reloadMeta: meta.reload,
  };
  return (
    <SiteContext.Provider value={ctx}>
      <div className="min-h-screen">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
            <Favicon domain={meta.data?.site.domain} size={20} />
            <span className="font-semibold">{meta.data?.site.name}</span>
            <span className="text-sm text-zinc-500">{meta.data?.site.domain}</span>
            <div className="flex-1" />
            <button onClick={toggle} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Toggle theme">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <a href="https://github.com/CrowdLinker/OpenRev" target="_blank" rel="noreferrer" className="text-xs text-zinc-500 hover:text-zinc-900">
              <Logo className="text-sm" />
            </a>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <SiteNav
            isPublic
            role={null}
            hideRevenue={!ctx.canSeeRevenue}
            crawlers={!!meta.data?.crawlers}
            social={!!meta.data?.social}
            visitors={!!meta.data?.visitors}
          />
          <Switch>
            <Route path="/" component={DashboardPage} />
            <Route path="/realtime" component={RealtimePage} />
            {/* Only on a demo instance (DEMO_MODE): share links never list visitors otherwise. */}
            {meta.data?.visitors && <Route path="/visitors" component={VisitorsPage} />}
            {meta.data?.visitors && <Route path="/visitors/:visitorId">{(p) => <VisitorProfilePage visitorId={p.visitorId} />}</Route>}
            <Route path="/revenue">{() => <RevenueOnly page={RevenuePage} />}</Route>
            <Route path="/mrr">{() => <RevenueOnly page={MrrPage} />}</Route>
            <Route path="/funnels" component={FunnelsPage} />
            <Route path="/social" component={SocialPage} />
            <Route path="/crawlers" component={CrawlersPage} />
          </Switch>
        </main>
      </div>
    </SiteContext.Provider>
  );
}
