#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "$0")" && pwd)
WORKSPACE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${REMODEX_ENV_FILE:-$WORKSPACE_DIR/ops/remodex.env}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${REMODEX_WORKSPACE:=$WORKSPACE_DIR}"
: "${REMODEX_NODE_BIN:=/opt/homebrew/bin/node}"

export REMODEX_WORKSPACE
export REMODEX_NODE_BIN
export REMODEX_ENV_FILE="$ENV_FILE"

"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/render_launchd_plists.mjs"

mkdir -p "$LAUNCH_AGENTS_DIR"
cp "$REMODEX_WORKSPACE/ops/launchd/generated/"*.plist "$LAUNCH_AGENTS_DIR/"

echo "Generated plists copied to $LAUNCH_AGENTS_DIR"
echo "Load bridge daemon:"
echo "launchctl bootstrap gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}.bridge-daemon.plist\""
echo "Load scheduler tick:"
echo "launchctl bootstrap gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}.scheduler-tick.plist\""

