# Run OpenRev with Node.js

Requirements: **Node.js 22.13+** (OpenRev uses the built-in `node:sqlite` module, so there are no native dependencies to compile) and git.

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash -s -- --target node
```

## Manually

```bash
git clone https://github.com/CrowdLinker/OpenRev.git && cd OpenRev
npm install
npm run build
cp .env.example .env          # set PUBLIC_URL and OPENREV_SECRET
npm start                     # reads .env, listens on PORT (default 3000)
```

By default data is stored in `./data/openrev.db` (SQLite). For PostgreSQL set `DATABASE_URL=postgres://user:password@host:5432/openrev`.

## Keep it running

### systemd

```ini
# /etc/systemd/system/openrev.service
[Unit]
Description=OpenRev analytics
After=network.target

[Service]
WorkingDirectory=/opt/openrev
ExecStart=/usr/bin/node --env-file=/opt/openrev/.env dist/server/node.js
Restart=always
User=openrev

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now openrev
```

### pm2

```bash
pm2 start "npm start" --name openrev && pm2 save
```

Put a reverse proxy with HTTPS in front (see [docker.md](docker.md#https-with-a-reverse-proxy)).

## Updating

```bash
npm run update    # git pull, npm install, npm run build — then restart the process
```
