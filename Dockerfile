# Single image based on Python 3.12 (so the pymupdf4llm venv interpreter is
# guaranteed present at runtime) with Node.js 22 added on top.
#
# Why not multi-stage node + copied venv? A venv's bin/python3 is a SYMLINK to
# the Python that created it (/usr/local/bin/python3.12). Copying that venv into
# a node:22-slim image (Debian python 3.11, different path) leaves a dangling
# symlink → "spawn .../.venv/bin/python3 ENOENT". Building the venv in the same
# image that runs it avoids that entirely.
FROM python:3.12-slim

WORKDIR /app

# Node.js 22 via NodeSource (curl + gnupg needed for the setup script).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Python venv with pymupdf4llm (PyMuPDF ships cp312 wheels — no compiler needed).
COPY src/extraction/python/requirements.txt ./src/extraction/python/requirements.txt
RUN python3 -m venv /app/src/extraction/python/.venv \
    && /app/src/extraction/python/.venv/bin/pip install --no-cache-dir -r src/extraction/python/requirements.txt

# Node dependencies (production only).
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Application source.
COPY . .

# Ephemeral working directory (Railway filesystem is ephemeral).
RUN mkdir -p /tmp/extraction

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/api/server.js"]
