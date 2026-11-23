#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Deploy Saldima with the same path locally, on staging and in production.
#
#   ./scripts/deploy.sh local                 # wrangler dev on *.localhost:8787
#   ./scripts/deploy.sh dev [--skip-checks]   # auto-deployed by CI on main
#   ./scripts/deploy.sh staging [--dry-run]   # deploy the staging environment
#   ./scripts/deploy.sh production --yes      # owner-approved production deploy
#
# The token is read from $CLOUDFLARE_API_TOKEN, ~/.saldima-cf-token or
# ~/.salima-cf-token. Never commit or echo it.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
DRY_RUN=0
CONFIRM=0
SKIP_CHECKS=0
for arg in "${@:2}"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --yes) CONFIRM=1 ;;
        --skip-checks) SKIP_CHECKS=1 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

if [ -z "$TARGET" ]; then
    sed -n '4,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

if [ "$TARGET" = "local" ]; then
    exec ./scripts/dev.sh
fi

if [ "$TARGET" != "dev" ] && [ "$TARGET" != "staging" ] && [ "$TARGET" != "production" ]; then
    echo "Unknown target: $TARGET (use local, dev, staging or production)" >&2
    exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    for candidate in "$HOME/.saldima-cf-token" "$HOME/.salima-cf-token"; do
        if [ -f "$candidate" ]; then
            CLOUDFLARE_API_TOKEN="$(cat "$candidate")"
            break
        fi
    done
fi
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN or create ~/.saldima-cf-token}"
export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-c589b687de910faa1e453b0c1afb4f8c}"

if [ "$TARGET" = "production" ] && [ "$DRY_RUN" -eq 0 ]; then
    if [ "$CONFIRM" -ne 1 ] && [ "${CONFIRM_PRODUCTION:-}" != "DEPLOY" ]; then
        echo "Refusing production deploy without --yes or CONFIRM_PRODUCTION=DEPLOY." >&2
        exit 1
    fi
fi

if [ "$DRY_RUN" -eq 0 ] && [ "$SKIP_CHECKS" -eq 0 ]; then
    echo "==> Typecheck, lint and unit tests"
    pnpm typecheck
    pnpm lint
    pnpm test:unit
fi

echo "==> Building $TARGET configuration"
if [ "$DRY_RUN" -eq 1 ]; then
    pnpm exec wrangler deploy --env "$TARGET" --dry-run
    exit 0
fi

echo "==> Deploying $TARGET"
pnpm exec wrangler deploy --env "$TARGET"

if [ "$TARGET" = "dev" ] || [ "$TARGET" = "staging" ]; then
    if [ "$TARGET" = "dev" ]; then
        PREFIX="dev"
        ALICE="alice-dev.saldima.com"
        BOB="bob-dev.saldima.com"
    else
        PREFIX="stage"
        ALICE="alice-stage.saldima.com"
        BOB="bob-stage.saldima.com"
    fi

    echo "==> Seeding $TARGET demo tenants"
    pnpm exec wrangler kv key put --binding KV --env "$TARGET" --remote \
        "host:$ALICE" "tenant-alice" >/dev/null
    pnpm exec wrangler kv key put --binding KV --env "$TARGET" --remote \
        "host:$BOB" "tenant-bob" >/dev/null

    echo "==> Smoke-testing $TARGET"
    curl -fsS --max-time 20 "https://$PREFIX.saldima.com/health" | grep -q '"ok":true'
    curl -fsS --max-time 20 "https://$ALICE/health" | grep -q 'tenant-alice'
    curl -fsS --max-time 20 "https://$BOB/health" | grep -q 'tenant-bob'
    echo "$TARGET: https://$PREFIX.saldima.com"
    echo "alice: https://$ALICE"
    echo "bob:   https://$BOB"
else
    echo "==> Smoke-testing production"
    curl -fsS --max-time 20 https://saldima.com/health | grep -q '"ok":true'
    echo "production: https://saldima.com"
fi
