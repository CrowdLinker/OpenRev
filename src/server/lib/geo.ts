export interface GeoInfo {
  country?: string | null;
  region?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export type GeoResolver = (ip: string | null, request: Request) => Promise<GeoInfo | null> | GeoInfo | null;

function decode(v: string | null): string | null {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function country(v: string | null | undefined): string | null {
  if (!v) return null;
  const c = v.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return null;
  return c;
}

/**
 * Reads geolocation hints that CDNs and hosting platforms attach to requests
 * (Cloudflare, Vercel, CloudFront, Netlify, Google App Engine, Fastly...).
 */
export function geoFromHeaders(headers: Headers): GeoInfo | null {
  const h = (k: string) => headers.get(k);
  // Vercel
  if (h("x-vercel-ip-country")) {
    return {
      country: country(h("x-vercel-ip-country")),
      region: decode(h("x-vercel-ip-country-region")),
      city: decode(h("x-vercel-ip-city")),
      latitude: num(h("x-vercel-ip-latitude")),
      longitude: num(h("x-vercel-ip-longitude")),
    };
  }
  // Netlify
  const nf = h("x-nf-geo");
  if (nf) {
    try {
      const g = JSON.parse(atob(nf));
      return {
        country: country(g.country?.code),
        region: g.subdivision?.name ?? null,
        city: g.city ?? null,
        latitude: num(g.latitude),
        longitude: num(g.longitude),
      };
    } catch {
      /* ignore */
    }
  }
  // AWS CloudFront
  if (h("cloudfront-viewer-country")) {
    return {
      country: country(h("cloudfront-viewer-country")),
      region: decode(h("cloudfront-viewer-country-region-name")),
      city: decode(h("cloudfront-viewer-city")),
      latitude: num(h("cloudfront-viewer-latitude")),
      longitude: num(h("cloudfront-viewer-longitude")),
    };
  }
  // Google App Engine / Cloud Load Balancer
  if (h("x-appengine-country")) {
    const [lat, lon] = (h("x-appengine-citylatlong") || "").split(",");
    return {
      country: country(h("x-appengine-country")),
      region: h("x-appengine-region"),
      city: h("x-appengine-city"),
      latitude: num(lat),
      longitude: num(lon),
    };
  }
  // Cloudflare in front of a non-Worker origin (with "Add visitor location headers" managed transform)
  if (h("cf-ipcountry")) {
    return {
      country: country(h("cf-ipcountry")),
      region: decode(h("cf-region")),
      city: decode(h("cf-ipcity")),
      latitude: num(h("cf-iplatitude")),
      longitude: num(h("cf-iplongitude")),
    };
  }
  const generic = h("x-country-code") || h("x-geo-country") || h("fastly-geo-country");
  if (generic) return { country: country(generic) };
  return null;
}

export function normalizeGeo(g: GeoInfo | null | undefined): Required<GeoInfo> {
  return {
    country: country(g?.country ?? null),
    region: g?.region ? String(g.region).slice(0, 100) : null,
    city: g?.city ? String(g.city).slice(0, 100) : null,
    latitude: g?.latitude ?? null,
    longitude: g?.longitude ?? null,
  };
}

/** Rough coordinates for the centre of each country, used when the city location is unknown. */
export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  US: [39.8, -98.6], CA: [56.1, -106.3], MX: [23.6, -102.5], BR: [-14.2, -51.9], AR: [-38.4, -63.6],
  CL: [-35.7, -71.5], CO: [4.6, -74.3], PE: [-9.2, -75.0], VE: [6.4, -66.6], GB: [55.4, -3.4],
  IE: [53.4, -8.2], FR: [46.2, 2.2], DE: [51.2, 10.5], ES: [40.5, -3.7], PT: [39.4, -8.2],
  IT: [41.9, 12.6], NL: [52.1, 5.3], BE: [50.5, 4.5], CH: [46.8, 8.2], AT: [47.5, 14.6],
  SE: [60.1, 18.6], NO: [60.5, 8.5], DK: [56.3, 9.5], FI: [61.9, 25.7], PL: [51.9, 19.1],
  CZ: [49.8, 15.5], HU: [47.2, 19.5], RO: [45.9, 25.0], GR: [39.1, 21.8], TR: [38.9, 35.2],
  UA: [48.4, 31.2], RU: [61.5, 105.3], IL: [31.0, 34.9], AE: [23.4, 53.8], SA: [23.9, 45.1],
  EG: [26.8, 30.8], NG: [9.1, 8.7], KE: [-0.0, 37.9], ZA: [-30.6, 22.9], MA: [31.8, -7.1],
  IN: [20.6, 79.0], PK: [30.4, 69.3], BD: [23.7, 90.4], CN: [35.9, 104.2], JP: [36.2, 138.3],
  KR: [35.9, 127.8], TW: [23.7, 121.0], HK: [22.4, 114.1], SG: [1.35, 103.8], MY: [4.2, 102.0],
  TH: [15.9, 100.99], VN: [14.1, 108.3], PH: [12.9, 121.8], ID: [-0.8, 113.9], AU: [-25.3, 133.8],
  NZ: [-40.9, 174.9], BG: [42.7, 25.5], RS: [44.0, 21.0], HR: [45.1, 15.2], SK: [48.7, 19.7],
  SI: [46.2, 14.9], LT: [55.2, 23.9], LV: [56.9, 24.6], EE: [58.6, 25.0], IS: [64.96, -19.0],
  LK: [7.9, 80.8], NP: [28.4, 84.1], GH: [7.9, -1.0], ET: [9.1, 40.5], TN: [33.9, 9.5],
  DZ: [28.0, 1.7], QA: [25.4, 51.2], KW: [29.3, 47.5], JO: [30.6, 36.2], LB: [33.9, 35.9],
  KZ: [48.0, 66.9], UY: [-32.5, -55.8], EC: [-1.8, -78.2], BO: [-16.3, -63.6], PY: [-23.4, -58.4],
  CR: [9.7, -83.8], PA: [8.5, -80.8], DO: [18.7, -70.2], PR: [18.2, -66.6], GT: [15.8, -90.2],
  CY: [35.1, 33.4], LU: [49.8, 6.1], MT: [35.9, 14.4],
};
