#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .dev.vars ]; then
    cp .dev.vars.example .dev.vars
fi

rm -rf .wrangler/e2e-state
exec pnpm exec playwright test "$@"
