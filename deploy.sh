#!/usr/bin/env bash
#
# deploy.sh — one-command deploy to a droplet. Bootstraps a FRESH server:
#   installs Docker + git if missing, clones the repo if missing, adds swap
#   only if the box is low on RAM, then builds + runs the container.
#
# Usage (from your laptop):
#   DEPLOY_HOST=root@1.2.3.4 ./deploy.sh                 # build on the server
#   DEPLOY_HOST=root@1.2.3.4 ./deploy.sh --with-env      # ALSO upload your local .env
#   DEPLOY_HOST=root@1.2.3.4 ./deploy.sh --local-build   # build locally, ship image
#   (flags combine, e.g. ./deploy.sh --local-build --with-env)
#
# Overridable env:
#   DEPLOY_HOST  ssh target            (required, e.g. root@1.2.3.4)
#   GIT_REMOTE   local remote to use   (default: origin; e.g. github)
#   REPO_URL     git url to clone      (default: that remote's url)
#   REMOTE_DIR   path on server        (default: /opt/nse/app)
#   BRANCH       branch to deploy      (default: current branch)
#
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@YOUR_DROPLET_IP}"
REMOTE_DIR="${REMOTE_DIR:-/opt/nse/app}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
APP_PORT="${APP_PORT:-1234}"   # host port the container publishes (see docker-compose.yml)
REPO_URL="${REPO_URL:-$(git config --get remote.$GIT_REMOTE.url || true)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_ONLY="${DEPLOY_HOST#*@}"

# ── flags ─────────────────────────────────────────────────────────────────────
BUILD_MODE="server"   # server | local
WITH_ENV=0            # upload local .env to the server?
for a in "$@"; do
  case "$a" in
    --local-build) BUILD_MODE="local" ;;
    --with-env)    WITH_ENV=1 ;;
    *) printf 'unknown option: %s\n' "$a"; exit 1 ;;
  esac
done

# ── pretty logging (color only when attached to a terminal) ───────────────────
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  CY=$'\033[1;36m'; GR=$'\033[1;32m'; YL=$'\033[1;33m'; RD=$'\033[1;31m'
else
  B=; DIM=; R=; CY=; GR=; YL=; RD=
fi
step() { printf '\n%s▶ %s%s\n' "$CY" "$*" "$R"; }
info() { printf '  %s%s%s\n' "$DIM" "$*" "$R"; }
ok()   { printf '  %s✓ %s%s\n' "$GR" "$*" "$R"; }
warn() { printf '  %s! %s%s\n' "$YL" "$*" "$R"; }
die()  { printf '\n%s✗ %s%s\n' "$RD" "$*" "$R"; exit 1; }

[[ "$DEPLOY_HOST" == "root@YOUR_DROPLET_IP" ]] && die "set your server, e.g.  DEPLOY_HOST=root@1.2.3.4 ./deploy.sh"
[[ "$WITH_ENV" == 1 && ! -f "$SCRIPT_DIR/.env" ]] && die "--with-env given but no local .env found at $SCRIPT_DIR/.env"

# ── banner ────────────────────────────────────────────────────────────────────
printf '%s┌─ deploy ─────────────────────────────────────%s\n' "$B" "$R"
printf '%s│%s target  %s\n'        "$B" "$R" "$DEPLOY_HOST"
printf '%s│%s branch  %s\n'        "$B" "$R" "$BRANCH"
printf '%s│%s source  %s (%s)\n'   "$B" "$R" "${REPO_URL:-<none>}" "$GIT_REMOTE"
printf '%s│%s build   %s\n'        "$B" "$R" "$BUILD_MODE"
printf '%s│%s .env    %s\n'        "$B" "$R" "$([[ $WITH_ENV == 1 ]] && echo 'upload local .env' || echo 'use server .env (ask if missing)')"
printf '%s└──────────────────────────────────────────────%s\n' "$B" "$R"

# ── Step 1: swap (only if the server is low on RAM and has none) ──────────────
step "1/6  Server memory — add swap only if needed"
ssh "$DEPLOY_HOST" 'bash -s' < "$SCRIPT_DIR/scripts/ensure-swap.sh" 2>&1 | sed 's/^/  /'

# ── Step 2: push latest code to the chosen remote ────────────────────────────
step "2/6  Push code to $GIT_REMOTE"
if [[ "$BUILD_MODE" == "local" ]]; then
  info "skipped (image is built locally and shipped over SSH)"
elif [[ -n "$REPO_URL" ]]; then
  git push "$GIT_REMOTE" "$BRANCH" 2>&1 | sed 's/^/  /'
  ok "pushed $BRANCH"
else
  warn "no remote url found — server will use whatever it already has"
