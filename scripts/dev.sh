#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .dev.vars ]; then
    cp .dev.vars.example .dev.vars
    echo "dev: created .dev.vars from .dev.vars.example (local only)"
fi

pnpm build:client

exec pnpm exec wrangler dev --ip :: "$@"
