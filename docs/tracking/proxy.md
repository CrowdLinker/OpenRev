# Proxy the script through your domain

Ad blockers and privacy extensions often block analytics scripts loaded from a third-party domain, and some block anything served from a subdomain like `analytics.`. Blocked visitors are missing from your stats, and their payments show up without a source. Technical audiences block the most.

The fix is to serve OpenRev from your own domain. Your site forwards two paths to your OpenRev instance:

| Your site | Forwards to |
| --- | --- |
| `GET https://example.com/js/script.js` | `https://analytics.example.com/js/script.js` |
| `POST https://example.com/api/events` | `https://analytics.example.com/api/events` |

Then load the script from your own domain:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  src="/js/script.js"
></script>
```

The script sends events to `<origin of the script>/api/events`, which is now your own domain, so no extra attribute is needed.

If you use another script variant (`script.hash.js`, `script.cookieless.js`…), proxy that file instead.

## Rules every proxy must follow

1. **Keep the visitor's `User-Agent`.** OpenRev drops events whose user agent is missing, very short or looks like a bot or HTTP library (`node-fetch`, `undici`, `python-requests`, `curl`, `Go-http-client`…). Many server HTTP clients send their own user agent unless you pass the visitor's. The events endpoint then answers `{"ok":false,"reason":"bot"}`.
2. **Forward the visitor's IP in `X-Forwarded-For`.** Without it, OpenRev sees your server's IP. On self-hosted (Node/Docker) instances the IP is used to look up the country and city, so every visitor would appear to be where your server is. IP [exclusions](exclusions.md) and visitor counting in cookieless mode also depend on it. OpenRev reads the **first** address in `X-Forwarded-For`.
3. **Send the body unchanged.** It's JSON sent as `text/plain`. Mount the proxy before any body parser (`express.json()`, `express.text()`…) or forward the raw body.
4. **Don't cache `POST /api/events`.** Caching `GET /js/script.js` for up to an hour is fine.

The configs below follow these rules. Don't use the OpenRev instance's own URL as `src` anymore once the proxy works.

## Using a different path

If your app already uses `/api/events` or `/js/script.js`, pick other paths and tell the script where to send events with `data-api-url`:

```html
<script
  defer
  data-website-id="YOUR_WEBSITE_ID"
  data-domain="example.com"
  data-api-url="/_or/api/events"
  src="/_or/js/script.js"
