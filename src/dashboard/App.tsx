import { useEffect } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { Shell } from "./components/Shell";
import { Loading } from "./components/ui";
import { api, useApi } from "./lib/api";
import { AuthContext } from "./lib/context";
import type { Instance, User } from "./lib/types";
import { AccountPage } from "./pages/Account";
import { InvitePage, LoginPage, SignupPage } from "./pages/Auth";
import { NewSitePage } from "./pages/NewSite";
import { SharePage } from "./pages/Share";
import { SiteLayout } from "./pages/SiteLayout";
import { SitesPage } from "./pages/Sites";

export function App() {
  const instance = useApi<Instance>("/api/instance");
  const me = useApi<{ user: User | null }>("/api/auth/me");
  const [location, navigate] = useLocation();

  useEffect(() => {
    const onUnauthorized = () => {
      me.reload();
      navigate("/login");
    };
    window.addEventListener("openrev:unauthorized", onUnauthorized);
    return () => window.removeEventListener("openrev:unauthorized", onUnauthorized);
  }, [me, navigate]);

  if (location.startsWith("/share/")) {
    return (
      <Switch>
        <Route path="/share/:token" nest>
          {(params) => <SharePage token={params.token} />}
        </Route>
      </Switch>
    );
  }

  if (!instance.data || (me.loading && !me.data)) return <Loading className="min-h-screen" />;
  const user = me.data?.user ?? null;
  const auth = {
    user,
    instance: instance.data,
    refresh: async () => {
      const [m, i] = await Promise.all([api<{ user: User | null }>("/api/auth/me"), api<Instance>("/api/instance")]);
      me.setData(m);
      instance.setData(i);
    },
  };

  return (
    <AuthContext.Provider value={auth}>
      <Switch>
        <Route path="/login">{user ? <Redirect to="/" /> : !instance.data.hasUsers ? <Redirect to="/signup" /> : <LoginPage />}</Route>
        <Route path="/signup">{user ? <Redirect to="/" /> : <SignupPage />}</Route>
        <Route path="/invite/:token">{(p) => <InvitePage token={p.token} />}</Route>
        <Route>
          {!user ? (
            <Redirect to={instance.data.hasUsers ? "/login" : "/signup"} />
          ) : (
            <Shell>
              <Switch>
                <Route path="/" component={SitesPage} />
                <Route path="/sites/new" component={NewSitePage} />
                <Route path="/account" component={AccountPage} />
                <Route path="/sites/:siteId" nest>
                  {(p) => <SiteLayout siteId={p.siteId} />}
                </Route>
                <Route>
                  <div className="py-20 text-center text-zinc-500">Page not found</div>
                </Route>
              </Switch>
            </Shell>
          )}
        </Route>
      </Switch>
    </AuthContext.Provider>
  );
}
