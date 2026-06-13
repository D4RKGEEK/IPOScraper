# Deploy to a DigitalOcean droplet (Railway-style: `git push` → build → run)

This reproduces what Railway does for us, on a plain Ubuntu droplet:

| Railway feature        | Here                                                      |
| ---------------------- | --------------------------------------------------------- |
| Build from Dockerfile  | `docker compose build` (same `Dockerfile`)                |
| Auto-install deps      | happens inside the image build                            |
| Health check `/health` | `healthcheck:` in `docker-compose.yml`                    |
| Restart on failure     | `restart: unless-stopped`                                 |
| Deploy on push         | bare git repo + `post-receive` hook (set up once, below)  |

MongoDB stays **external** (Atlas, same `MONGODB_URI` as Railway). Nothing runs a
database on the droplet.

---

## 1. One-time droplet setup

Create a droplet (Ubuntu 24.04, the $6–12/mo basic tier is plenty). SSH in as root.

### Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

That's it — modern Docker bundles Compose (`docker compose`).

### Create the app dir, secrets, and a bare repo to push to

```bash
mkdir -p /opt/nse/app
cd /opt/nse && git init --bare repo.git
```

Create the production secrets **once** (this file is gitignored, so deploys never
touch it). Copy the values from your Railway variables:

```bash
nano /opt/nse/app/.env
```

Paste your real `MONGODB_URI`, `MONGODB_DB`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`FIRECRAWL_API_KEY`, `SERVICE_API_KEY`, `DASHBOARD_PASSWORD`, `DASHBOARD_SECRET`,
R2 keys, etc. (See `.env.example` for the full list.)

### Add the deploy hook

```bash
nano /opt/nse/repo.git/hooks/post-receive
```

Paste:

```bash
#!/usr/bin/env bash
set -euo pipefail
WORKTREE=/opt/nse/app
GIT_DIR=/opt/nse/repo.git
echo "→ checking out latest code"
git --work-tree="$WORKTREE" --git-dir="$GIT_DIR" checkout -f main
cd "$WORKTREE"
echo "→ building + restarting container"
docker compose up -d --build
docker image prune -f   # drop the old image layers
echo "✓ deployed"
```

Make it executable:

```bash
chmod +x /opt/nse/repo.git/hooks/post-receive
```

---

## 2. From your laptop — add the remote and push

```bash
git remote add do ssh://root@YOUR_DROPLET_IP/opt/nse/repo.git
git push do feat/dashboard:main
```

> The hook checks out `main`, so push your working branch onto `main`
> (`git push do feat/dashboard:main`) — or just work on `main` and `git push do main`.

That single push: uploads code → checks it out on the server → rebuilds the image
→ recreates the container → health-checks it → keeps it restarted. Exactly the
Railway loop. **Every future deploy is just `git push do main`.**

Visit `http://YOUR_DROPLET_IP/` for the dashboard, `http://YOUR_DROPLET_IP/health`
to confirm it's up.

---

## 3. Useful day-2 commands (on the droplet)

```bash
cd /opt/nse/app
docker compose ps            # status + health
docker compose logs -f api   # live logs
docker compose restart api   # manual restart
docker compose down          # stop
```

---

## 4. (Optional) HTTPS + a domain

Plain HTTP on an IP is fine for testing, but the dashboard uses login tokens, so
use TLS for real use. Easiest is Caddy (automatic Let's Encrypt). Point a domain's
A-record at the droplet, change the api port mapping to `"3001:3001"`, and add:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on: [api]
volumes:
  caddy_data:
```

`Caddyfile`:

```
your-domain.com {
    reverse_proxy api:3001
}
```

Caddy fetches and renews certificates automatically — HTTPS with zero extra steps.

---

## Notes

- **Persistent disk:** unlike Railway, a droplet's filesystem persists. `data/` and
  `/tmp/extraction` survive restarts, but the extraction cache still lives in
  MongoDB, so nothing important depends on local disk.
- **Crash safety:** `restart: unless-stopped` brings the container back after a
  crash *and* after a droplet reboot.
- **Even-simpler alternative:** DigitalOcean **App Platform** is a near-exact
  Railway clone (connect GitHub repo → it builds the Dockerfile → push-to-deploy,
  health checks, TLS, all managed). It's not a "VPS," but if you don't specifically
  want to manage a droplet, it's the closest one-to-one Railway replacement.
```
