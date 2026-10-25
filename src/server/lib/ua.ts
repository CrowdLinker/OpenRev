export interface UserAgentInfo {
  browser: string;
  browserVersion: string | null;
  os: string;
  osVersion: string | null;
  device: "desktop" | "mobile" | "tablet";
  /** Name of the social app whose in-app browser is being used, if any. */
  inApp: string | null;
}

const IN_APP: [RegExp, string][] = [
  [/Instagram/i, "Instagram"],
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i, "Facebook"],
  [/musical_ly|TikTok|BytedanceWebview|trill_/i, "TikTok"],
  [/LinkedInApp/i, "LinkedIn"],
  [/Twitter(?:Android)?\//i, "X"],
  [/Snapchat/i, "Snapchat"],
  [/Pinterest/i, "Pinterest"],
  [/\bReddit\//i, "Reddit"],
  [/\bThreads\b|Barcelona/i, "Threads"],
  [/MicroMessenger/i, "WeChat"],
  [/\bLine\//i, "LINE"],
  [/Telegram/i, "Telegram"],
  [/Discord/i, "Discord"],
  [/YouTube/i, "YouTube"],
];

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge"],
  [/OPR\/([\d.]+)|Opera.*Version\/([\d.]+)|OPiOS\/([\d.]+)/, "Opera"],
  [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"],
  [/YaBrowser\/([\d.]+)/, "Yandex Browser"],
  [/UCBrowser\/([\d.]+)/, "UC Browser"],
  [/Vivaldi\/([\d.]+)/, "Vivaldi"],
  [/(?:DuckDuckGo|Ddg)\/([\d.]+)/, "DuckDuckGo"],
  [/Brave\/([\d.]+)/, "Brave"],
  [/Whale\/([\d.]+)/, "Whale"],
  [/HuaweiBrowser\/([\d.]+)/, "Huawei Browser"],
  [/MiuiBrowser\/([\d.]+)/, "MIUI Browser"],
  [/(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox"],
  [/CriOS\/([\d.]+)/, "Chrome"],
  [/(?:Chrome|Chromium)\/([\d.]+)/, "Chrome"],
  [/Version\/([\d.]+).*Safari/, "Safari"],
  [/(?:MSIE |Trident\/.*rv:)([\d.]+)/, "Internet Explorer"],
  [/AppleWebKit.*Mobile/, "Safari"],
];

function major(version: string | undefined): string | null {
  if (!version) return null;
  const parts = version.split(".");
  return parts[0] || null;
}

export function parseUserAgent(ua: string, screenWidth?: number | null): UserAgentInfo {
  let browser = "Unknown";
  let browserVersion: string | null = null;
  let inApp: string | null = null;

  for (const [re, name] of IN_APP) {
    if (re.test(ua)) {
      inApp = name;
      break;
    }
  }

  for (const [re, name] of BROWSERS) {
    const m = ua.match(re);
    if (m) {
      browser = name;
      browserVersion = major(m.slice(1).find(Boolean));
      break;
    }
  }
  if (inApp) {
    browser = `${inApp} in-app`;
    browserVersion = null;
  }

  let os = "Unknown";
  let osVersion: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/(?:iPhone|iPod).*?OS (\d+)[_\d]*/))) {
    os = "iOS";
    osVersion = m[1];
  } else if ((m = ua.match(/iPad.*?OS (\d+)[_\d]*/))) {
    os = "iPadOS";
    osVersion = m[1];
  } else if ((m = ua.match(/Android[ /]?(\d+)?/))) {
    os = "Android";
    osVersion = m[1] ?? null;
  } else if ((m = ua.match(/Windows NT (\d+\.\d+)/))) {
    os = "Windows";
    osVersion = ({ "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" } as Record<string, string>)[m[1]] ?? m[1];
  } else if (/Windows Phone/.test(ua)) {
    os = "Windows Phone";
  } else if ((m = ua.match(/Mac OS X (\d+)[_.](\d+)?/))) {
    os = "macOS";
    osVersion = m[1] === "10" && m[2] ? `10.${m[2]}` : m[1];
  } else if (/CrOS/.test(ua)) {
    os = "ChromeOS";
  } else if (/HarmonyOS/.test(ua)) {
    os = "HarmonyOS";
  } else if (/Ubuntu/.test(ua)) {
    os = "Ubuntu";
  } else if (/Fedora/.test(ua)) {
    os = "Fedora";
  } else if (/FreeBSD/.test(ua)) {
    os = "FreeBSD";
  } else if (/Linux|X11/.test(ua)) {
    os = "Linux";
  }

  let device: UserAgentInfo["device"] = "desktop";
  if (/iPad|Tablet|Kindle|Silk|PlayBook|Nexus (7|9|10)/i.test(ua) || (os === "Android" && !/Mobile/.test(ua))) {
    device = "tablet";
  } else if (/Mobi|iPhone|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) {
    device = "mobile";
  } else if (screenWidth && screenWidth > 0 && screenWidth < 600 && os !== "macOS" && os !== "Windows") {
    device = "mobile";
  }

  return { browser, browserVersion, os, osVersion, device, inApp };
}
