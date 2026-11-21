#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

# Post-deploy smoke check. SMOKE_URL is supplied by the release environment.
: "${SMOKE_URL:?SMOKE_URL is required}"

for attempt in $(seq 1 12); do
  if curl -fsS --max-time 10 "${SMOKE_URL%/}/health" | grep -q '"ok"'; then
    echo "smoke: ${SMOKE_URL} is healthy"
    exit 0
  fi
  echo "smoke: attempt ${attempt} failed; retrying"
  sleep 5
done

echo "smoke: ${SMOKE_URL} did not become healthy" >&2
exit 1