></script>
```

Avoid words that blocklists look for, like `analytics`, `tracking` or `stats`. The examples below use the default paths; change both sides if you use different ones.

## Next.js

`next.config.js` rewrites work on Vercel and when self-hosting:

```js
// next.config.js (or next.config.ts / .mjs)
module.exports = {
  async rewrites() {
    return [
      { source: "/js/script.js", destination: "https://analytics.example.com/js/script.js" },
      { source: "/api/events", destination: "https://analytics.example.com/api/events" },
    ];
  },
};
```

If you have a `middleware.ts` (auth, i18n…), exclude these two paths from its `matcher`. After deploying, [check the location](#verify-the-proxy) of your own visit.

**Prefer explicit control?** Use a Route Handler for the events, which sets `X-Forwarded-For` and `User-Agent` itself. Keep the script rewrite above and drop the `/api/events` rewrite:

```ts
// app/api/events/route.ts
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? request.headers.get("x-real-ip") ?? "";
  const res = await fetch("https://analytics.example.com/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": request.headers.get("user-agent") ?? "",
      "X-Forwarded-For": ip,
    },
    body: await request.text(),
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}
```

## Vercel (any framework)

For non-Next.js projects on Vercel, add rewrites to `vercel.json`. Put them before any catch-all SPA rewrite:

```json
{
  "rewrites": [
    { "source": "/js/script.js", "destination": "https://analytics.example.com/js/script.js" },
    { "source": "/api/events", "destination": "https://analytics.example.com/api/events" }
  ]
}
```

## Netlify

In `public/_redirects` (or wherever your build outputs `_redirects`), above any `/*  /index.html  200` rule:

```text
/js/script.js   https://analytics.example.com/js/script.js   200!
/api/events     https://analytics.example.com/api/events     200!
```

Or in `netlify.toml`:

```toml
[[redirects]]
  from = "/js/script.js"
  to = "https://analytics.example.com/js/script.js"
  status = 200
  force = true

[[redirects]]
  from = "/api/events"
  to = "https://analytics.example.com/api/events"
  status = 200
  force = true
```

With platform rewrites (Vercel, Netlify), the platform makes the request to OpenRev. After deploying, [check the location](#verify-the-proxy) of your own visit. If every visitor shows the same location, use a function-based proxy that sets `X-Forwarded-For` explicitly, like the Next.js Route Handler above.

## Cloudflare Workers (on your site's zone)

Create a Worker and attach it to your site with two routes: `example.com/js/script.js` and `example.com/api/events`.

```js
// worker.js
const OPENREV = "https://analytics.example.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/js/script")) {
      const res = await fetch(OPENREV + url.pathname, { cf: { cacheEverything: true, cacheTtl: 3600 } });
      return new Response(res.body, res);
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      return fetch(OPENREV + "/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": request.headers.get("User-Agent") || "",
          "X-Forwarded-For": request.headers.get("CF-Connecting-IP") || "",
        },
        body: request.body,
      });
    }

    return fetch(request);
  },
};
```

Read [Where OpenRev is hosted matters](#where-openrev-is-hosted-matters) if your OpenRev instance is also on Cloudflare.

## Nginx

```nginx
server {
    server_name example.com;
    # ... your existing config

    location = /js/script.js {
        proxy_pass https://analytics.example.com/js/script.js;
        proxy_set_header Host analytics.example.com;
        proxy_ssl_server_name on;
    }

    location = /api/events {
        proxy_pass https://analytics.example.com/api/events;
        proxy_set_header Host analytics.example.com;
        proxy_ssl_server_name on;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Nginx passes the visitor's `User-Agent` through by default. If Nginx itself sits behind a load balancer, configure the `realip` module so `$remote_addr` is the visitor's address.

## Caddy

```caddyfile
example.com {
    handle /js/script.js {
        reverse_proxy https://analytics.example.com {
            header_up Host {upstream_hostport}
        }
    }
    handle /api/events {
        reverse_proxy https://analytics.example.com {
            header_up Host {upstream_hostport}
        }
    }

    # ... the rest of your site
}
```

Caddy sets `X-Forwarded-For` and keeps the `User-Agent` automatically. If Caddy is behind another proxy, list it in `trusted_proxies` so the original client IP is kept.

## Express (http-proxy-middleware)

```js
// npm install http-proxy-middleware
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

// Mount before express.json() / express.text() so the body isn't consumed.
app.use(
  createProxyMiddleware({
    target: "https://analytics.example.com",
    changeOrigin: true,
    xfwd: true, // adds X-Forwarded-For with the client IP
    pathFilter: ["/js/script.js", "/api/events"],
  }),
);

// ... your routes
```

This is for `http-proxy-middleware` v3. Use `pathFilter` rather than `app.use("/api/events", …)`: with a mount path, Express strips it and the proxy would request `/` instead. If Express runs behind a load balancer, the existing `X-Forwarded-For` is kept and your server's view of the client is appended, so the first address is still the visitor.

## PHP

Route both paths to one file, for example with Apache `.htaccess`:

```apacheconf
RewriteEngine On
RewriteRule ^js/script\.js$ openrev-proxy.php?type=script [L,QSA]
RewriteRule ^api/events$ openrev-proxy.php?type=events [L,QSA]
```

```php
<?php
// openrev-proxy.php
$openrev = 'https://analytics.example.com';

if (($_GET['type'] ?? '') === 'script') {
    header('Content-Type: application/javascript');
    header('Cache-Control: public, max-age=3600');
    echo file_get_contents($openrev . '/js/script.js');
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit;
}

// Behind Cloudflare, REMOTE_ADDR is Cloudflare's IP; the visitor is in CF-Connecting-IP.
$ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'];

$ch = curl_init($openrev . '/api/events');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => file_get_contents('php://input'),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 5,
    CURLOPT_HTTPHEADER => [
        'Content-Type: text/plain',
        'User-Agent: ' . ($_SERVER['HTTP_USER_AGENT'] ?? ''),
        'X-Forwarded-For: ' . $ip,
    ],
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE) ?: 502;
curl_close($ch);

http_response_code($status);
header('Content-Type: application/json');
echo $body;
```

## Laravel

```php
// routes/web.php
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;

Route::get('/js/script.js', function () {
    $js = Cache::remember('openrev-script', 3600, fn () =>
        Http::get('https://analytics.example.com/js/script.js')->throw()->body());

    return response($js, 200, [
        'Content-Type' => 'application/javascript',
        'Cache-Control' => 'public, max-age=3600',
    ]);
});

Route::post('/api/events', function (Request $request) {
    $res = Http::withHeaders([
            'User-Agent' => $request->userAgent() ?? '',
            'X-Forwarded-For' => $request->ip(),
        ])
        ->withBody($request->getContent(), 'text/plain')
        ->timeout(5)
        ->post('https://analytics.example.com/api/events');

    return response($res->body(), $res->status())->header('Content-Type', 'application/json');
});
```

Exclude the events route from CSRF protection. In Laravel 11+:

```php
// bootstrap/app.php
->withMiddleware(function (Middleware $middleware) {
    $middleware->validateCsrfTokens(except: ['api/events']);
})
```

In Laravel 10 and earlier, add `'api/events'` to `$except` in `app/Http/Middleware/VerifyCsrfToken.php`. If your app is behind a load balancer, configure trusted proxies so `$request->ip()` returns the visitor's IP.

## Django

```python
# views.py
import requests
from django.http import HttpResponse
from django.views.decorators.cache import cache_page
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

OPENREV = "https://analytics.example.com"


def client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return forwarded.split(",")[0].strip() if forwarded else request.META.get("REMOTE_ADDR", "")


@cache_page(60 * 60)
def openrev_script(request):
    r = requests.get(f"{OPENREV}/js/script.js", timeout=5)
    return HttpResponse(r.content, status=r.status_code, content_type="application/javascript")


@csrf_exempt
@require_POST
def openrev_events(request):
    r = requests.post(
        f"{OPENREV}/api/events",
        data=request.body,
        headers={
            "Content-Type": "text/plain",
            "User-Agent": request.META.get("HTTP_USER_AGENT", ""),
            "X-Forwarded-For": client_ip(request),
        },
        timeout=5,
    )
    return HttpResponse(r.content, status=r.status_code, content_type="application/json")
```

```python
# urls.py
from django.urls import path
from . import views

urlpatterns = [
    path("js/script.js", views.openrev_script),
    path("api/events", views.openrev_events),
    # ...
]
```

Only trust `X-Forwarded-For` if your app is behind a proxy that sets it; otherwise use `REMOTE_ADDR`.

## Flask

```python
import requests
from flask import Flask, Response, request

app = Flask(__name__)
OPENREV = "https://analytics.example.com"


@app.get("/js/script.js")
def openrev_script():
    r = requests.get(f"{OPENREV}/js/script.js", timeout=5)
    return Response(r.content, status=r.status_code, mimetype="application/javascript",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.post("/api/events")
def openrev_events():
    ip = (request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or request.remote_addr or "")
    r = requests.post(
        f"{OPENREV}/api/events",
        data=request.get_data(),
        headers={
            "Content-Type": "text/plain",
            "User-Agent": request.headers.get("User-Agent", ""),
            "X-Forwarded-For": ip,
        },
        timeout=5,
    )
    return Response(r.content, status=r.status_code, mimetype="application/json")
```

## FastAPI

```python
import httpx
from fastapi import FastAPI, Request, Response

app = FastAPI()
OPENREV = "https://analytics.example.com"


@app.get("/js/script.js")
async def openrev_script():
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.get(f"{OPENREV}/js/script.js")
    return Response(r.content, status_code=r.status_code, media_type="application/javascript",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.post("/api/events")
async def openrev_events(request: Request):
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "")
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.post(
            f"{OPENREV}/api/events",
            content=await request.body(),
            headers={
                "Content-Type": "text/plain",
                "User-Agent": request.headers.get("user-agent", ""),
                "X-Forwarded-For": ip,
            },
        )
    return Response(r.content, status_code=r.status_code, media_type="application/json")
```

## Astro

On Vercel, Netlify or Cloudflare you can use the platform rewrites above. With an SSR adapter (`output: "server"`, or `prerender = false` on these routes), add two endpoints:

```ts
// src/pages/api/events.ts
import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const res = await fetch("https://analytics.example.com/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": request.headers.get("user-agent") ?? "",
      "X-Forwarded-For": clientAddress,
    },
    body: await request.text(),
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
};
```

```ts
// src/pages/js/script.js.ts
import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async () => {
  const res = await fetch("https://analytics.example.com/js/script.js");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" },
  });
};
```

## Verify the proxy

1. Open your site and the devtools **Network** tab. The script should load from `https://example.com/js/script.js` and events should go to `https://example.com/api/events`, answering `202` with `{"ok":true}`.
2. `{"ok":false,"reason":"bot"}` means the `User-Agent` wasn't forwarded.
3. Open **Realtime** in OpenRev: your visit should show your own country and city. If it shows your server's or hosting provider's location, the visitor IP isn't reaching OpenRev (see below).
4. Turn on an ad blocker (uBlock Origin, Brave Shields) and check that events still go through.

## Where OpenRev is hosted matters

How OpenRev finds the visitor's IP (on Node, only when `TRUST_PROXY` isn't `false`):

1. the **first** address in `X-Forwarded-For` — the original visitor, even when your proxy or Cloudflare appended their own address;
2. otherwise `CF-Connecting-IP`, `True-Client-IP`, `Fly-Client-IP` or `X-Real-IP`;
3. otherwise the address of the TCP connection.

A request counts as **proxied** when that first `X-Forwarded-For` address differs from the address of the edge connection (`CF-Connecting-IP` & co.). For proxied requests OpenRev ignores location data that describes the connection (Cloudflare's `request.cf` and `CF-IPCountry`), because it would be your proxy's location.

How it finds the location:

- **Node / Docker:** looks up the visitor IP in the local geolocation database (DB-IP Lite or your MaxMind file). Forwarding the IP is all you need.
- **Cloudflare Workers:** uses Cloudflare's location for direct visits. For proxied visits Workers can't look up an arbitrary IP, so pass the location from your proxy with these headers (all optional except the country):

  | Header | Example |
  |---|---|
  | `X-OpenRev-Country` | `DE` (ISO 3166-1 alpha-2) |
  | `X-OpenRev-Region` | `Berlin` |
  | `X-OpenRev-City` | `Berlin` |
  | `X-OpenRev-Latitude` / `X-OpenRev-Longitude` | `52.52` / `13.40` |

  A proxy running on Cloudflare (the Worker example above) can fill them from `request.cf`:

  ```js
  headers: {
    "Content-Type": "text/plain",
    "User-Agent": request.headers.get("User-Agent") || "",
    "X-Forwarded-For": request.headers.get("CF-Connecting-IP") || "",
    "X-OpenRev-Country": request.cf?.country || "",
    "X-OpenRev-Region": request.cf?.region || "",
    "X-OpenRev-City": request.cf?.city || "",
    "X-OpenRev-Latitude": String(request.cf?.latitude ?? ""),
    "X-OpenRev-Longitude": String(request.cf?.longitude ?? ""),
  },
  ```

  On Vercel, forward `x-vercel-ip-country`, `x-vercel-ip-country-region`, `x-vercel-ip-city`, `x-vercel-ip-latitude` and `x-vercel-ip-longitude` from your Route Handler instead — OpenRev understands those too. Without any of these headers, proxied visits are recorded without a location (rather than with your proxy's).

If a proxy doesn't forward the IP at all, fix its config with one of the examples above.