fi

# ── Step 3: upload local .env (only with --with-env) ─────────────────────────
step "3/6  Secrets"
if [[ "$WITH_ENV" == 1 ]]; then
  warn "uploading your LOCAL .env — make sure it holds PRODUCTION values, not dev (e.g. real MONGODB_URI)"
  # Stage in /tmp (always exists, won't clash with the clone); bootstrap moves it into place.
  scp -q "$SCRIPT_DIR/.env" "$DEPLOY_HOST:/tmp/nse_deploy.env"
  ok "local .env staged for upload"
else
  info "using the server's own .env (deploy stops with instructions if it's missing)"
fi

# ── Steps 4–5: bootstrap server (deps + code + secrets) then build/run ───────
step "4/6  Bootstrap server (install deps, sync code)  +  5/6  Build & start"
ssh "$DEPLOY_HOST" 'bash -s' -- "$REMOTE_DIR" "$REPO_URL" "$BRANCH" "$BUILD_MODE" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"; REPO_URL="$2"; BRANCH="$3"; BUILD_MODE="${4:-server}"
say() { printf '  %s\n' "$*"; }
rok() { printf '  ✓ %s\n' "$*"; }

# git
if command -v git >/dev/null 2>&1; then rok "git present"
else say "installing git..."; apt-get update -qq && apt-get install -y -qq git && rok "git installed"; fi

# docker (+ compose plugin)
if command -v docker >/dev/null 2>&1; then rok "Docker present ($(docker --version | cut -d' ' -f3 | tr -d ,))"
else say "installing Docker (~30s)..."; curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 && rok "Docker installed"; fi

# code: clone on first run, otherwise update to the target branch
if [ ! -d "$REMOTE_DIR/.git" ]; then
  say "cloning $REPO_URL → $REMOTE_DIR"; git clone --quiet "$REPO_URL" "$REMOTE_DIR" && rok "cloned"
else rok "repo present at $REMOTE_DIR"; fi
cd "$REMOTE_DIR"
git fetch origin --quiet
git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" --quiet
git reset --hard "origin/$BRANCH" --quiet
rok "code at $(git rev-parse --short HEAD) ($BRANCH)"

# if a .env was uploaded from the laptop, move it into place now (post-clone)
if [ -f /tmp/nse_deploy.env ]; then
  mv /tmp/nse_deploy.env "$REMOTE_DIR/.env"; chmod 600 "$REMOTE_DIR/.env"
  rok "installed .env uploaded from your machine"
fi

# secrets must exist by now (uploaded above, or already on the server)
if [ ! -f .env ]; then
  echo "✗ $REMOTE_DIR/.env is missing."
  echo "  Either re-run with --with-env (uploads your local .env),"
  echo "  or create it on the server:  ssh root@<host> 'nano $REMOTE_DIR/.env'"
  exit 1
fi
rok ".env present"

if [ "$BUILD_MODE" = "local" ]; then
  rok "server prepared — image will be shipped next"; exit 0
fi

# open the published port in ufw if the firewall is active (no-op otherwise)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 1234/tcp >/dev/null 2>&1 && rok "ufw: port 1234 open"
fi

say "building image + (re)starting container..."
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true
rok "container up:"
docker compose ps --format '  {{.Service}}\t{{.Status}}' 2>/dev/null || docker compose ps
REMOTE

# ── Path B: build locally and ship the image ─────────────────────────────────
if [[ "$BUILD_MODE" == "local" ]]; then
  step "5/6  Build image locally + ship it"
  docker build -t nse-api . 2>&1 | sed 's/^/  /'
  info "shipping image over SSH (compressed)..."
  docker save nse-api | gzip | ssh "$DEPLOY_HOST" 'gunzip | docker load' 2>&1 | sed 's/^/  /'
  ssh "$DEPLOY_HOST" "cd $REMOTE_DIR && docker compose up -d && docker image prune -f >/dev/null 2>&1 || true"
  ok "image deployed"
fi

# ── Step 6: health check ──────────────────────────────────────────────────────
step "6/6  Health check  http://$HOST_ONLY:$APP_PORT/health"
if curl -fsS --max-time 10 "http://$HOST_ONLY:$APP_PORT/health" >/dev/null 2>&1; then
  ok "service is healthy"
  printf '\n%s✓ deploy complete in %ss%s — http://%s:%s/\n' "$GR" "$SECONDS" "$R" "$HOST_ONLY" "$APP_PORT"
else
  warn "no healthy response yet (the container may still be starting)"
  info "check logs:  ssh $DEPLOY_HOST 'cd $REMOTE_DIR && docker compose logs -f api'"
fi
