import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useSite } from "../lib/context";
import type { Site } from "../lib/types";
import { Button, CodeBlock, ErrorBox, Field, Section, Tabs } from "./ui";

const DOCS = "https://github.com/CrowdLinker/OpenRev/blob/main/docs/tracking/mobile-apps.md";

type Step = "install" | "screens" | "links";

/** Settings → Tracking code: the app ids allowed to send events, and the React Native SDK setup. */
export function MobileAppsSettings({ site }: { site: Site }) {
  const { reloadSite } = useSite();
  const [ids, setIds] = useState((site.settings.appIds ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sites/${site.id}`, { method: "PATCH", body: { settings: { appIds: ids.split(/[\s,]+/).filter(Boolean) } } });
      reloadSite();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const [step, setStep] = useState<Step>("install");
  useEffect(() => setIds((site.settings.appIds ?? []).join("\n")), [site.settings.appIds]);
  const appId = site.settings.appIds?.[0] ?? "com.example.app";

  const code: Record<Step, string> = {
    install: `npx expo install openrev-react-native @react-native-async-storage/async-storage
# or: npm install openrev-react-native @react-native-async-storage/async-storage

// App.tsx, once at startup
import OpenRev from "openrev-react-native";

OpenRev.init({
  host: "${window.location.origin}",
  websiteId: "${site.id}",
  appId: "${appId}",
  appVersion: "1.0.0",
});`,
    screens: `// React Navigation: every screen is recorded
const navigationRef = createNavigationContainerRef();
<NavigationContainer ref={navigationRef} {...OpenRev.navigation(navigationRef)}>

// Expo Router (app/_layout.tsx)
const pathname = usePathname();
useEffect(() => { OpenRev.screen(pathname); }, [pathname]);

// Goals and users, as on the website
OpenRev.track("subscribed", { plan: "pro" });
OpenRev.identify({ user_id: "usr_123", email: "jane@example.com" });`,
    links: `<!-- On the website: links into the app carry the visitor, so funnels and revenue span both -->
<a id="open-app" href="https://${site.domain}/app/open">Open the app</a>
<a id="get-android" href="https://play.google.com/store/apps/details?id=${appId}">Get it on Google Play</a>
<script>
  const ids = () => ({ _or_vid: openrev.visitorId(), _or_sid: openrev.sessionId() });
  document.getElementById("open-app").addEventListener("click", (e) => {
    const url = new URL(e.currentTarget.href);
    for (const [k, v] of Object.entries(ids())) url.searchParams.set(k, v);
    e.currentTarget.href = url;
  });
  // Google Play hands the referrer to the app after the install.
  document.getElementById("get-android").addEventListener("click", (e) => {
    const url = new URL(e.currentTarget.href);
    url.searchParams.set("referrer", new URLSearchParams(ids()).toString());
    e.currentTarget.href = url;
  });
</script>`,
  };

  return (
    <Section
      title="Mobile apps"
      description={
        <>
          Track a React Native or Expo app on this website's dashboard, and follow visitors from the website into the app.{" "}
          <a className="text-brand-600 hover:underline" href={DOCS} target="_blank" rel="noreferrer">
            App guide
          </a>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="App ids" help="The iOS bundle id and Android package name of each app, one per line. Events from other apps are ignored.">
          <textarea className="input min-h-[64px] font-mono text-xs" value={ids} onChange={(e) => setIds(e.target.value)} placeholder="com.example.app" />
        </Field>
        {!!error && <ErrorBox error={error} />}
        <Button variant="primary" loading={busy} onClick={save}>
          {saved ? "Saved" : "Save app ids"}
        </Button>
        <div className="pt-2">
          <Tabs
            tabs={[
              { value: "install", label: "Install" },
              { value: "screens", label: "Screens & goals" },
              { value: "links", label: "Website → app" },
            ]}
            value={step}
            onChange={(v) => setStep(v as Step)}
          />
          <CodeBlock code={code[step]} className="mt-3" />
        </div>
      </div>
    </Section>
  );
}
