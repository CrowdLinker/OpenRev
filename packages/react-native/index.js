// OpenRev for React Native and Expo: screens, goals, deep links and web-to-app attribution.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Dimensions, Linking, Platform } from "react-native";
import { createClient, VERSION } from "./core.js";

export { VERSION };

let client = null;
const warn = () => console.warn("[OpenRev] Call OpenRev.init() first");

function locale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

function platformInfo() {
  const { width, height } = Dimensions.get("window");
  const tablet = Platform.OS === "ios" ? !!Platform.isPad : Math.min(width, height) >= 600;
  return {
    os: Platform.OS,
    // Android's Platform.Version is the API level; Release is the version people know ("14").
    osVersion: Platform.OS === "android" ? String(Platform.constants?.Release ?? Platform.Version) : String(Platform.Version),
    device: tablet ? "tablet" : "phone",
    screenWidth: Math.round(width),
    language: locale(),
  };
}

const OpenRev = {
  /**
   * Starts tracking. Options: host, websiteId, appId (bundle id or package name), appVersion, debug,
   * deepLinks (default true: reads the link that opened the app, and later ones), storage (default AsyncStorage).
   */
  init(options) {
    if (client) return client;
    const deepLinks = options.deepLinks !== false;
    client = createClient({
      storage: AsyncStorage,
      platform: platformInfo(),
      initialURL: deepLinks ? Linking.getInitialURL().catch(() => null) : null,
      ...options,
    });
    if (deepLinks) Linking.addEventListener("url", ({ url }) => client.handleURL(url));
    AppState.addEventListener("change", (state) => {
      if (state === "active") client.foreground();
      else if (state === "background") client.background();
    });
    return client;
  },
  screen: (name) => (client ? client.screen(name) : warn()),
  track: (name, props) => (client ? client.track(name, props) : warn()),
  identify: (user) => (client ? client.identify(user) : warn()),
  payment: (hint) => (client ? client.payment(hint) : warn()),
  handleURL: (url) => (client ? client.handleURL(url) : warn()),
  setInstallReferrer: (referrer) => (client ? client.setInstallReferrer(referrer) : warn()),
  optOut: (value) => (client ? client.optOut(value) : warn()),
  visitorId: () => (client ? client.visitorId() : Promise.resolve(null)),
  sessionId: () => (client ? client.sessionId() : Promise.resolve(null)),
  /**
   * React Navigation: spread on the NavigationContainer to record each screen.
   *   <NavigationContainer ref={navigationRef} {...OpenRev.navigation(navigationRef)}>
   */
  navigation(navigationRef) {
    let last = null;
    const record = () => {
      const route = navigationRef.current?.getCurrentRoute?.() ?? navigationRef.getCurrentRoute?.();
      if (route && route.name !== last) {
        last = route.name;
        OpenRev.screen(route.name);
      }
    };
    return { onReady: record, onStateChange: record };
  },
};

export default OpenRev;
