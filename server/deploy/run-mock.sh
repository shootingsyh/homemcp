#!/usr/bin/env bash
# Standalone MOCK tunneld instance for HomeMCP client development.
#
# Replaces the old docker-compose.mock.yml profile (removed when the
# server went bare-metal). Runs tunneld in the foreground with mock
# pay enabled: enrollments return a /mock-pay/<id> checkout URL on
# this same origin, and subscription lifecycle is driven by the
# admin subscription-event hook. NO frps, NO Stripe, NO real charges.
#
# Usage:
#   cp .env.mock.example .env.mock   # set API_PUBLIC_BASE + TUNNELD_ADMIN_KEY
#   ./deploy/run-mock.sh             # build tunneld if needed, then run
#   TUNNELD_BIN=/path/to/tunneld ./deploy/run-mock.sh   # use a prebuilt binary
#
# WARNING: never expose a mock instance as the production API. Anyone
# with an enrollment link can activate an account for free.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env.mock ]]; then
  set -a; # shellcheck disable=SC1091
  source .env.mock; set +a
fi
: "${API_PUBLIC_BASE:?Set API_PUBLIC_BASE in .env.mock (base URL the client dev machine reaches)}"
: "${TUNNELD_ADMIN_KEY:?Set TUNNELD_ADMIN_KEY in .env.mock (openssl rand -hex 32)}"

BIN="${TUNNELD_BIN:-./tunneld-bin}"
if [[ ! -x "$BIN" ]]; then
  if [[ -n "${TUNNELD_BIN:-}" ]]; then
    echo "TUNNELD_BIN=$BIN is not executable" >&2; exit 1
  fi
  echo "Building tunneld -> $BIN"
  (cd tunneld && go build -trimpath -o ../tunneld-bin .)
fi

export TUNNELD_MOCK_PAY=1
export TUNNELD_LISTEN="0.0.0.0:${MOCK_PORT:-7200}"
export TUNNELD_STORE_PATH="${MOCK_STORE_PATH:-./tunneld-mock.json}"
export TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-tunnel.homemcp.si}"
echo "MOCK tunneld on ${TUNNELD_LISTEN} (API_PUBLIC_BASE=${API_PUBLIC_BASE}) — NOT FOR PRODUCTION"
exec "$BIN"
