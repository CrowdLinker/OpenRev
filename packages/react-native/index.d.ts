export const VERSION: string;

export interface OpenRevOptions {
  /** Your OpenRev address, like https://analytics.example.com */
  host: string;
  /** The website's id (Settings → General). */
  websiteId: string;
  /** The iOS bundle id or Android package name, listed in Settings → Tracking code → Mobile apps. */
  appId: string;
  /** Shown as the version in the Browsers report, like "1.4.0". */
  appVersion?: string;
  /** Log events to the console. */
  debug?: boolean;
  /** Read the link that opened the app, and later ones (default true). */
  deepLinks?: boolean;
  /** Where the visitor and session ids are kept (default AsyncStorage). */
  storage?: { getItem(key: string): Promise<string | null> | string | null; setItem(key: string, value: string): Promise<void> | void };
}

export interface OpenRevClient {
  ready: Promise<void>;
  screen(name: string): Promise<void>;
  track(name: string, props?: Record<string, string | number | boolean | null>): Promise<void>;
  identify(user: { user_id?: string; email?: string; name?: string; image?: string; [key: string]: unknown }): Promise<void>;
  payment(hint: { email?: string; ref?: string; transaction_id?: string; provider?: string }): Promise<void>;
  handleURL(url: string): Promise<void>;
  setInstallReferrer(referrer: string): Promise<void>;
  background(): void;
  foreground(): void;
  optOut(value?: boolean): Promise<void>;
  visitorId(): Promise<string>;
  sessionId(): Promise<string>;
}

declare const OpenRev: {
  init(options: OpenRevOptions): OpenRevClient;
  screen(name: string): Promise<void> | void;
  track(name: string, props?: Record<string, string | number | boolean | null>): Promise<void> | void;
  identify(user: { user_id?: string; email?: string; name?: string; image?: string; [key: string]: unknown }): Promise<void> | void;
  payment(hint: { email?: string; ref?: string; transaction_id?: string; provider?: string }): Promise<void> | void;
  handleURL(url: string): Promise<void> | void;
  setInstallReferrer(referrer: string): Promise<void> | void;
  optOut(value?: boolean): Promise<void> | void;
  visitorId(): Promise<string | null>;
  sessionId(): Promise<string | null>;
  navigation(navigationRef: unknown): { onReady(): void; onStateChange(): void };
};
export default OpenRev;
