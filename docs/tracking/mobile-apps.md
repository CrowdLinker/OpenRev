# Mobile apps and web-to-app funnels

Track a React Native or Expo app on the same dashboard as your website, with the
[`openrev-react-native`](../../packages/react-native) SDK. Screens count as pageviews, goals and `identify` work as
on the website, and a visitor who goes from the website to the app stays the same visitor: funnels can start on a web
page and end on an app screen, and revenue made in the app keeps the source that brought the visitor to the website.

## Set up

1. In OpenRev, open **Settings → Tracking code → Mobile apps** and add your app ids: the iOS bundle id and the Android
   package name, like `com.example.app`. OpenRev ignores events from other apps.
2. Install the SDK and AsyncStorage, where it keeps the visitor and session ids:

   ```bash
   npx expo install openrev-react-native @react-native-async-storage/async-storage
   # or, without Expo
   npm install openrev-react-native @react-native-async-storage/async-storage
   ```

3. Start it once, when the app starts:

   ```tsx
   import OpenRev from "openrev-react-native";

   OpenRev.init({
     host: "https://analytics.example.com", // your OpenRev
     websiteId: "your-website-id", // Settings → General
     appId: "com.example.app",
     appVersion: "1.4.0", // optional: shown in the Browsers report
   });
   ```

4. Record screens. With React Navigation:

   ```tsx
   const navigationRef = createNavigationContainerRef();

   <NavigationContainer ref={navigationRef} {...OpenRev.navigation(navigationRef)}>
   ```

   With Expo Router, in `app/_layout.tsx`:

   ```tsx
   const pathname = usePathname();
   useEffect(() => {
     OpenRev.screen(pathname);
   }, [pathname]);
   ```

   Or call `OpenRev.screen("Checkout")` yourself.

## What the SDK sends

| Call | Records |
| --- | --- |
| `OpenRev.screen(name)` | A pageview of `/name` (or the path you pass) |
| `OpenRev.track(name, props)` | A goal, with up to 10 properties, as `openrev(name, props)` on the website |
| `OpenRev.identify({ user_id, email, name, image, ...props })` | The user behind the visitor |
| `OpenRev.payment({ email })` | A hint to match a payment the provider reports, as on the website |
| `OpenRev.optOut(true)` | Stops tracking on this device (and `false` resumes it) |
| `await OpenRev.visitorId()` | The visitor id, to pass to your backend or checkout (see Revenue below) |

- Screens are recorded under the app id as the hostname, so the **Hostname** report and filter separate the app from
  the website. **Operating systems** shows iOS, iPadOS and Android, **Devices** phones and tablets, and **Browsers**
  "App" with your app versions.
- A session ends after 30 minutes without events, as on the website. Time in the app counts toward visit duration.
- Locations come from the IP address. With **cookieless mode** on, app visitors are counted with the daily hash too.
- Events that can't be sent (offline) are retried with the next one, up to 50.

## From the website to the app

Links from your website into the app can carry the visitor and session ids, the way
[cross-domain tracking](cross-domain.md) does between websites (`_or_vid` and `_or_sid`). The SDK reads them from the
link that opens the app (universal links, app links and custom schemes), so the app continues the visitor's journey.

```html
<a id="open-app" href="https://example.com/app/open">Open the app</a>
<a id="get-android" href="https://play.google.com/store/apps/details?id=com.example.app">Get it on Google Play</a>
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
</script>
```

- **The app is installed:** the link opens it, and the SDK takes the visitor id from the URL.
- **Android, not installed yet:** Google Play passes the `referrer` to the app after the install. Read it with
  [`react-native-play-install-referrer`](https://www.npmjs.com/package/react-native-play-install-referrer) and give
  it to the SDK once:

  ```tsx
  import { PlayInstallReferrer } from "react-native-play-install-referrer";

  PlayInstallReferrer.getInstallReferrerInfo((info, error) => {
    if (!error && info?.installReferrer) OpenRev.setInstallReferrer(info.installReferrer);
  });
  ```

- **iOS, not installed yet:** the App Store doesn't pass anything to the app. The visitor is linked the next time they
  open the app from a link, or you can rely on `identify` with the same `user_id` on both.

A link only sets the visitor of an install less than 24 hours old, like cross-domain links only set it for a new
browser, so a shared link can't move an established install to someone else's visitor. Campaign parameters on a link
(`utm_source`, `ref`, `gclid`…) start a new visit with that source, as landing on a website does.

## Web-to-app funnels

Funnel steps match pages and goals by visitor, so once a visitor is linked, one funnel can mix both: for example the
website's `/download` page, then the app's `/Onboarding` screen, then the `subscribed` goal sent from the app.
Create it in **Funnels** like any other. A step matches web pages and app screens with that path, so use paths that
don't collide, or filter by hostname.

## Revenue

Payments are recorded by your payment provider, as for the website, and attributed through the visitor id:

- **Checkout in a web view or browser** (Stripe Checkout, Lemon Squeezy…): add the visitor id from
  `OpenRev.visitorId()` to the checkout, as described for [your provider](../revenue/README.md).
- **Your backend** records the purchase (in-app purchases, RevenueCat webhooks): send it with the
  [Payments API](../api/README.md#post-payments) and `visitor_id` set to the app's `OpenRev.visitorId()`, which your
  app passes to your backend.

## Privacy

The SDK stores a random visitor id and the current session in AsyncStorage, and sends the screen, the app version, the
OS, the device type, the screen width and the language. It doesn't read the advertising id, contacts or location.
`OpenRev.optOut(true)` stops it on the device.
