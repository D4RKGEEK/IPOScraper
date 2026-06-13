# ── Stage 1: Build Python venv with pymupdf4llm ──────────────────────────────
FROM python:3.12-slim AS python-deps
WORKDIR /build
COPY src/extraction/python/requirements.txt .
RUN python3 -m venv /build/.venv \
    && /build/.venv/bin/pip install --no-cache-dir -r requirements.txt

# ── Stage 2: Node.js application ─────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# Install Python 3 (needed to run the venv interpreter)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Copy Python venv from stage 1
COPY --from=python-deps /build/.venv /app/src/extraction/python/.venv

# Install Node dependencies (production only)
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source
COPY . .

# Create ephemeral working directories
RUN mkdir -p /tmp/extraction

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/api/server.js"]
