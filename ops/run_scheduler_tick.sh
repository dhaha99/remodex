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
if [[ -z "${REMODEX_NODE_BIN:-}" ]]; then
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    REMODEX_NODE_BIN="/opt/homebrew/bin/node"
  elif [[ -x "/usr/local/bin/node" ]]; then
    REMODEX_NODE_BIN="/usr/local/bin/node"
  else
    REMODEX_NODE_BIN="node"
  fi
fi

export REMODEX_WORKSPACE
export REMODEX_SHARED_BASE
export REMODEX_WORKSPACE_KEY
export REMODEX_NODE_BIN

exec "$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/scripts/remodex_scheduler_tick.mjs"
