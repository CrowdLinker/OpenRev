# Deploy OpenRev with Docker

The Docker image runs the Node.js server with SQLite by default (zero setup) or PostgreSQL. It works on any VPS (Hetzner, DigitalOcean, Linode, AWS Lightsail…), home server, or PaaS that runs containers (Coolify, CapRover, Dokku, Railway, Render, Fly.io).

Image: `ghcr.io/crowdlinker/openrev:latest` (linux/amd64 and linux/arm64), built from [`Dockerfile`](../../Dockerfile).

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash -s -- --target docker
```

The wizard asks for your public URL, port and database (SQLite or bundled PostgreSQL), writes `.env` with a random `OPENREV_SECRET`, and runs `docker compose up -d`. `.env` and `.openrev.json` (the wizard's answers, used by `npm run update`) are created readable by your user only (mode `0600`). Values containing `#`, spaces or quotes, such as a database password, are quoted in `.env` so they're read back unchanged.

## docker run

```bash
docker run -d --name openrev --restart unless-stopped \
  -p 3000:3000 \
  -v openrev-data:/data \
  -e PUBLIC_URL=https://analytics.example.com \
  -e OPENREV_SECRET=$(openssl rand -hex 32) \
  ghcr.io/crowdlinker/openrev:latest
```

Everything (SQLite database, generated secrets, geolocation database) lives in the `/data` volume — back it up. An `OPENREV_SECRET` you set yourself (with `-e` or in `.env`) isn't in the volume: keep it with your backups and pass the same value when you recreate the container, or the stored payment-provider credentials can't be decrypted.

## Docker Compose

SQLite ([`docker-compose.yml`](../../docker-compose.yml)):

```bash
git clone https://github.com/CrowdLinker/OpenRev.git && cd OpenRev
cp .env.example .env    # set PUBLIC_URL and OPENREV_SECRET
docker compose up -d
```

PostgreSQL ([`docker-compose.postgres.yml`](../../docker-compose.postgres.yml)):

```bash
docker compose -f docker-compose.postgres.yml up -d
```

To use an existing PostgreSQL server (Neon, Supabase, RDS…), set `DATABASE_URL=postgres://user:password@host:5432/db?sslmode=require` (or `sslmode=verify-full` to also verify the server certificate, see [configuration](configuration.md)).

## HTTPS with a reverse proxy

Run OpenRev behind a TLS-terminating proxy. With [Caddy](https://caddyserver.com) (automatic HTTPS):

```caddy
analytics.example.com {
  reverse_proxy localhost:3000
}
```

With Nginx:

```nginx
server {
  server_name analytics.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

OpenRev reads the visitor IP from `X-Forwarded-For` (set `TRUST_PROXY=false` if the container is exposed directly to the internet without a proxy). Behind Cloudflare's proxy, the `CF-Connecting-IP` and `CF-IPCountry` headers are used automatically. Login rate limits use the connection's address, or, when the connection comes from a private or loopback address (a proxy on the same host or Docker network), the address that proxy appends (the last `X-Forwarded-For` entry). If untrusted clients can also reach the container from the same private network, set `TRUST_PROXY` to the address your proxy connects from (for example `TRUST_PROXY=172.18.0.1`, or a CIDR such as `10.0.0.0/24`; separate several with commas) so only that proxy is trusted. If another proxy such as Cloudflare sits in front of Nginx, set up Nginx's `realip` module so that address is the visitor's.

## Geolocation

On first start the container downloads the free [DB-IP Lite](https://db-ip.com/db/lite.php) city database (~130 MB) into `/data` and refreshes it monthly. To use MaxMind GeoLite2 instead, mount the `.mmdb` file and set `GEOIP_DB=/data/GeoLite2-City.mmdb`. Disable with `GEOIP_AUTO_DOWNLOAD=false`.

## Updating

```bash
docker compose pull && docker compose up -d     # or: npm run update
```

Migrations run automatically at startup.

## Health check

`GET /api/health` returns `{"ok":true}`. The image defines a Docker `HEALTHCHECK`.
