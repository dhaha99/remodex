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
: "${REMODEX_NODE_BIN:=/opt/homebrew/bin/node}"

export REMODEX_WORKSPACE
export REMODEX_SHARED_BASE
export REMODEX_WORKSPACE_KEY

exec "$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/scripts/remodex_scheduler_tick.mjs"

