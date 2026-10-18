# DevRoot: UI build + API with embedded FalkorDB (falkordblite wheels need glibc >= 2.39 → Debian trixie)
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npx vite build

FROM python:3.12-slim-trixie
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=ui /ui/dist frontend/dist
# Ephemeral by design: the deterministic seed is re-loaded on every start; set FALKORDB_URL for a persistent server.
ENV DEVROOT_DB_PATH=/tmp/devroot/devroot.db
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn devroot.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
