#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "$0")" && pwd)
WORKSPACE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${REMODEX_ENV_FILE:-$WORKSPACE_DIR/ops/remodex.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${REMODEX_WORKSPACE:=$WORKSPACE_DIR}"
: "${REMODEX_SHARED_BASE:=$REMODEX_WORKSPACE/runtime/external-shared-memory}"
: "${REMODEX_WORKSPACE_KEY:=remodex}"
: "${REMODEX_NODE_BIN:=node}"
: "${REMODEX_DISCORD_GATEWAY_URL:=wss://gateway.discord.gg/?v=10&encoding=json}"
: "${REMODEX_DISCORD_GATEWAY_INTENTS:=0}"
: "${REMODEX_DISCORD_API_BASE_URL:=https://discord.com/api/v10}"

if [[ -z "${REMODEX_DISCORD_BOT_TOKEN:-}" && -z "${REMODEX_DISCORD_BOT_TOKEN_PATH:-}" ]]; then
  echo "REMODEX_DISCORD_BOT_TOKEN or REMODEX_DISCORD_BOT_TOKEN_PATH is required" >&2
  exit 1
fi

export REMODEX_WORKSPACE
export REMODEX_SHARED_BASE
export REMODEX_WORKSPACE_KEY
export REMODEX_NODE_BIN
export REMODEX_DISCORD_GATEWAY_URL
export REMODEX_DISCORD_GATEWAY_INTENTS
export REMODEX_DISCORD_API_BASE_URL
export REMODEX_DISCORD_BOT_TOKEN
export REMODEX_DISCORD_BOT_TOKEN_PATH

exec "$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/scripts/remodex_discord_gateway_adapter.mjs"
