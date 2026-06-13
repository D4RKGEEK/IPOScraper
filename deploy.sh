#!/usr/bin/env bash
#
# deploy.sh — one-command deploy to a droplet. Bootstraps a FRESH server:
#   installs Docker + git if missing, clones the repo if missing, adds swap
#   only if the box is low on RAM, then builds + runs the container.
#
# Usage (from your laptop):
#   DEPLOY_HOST=root@1.2.3.4 ./deploy.sh                 # build on the server
#   DEPLOY_HOST=root@1.2.3.4 ./deploy.sh --local-build   # build locally, ship image
#
# Overridable env:
#   DEPLOY_HOST  ssh target            (required, e.g. root@1.2.3.4)
#   REPO_URL     git url to clone      (default: this repo's origin)
#   REMOTE_DIR   path on server        (default: /opt/nse/app)
#   BRANCH       branch to deploy      (default: current branch)
#
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@YOUR_DROPLET_IP}"
REMOTE_DIR="${REMOTE_DIR:-/opt/nse/app}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
GIT_REMOTE="${GIT_REMOTE:-origin}"   # which local remote to push/clone from (e.g. github)
REPO_URL="${REPO_URL:-$(git config --get remote.$GIT_REMOTE.url || true)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-server-build}"

if [[ "$DEPLOY_HOST" == "root@YOUR_DROPLET_IP" ]]; then
  echo "✗ set your server, e.g.  DEPLOY_HOST=root@1.2.3.4 ./deploy.sh"; exit 1
fi

# ── Step 1: swap (only if the server is low on RAM and has none) ──────────────
echo "→ [1/3] checking server memory (adds swap only if needed)"
ssh "$DEPLOY_HOST" 'bash -s' < "$SCRIPT_DIR/scripts/ensure-swap.sh"

# ── Step 2: make sure the server has the latest code ──────────────────────────
if [[ "$MODE" != "--local-build" ]]; then
  if [[ -n "$REPO_URL" ]]; then
    echo "→ [2/3] pushing $BRANCH to $GIT_REMOTE so the server can pull it"
    git push "$GIT_REMOTE" "$BRANCH"
  fi
fi

# Bootstrap script that runs ON the server: installs deps, clones/updates,
# checks secrets. Args are passed positionally to avoid quoting headaches.
echo "→ [3/3] bootstrapping + deploying on $DEPLOY_HOST"
ssh "$DEPLOY_HOST" 'bash -s' -- "$REMOTE_DIR" "$REPO_URL" "$BRANCH" "$MODE" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"; REPO_URL="$2"; BRANCH="$3"; MODE="${4:-server-build}"

# Install git if missing.
if ! command -v git >/dev/null 2>&1; then
  echo "  installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi

# Install Docker (+ compose plugin) if missing.
if ! command -v docker >/dev/null 2>&1; then
  echo "  installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Clone the repo on first run, otherwise update to the target branch.
if [ ! -d "$REMOTE_DIR/.git" ]; then
  echo "  cloning $REPO_URL → $REMOTE_DIR"
  git clone "$REPO_URL" "$REMOTE_DIR"
fi
cd "$REMOTE_DIR"
git fetch origin --quiet
git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" --quiet
git reset --hard "origin/$BRANCH" --quiet

# Secrets cannot be auto-created — stop with instructions if absent.
if [ ! -f .env ]; then
  echo "✗ $REMOTE_DIR/.env is missing."
  echo "  Create it with your secrets (see .env.example), then re-run:"
  echo "    ssh $USER@<host> 'nano $REMOTE_DIR/.env'"
  exit 1
fi

# In --local-build mode the image is built on the laptop and shipped after this
# step, so just leave the server prepped (deps + code + secrets) and stop here.
if [ "$MODE" = "--local-build" ]; then
  echo "✓ server prepared (Docker, code, .env) — image will be shipped next"
  exit 0
fi

echo "  building + starting container..."
docker compose up -d --build
docker image prune -f
docker compose ps
echo "✓ deployed"
REMOTE

# ── Optional Path B: build locally and ship the image (no server build load) ──
if [[ "$MODE" == "--local-build" ]]; then
  echo "→ building image locally and shipping it (overrides the server build)"
  docker build -t nse-api .
  docker save nse-api | gzip | ssh "$DEPLOY_HOST" 'gunzip | docker load'
  ssh "$DEPLOY_HOST" "cd $REMOTE_DIR && docker compose up -d && docker image prune -f"
fi

echo "✓ done — check: curl http://${DEPLOY_HOST#*@}/health"
