# openrev-react-native

[OpenRev](https://github.com/CrowdLinker/OpenRev) for React Native and Expo: screens, goals and users on the same
dashboard as your website, and web-to-app funnels where a visitor who goes from the website to the app stays the same
visitor, with the revenue they bring.

```bash
npx expo install openrev-react-native @react-native-async-storage/async-storage react-native-get-random-values
```

```tsx
import OpenRev from "openrev-react-native";

OpenRev.init({ host: "https://analytics.example.com", websiteId: "your-website-id", appId: "com.example.app" });

// React Navigation
<NavigationContainer ref={navigationRef} {...OpenRev.navigation(navigationRef)}>

OpenRev.track("subscribed", { plan: "pro" });
OpenRev.identify({ user_id: "usr_123", email: "jane@example.com" });
```

Add the app id in OpenRev first: **Settings → Tracking code → Mobile apps**.

Links from your website into the app can carry the visitor (`_or_vid`), and the SDK reads them from the link that
opens the app, or from the Google Play install referrer. Guide:
[docs/tracking/mobile-apps.md](https://github.com/CrowdLinker/OpenRev/blob/main/docs/tracking/mobile-apps.md).

MIT license.
