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
: "${REMODEX_NODE_BIN:=node}"
: "${REMODEX_SCHEDULER_KIND:=launchd_launchagent}"

export REMODEX_WORKSPACE
export REMODEX_NODE_BIN
export REMODEX_ENV_FILE="$ENV_FILE"
export REMODEX_SCHEDULER_KIND
export REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER="${REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER:-false}"

if [[ "$REMODEX_SCHEDULER_KIND" != "launchd_launchagent" ]]; then
  echo "install_launchd_services.sh only supports REMODEX_SCHEDULER_KIND=launchd_launchagent" >&2
  exit 1
fi

"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/render_scheduler_artifacts.mjs"

mkdir -p "$LAUNCH_AGENTS_DIR"
cp "$REMODEX_WORKSPACE/ops/launchd/generated/"*.plist "$LAUNCH_AGENTS_DIR/"

echo "Generated plists copied to $LAUNCH_AGENTS_DIR"
echo "Load bridge daemon:"
echo "launchctl bootstrap gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}.bridge-daemon.plist\""
echo "Load scheduler tick:"
echo "launchctl bootstrap gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}.scheduler-tick.plist\""
if [[ "${REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER:-false}" == "true" ]]; then
  echo "Load Discord Gateway adapter:"
  echo "launchctl bootstrap gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}.discord-gateway-adapter.plist\""
fi
if [[ "${REMODEX_ENABLE_DASHBOARD_SERVER:-false}" == "true" ]]; then
  echo "Load dashboard server:"
  echo "launchctl bootstrap gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}.dashboard-server.plist\""
fi
