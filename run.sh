#!/usr/bin/env bash
# DevRoot one-command start: installs deps if missing, builds the UI, starts API + UI on :8000.
set -euo pipefail
cd "$(dirname "$0")"
[ -d .venv ] || { uv venv -q --python 3.12 .venv 2>/dev/null || python3.12 -m venv .venv; }
.venv/bin/python -c "import fastapi, falkordb, redislite" 2>/dev/null || {
  if command -v uv >/dev/null; then uv pip install -q --python .venv/bin/python -r backend/requirements.txt
  else .venv/bin/pip install -q -r backend/requirements.txt; fi; }
[ -d frontend/node_modules ] || (cd frontend && npm ci --silent)
(cd frontend && npx vite build --logLevel warn)
cd backend && exec ../.venv/bin/uvicorn devroot.app:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
