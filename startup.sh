#!/bin/sh
set -eu
cd /workspace

# Prefer the deployable Node demo host on 0.0.0.0:8080 (Vercel entrypoint parity).
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/healthz; then
  exit 0
fi
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  # Something is on 8080 but not our healthz — leave it if it's already serving.
  exit 0
fi

export HOST=0.0.0.0
export PORT=8080
export FORCE_LISTEN=1
# Build SPA if missing
if [ ! -f public/index.html ]; then
  pnpm build >>/tmp/app-startup.log 2>&1 || npm run build >>/tmp/app-startup.log 2>&1 || true
fi
node server.mjs >>/tmp/app-startup.log 2>&1 &
i=0
while [ "$i" -lt 40 ]; do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/healthz; then
    exit 0
  fi
  i=$((i + 1))
  sleep 0.25
done
exit 1
