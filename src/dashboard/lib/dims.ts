export const UNATTRIBUTED = "__unattributed__";

export const DIM_LABELS: Record<string, string> = {
  channel: "Channel",
  source: "Referrer",
  referrer: "Referrer domain",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  utm_campaign: "Campaign",
  utm_term: "UTM term",
  utm_content: "UTM content",
  ref: "Ref",
  page: "Page",
  entry_page: "Entry page",
  exit_page: "Exit page",
  hostname: "Hostname",
  outbound: "Exit link",
  country: "Country",
  region: "Region",
  city: "City",
  device: "Device",
  browser: "Browser",
  os: "OS",
  goal: "Goal",
};

export const OP_LABELS: Record<string, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
};

export function displayValue(dim: string, value: string): string {
  if (value === UNATTRIBUTED) return "Unattributed";
  if (value === "") {
    if (dim === "source" || dim === "referrer" || dim === "channel") return "Direct / None";
    return "(none)";
  }
  if (dim === "device") return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

export const CHANNEL_COLORS: Record<string, string> = {
  Direct: "#71717a",
  "Organic Search": "#3b82f6",
  "Paid Search": "#1d4ed8",
  "Organic Social": "#ec4899",
  "Paid Social": "#be185d",
  AI: "#8b5cf6",
  Email: "#f59e0b",
  Referral: "#10b981",
  Affiliate: "#14b8a6",
  Display: "#f97316",
  "Paid Other": "#ef4444",
};
