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
: "${REMODEX_DISCORD_LIVE_PROOF_DIR:=$REMODEX_WORKSPACE/runtime/live-discord-proof}"
: "${REMODEX_DISCORD_LIVE_PROOF_REGISTER_COMMANDS:=true}"
: "${REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION:=false}"
: "${REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS:=120000}"

export REMODEX_WORKSPACE
export REMODEX_SHARED_BASE
export REMODEX_WORKSPACE_KEY
export REMODEX_NODE_BIN
export REMODEX_DISCORD_LIVE_PROOF_DIR
export REMODEX_DISCORD_LIVE_PROOF_REGISTER_COMMANDS
export REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION
export REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS

runner_status=0
"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/run_discord_gateway_live_proof.mjs" || runner_status=$?

finalize_status=0
"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/finalize_discord_gateway_live_proof.mjs" || finalize_status=$?

if [[ $runner_status -ne 0 ]]; then
  exit $runner_status
fi

exit $finalize_status
